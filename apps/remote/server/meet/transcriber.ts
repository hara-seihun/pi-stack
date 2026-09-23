import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { MeetTranscriptStore } from "./transcript";

type Result = { text: string } | { error: string };
export class MeetTranscriber {
  private child: ChildProcessWithoutNullStreams | null = null;
  private resolve: ((result: Result) => void) | null = null;
  private activeId = "";
  private pumping = false;
  private closed = false;
  private readonly runtime = process.env.PI_STACK_TRANSCRIPTION_DEST || "/srv/pi/transcription";
  constructor(private readonly store: MeetTranscriptStore) { store.recover(); this.wake(); }
  available() { return existsSync(join(this.runtime, "ready")); }
  private start() {
    if (this.child) return;
    const child = spawn(join(this.runtime, "venv/bin/python"), [join(import.meta.dir, "asr/worker.py"), join(this.runtime, "model")], { stdio: "pipe" });
    this.child = child;
    let diagnostic = "";
    child.stderr.on("data", (bytes) => { diagnostic = (diagnostic + String(bytes)).slice(-2000); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready || this.child !== child || value.id !== this.activeId) return;
        this.resolve?.(typeof value.text === "string" ? { text: value.text } : { error: value.error || "ASR returned no transcript" });
      } catch { this.resolve?.({ error: "ASR returned invalid JSON" }); }
    });
    child.on("error", (cause) => {
      if (this.child !== child) return;
      this.child = null;
      this.resolve?.({ error: `ASR could not start: ${cause.message}` });
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.resolve?.({ error: `ASR exited (${code}): ${diagnostic}` });
    });
  }
  private transcribe(id: string, audio: Uint8Array): Promise<Result> {
    if (!this.available()) return Promise.resolve({ error: "Run deploy/transcription to install PiStack's recognizer" });
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        const child = this.child; this.child = null; child?.kill("SIGKILL");
        finish({ error: "Transcription exceeded 30 seconds; its audio is retained for retry" });
      }, 30_000);
      const finish = (result: Result) => { if (settled) return; settled = true; clearTimeout(timer); this.resolve = null; resolve(result); };
      this.resolve = finish;
      this.activeId = id;
      this.start();
      this.child!.stdin.write(JSON.stringify({ id, audio: Buffer.from(audio).toString("base64") }) + "\n", (cause) => {
        if (cause) finish({ error: `ASR input failed: ${cause.message}` });
      });
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
    this.resolve?.({ error: "Supervisor stopped; transcription will resume" });
    this.child?.kill("SIGKILL"); this.child = null;
    this.store.recover();
  }
}
