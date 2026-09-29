import { existsSync } from "node:fs";
import { join } from "node:path";
import { WriteDictionary, writeEngineEndpoint } from "../write";
import type { MeetTranscriptStore } from "./transcript";

type Result = { text: string } | { error: string };
export class MeetTranscriber {
  private socket: WebSocket | null = null;
  private resolve: ((result: Result) => void) | null = null;
  private pumping = false;
  private closed = false;
  private readonly runtime = process.env.PI_STACK_WRITE_ENGINE_DEST || "/srv/pi/write-engine";
  constructor(private readonly store: MeetTranscriptStore) { store.recover(); this.wake(); }
  available() { return existsSync(join(this.runtime, "ready")); }

  private transcribe(id: string, audio: Uint8Array): Promise<Result> {
    if (!this.available()) return Promise.resolve({ error: "Run deploy/write-engine to install PiStack Write" });
    return new Promise(resolve => {
      const socket = new WebSocket(writeEngineEndpoint());
      this.socket = socket;
      let settled = false;
      let offset = 0;
      const timer = setTimeout(() => finish({ error: "Recognition exceeded 60 seconds; audio is retained for retry" }), 60_000);
      const finish = (result: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        this.resolve = null;
        socket.close();
        resolve(result);
      };
      this.resolve = finish;
      const sendNext = () => {
        if (socket.readyState !== WebSocket.OPEN || settled) return;
        if (offset < audio.byteLength) {
          const end = Math.min(offset + 6400, audio.byteLength);
          socket.send(audio.subarray(offset, end));
          offset = end;
        } else socket.send(JSON.stringify({ type: "finish" }));
      };
      socket.addEventListener("open", () => {
        if (settled) return;
        socket.send(JSON.stringify({ type: "start", dictation: id, dictionary: new WriteDictionary(this.store.db).get() }));
        sendNext();
      });
      socket.addEventListener("message", event => {
        try {
          const reply = JSON.parse(String(event.data)) as { type: string; raw?: string; text?: string; message?: string };
          if (reply.type === "partial") sendNext();
          else if (reply.type === "final" && typeof reply.raw === "string") finish({ text: reply.raw });
          else if (reply.type === "error") finish({ error: reply.message || "Write recognition failed" });
          else finish({ error: "Write recognizer returned invalid JSON" });
        } catch { finish({ error: "Write recognizer returned invalid JSON" }); }
      });
      socket.addEventListener("error", () => finish({ error: "Write recognizer connection failed" }));
      socket.addEventListener("close", () => finish({ error: "Write recognizer closed before final text" }));
    });
  }
  wake() { if (!this.pumping && !this.closed) void this.pump(); }
  private async pump() {
    this.pumping = true;
    try {
      for (;;) {
        if (this.closed) return;
        const next = this.store.pending();
        if (!next) return;
        this.store.processing(next.id);
        const result = await this.transcribe(next.id, next.audio);
        if (this.closed) return;
        this.store.finish(next.id, result);
      }
    } finally { this.pumping = false; }
  }
  close() {
    this.closed = true;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "cancel" }));
    this.resolve?.({ error: "Supervisor stopped; transcription will resume" });
    this.socket?.close(); this.socket = null;
    this.store.recover();
  }
}
