import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelBrokerUrl } from "pi-orchestrator/api";
import type { MeetTranscriptStore } from "./transcript";

export function recognitionEndpoint(): string {
  const broker = modelBrokerUrl();
  return broker ? `${broker.replace(/^http/, "ws").replace(/\/$/, "")}/v1/meet/recognition`
    : process.env.PI_STACK_MEET_RECOGNITION_URL ?? "ws://127.0.0.1:8797/";
}

type Result = { text: string } | { error: string };
export class MeetTranscriber {
  private socket: WebSocket | null = null;
  private resolve: ((result: Result) => void) | null = null;
  private pumping = false;
  private closed = false;
  private readonly runtime = process.env.PI_STACK_MEET_RECOGNITION_DEST || "/srv/pi/meet-recognition";
  constructor(private readonly store: MeetTranscriptStore) { store.recover(); this.wake(); }
  available() { return existsSync(join(this.runtime, "ready")); }

  private transcribe(id: string, audio: Uint8Array): Promise<Result> {
    if (!this.available()) return Promise.resolve({ error: "Run deploy/meet-recognition to install local meeting recognition" });
    return new Promise(resolve => {
      const socket = new WebSocket(recognitionEndpoint());
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
        socket.send(JSON.stringify({ type: "start", turn: id }));
        sendNext();
      });
      socket.addEventListener("message", event => {
        try {
          const reply = JSON.parse(String(event.data)) as { type: string; text?: string; message?: string };
          if (reply.type === "partial") sendNext();
          else if (reply.type === "final" && typeof reply.text === "string") finish({ text: reply.text });
          else if (reply.type === "error") finish({ error: reply.message || "Meeting recognition failed" });
          else finish({ error: "Meeting recognizer returned invalid JSON" });
        } catch { finish({ error: "Meeting recognizer returned invalid JSON" }); }
      });
      socket.addEventListener("error", () => finish({ error: "Meeting recognizer connection failed" }));
      socket.addEventListener("close", () => finish({ error: "Meeting recognizer closed before final text" }));
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
