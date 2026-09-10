import type { MeetTranscriptTurn } from "../../../server/meet/protocol";
import { meetPath } from "../../../server/meet/protocol";
import type { MeetMediaSource } from "./media";
import { meetRequest, type MeetRoom, post } from "./room";

type Capture = { stream: MediaStream; source: MediaStreamAudioSourceNode; node: AudioWorkletNode };
export class MeetTranscription {
  private readonly audio = new AudioContext({ sampleRate: 16_000 });
  private readonly origin = Date.now() - this.audio.currentTime * 1000;
  private readonly captures = new Map<string, Capture>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly flushes = new Map<string, () => void>();
  private failure = "";
  private stopped = false;
  private readonly ready: Promise<void>;
  private voiceQueue = Promise.resolve();
  private readonly handedOff = new Map<string, string>();
  private readonly uploads = new Map<string, { path: string; init: RequestInit }>();
  constructor(private readonly room: MeetRoom, private readonly onError: (message: string) => void) {
    this.ready = Promise.all([this.audio.resume(), this.audio.audioWorklet.addModule("/meet-pcm.js")]).then(() => {});
  }
  private track(operation: Promise<unknown>) {
    const handled = operation.catch((cause) => { this.failure = String(cause.message || cause); this.onError(`Transcription: ${this.failure}`); });
    this.pending.add(handled);
    void handled.then(() => this.pending.delete(handled));
  }
  private async send(id: string, request: { path: string; init: RequestInit }) {
    this.uploads.set(id, request);
    await meetRequest(request.path, this.room.owner, request.init);
    if (this.uploads.get(id) === request) this.uploads.delete(id);
  }
  async retry() {
    this.failure = "";
    await Promise.all([...this.uploads].map(([id, request]) => this.send(id, request)));
    await meetRequest(this.room.path("/transcript/retry"), this.room.owner, post({}));
    if (this.stopped && this.audio.state !== "closed") {
      this.stopped = false;
      for (const capture of this.captures.values()) capture.source.connect(capture.node);
    }
  }
  attach(source: MeetMediaSource) {
    if (source.kind !== "camera" || !source.stream.getAudioTracks().length) return;
    const existing = this.captures.get(source.participant.id);
    if (existing?.stream === source.stream) return;
    if (existing) this.detach(source.participant.id);
    this.track(this.ready.then(() => {
      if (this.stopped || this.captures.has(source.participant.id)) return;
      const input = this.audio.createMediaStreamSource(source.stream);
      const node = new AudioWorkletNode(this.audio, "meet-pcm");
      input.connect(node); node.connect(this.audio.destination);
      this.captures.set(source.participant.id, { stream: source.stream, source: input, node });
      node.port.onmessage = ({ data }) => {
        if (data.flushed) { this.flushes.get(data.flushed)?.(); this.flushes.delete(data.flushed); }
        if (!data.audio) return;
        const id = crypto.randomUUID();
        this.track(this.send(id, { path: this.room.path("/transcript/audio", {
          speaker: source.participant.id, id, startedAt: String(Math.round(this.origin + data.startedAt * 1000)),
        }), init: { method: "POST", headers: { "content-type": "audio/pcm" }, body: data.audio } }));
      };
    }));
  }
  private flush(capture: Capture): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.flushes.delete(id); reject(new Error("Microphone capture did not acknowledge its unfinished utterance")); }, 2_000);
      this.flushes.set(id, () => { clearTimeout(timer); resolve(); });
      capture.node.port.postMessage({ flush: id });
    });
  }
  detach(id: string) {
    const capture = this.captures.get(id);
    if (!capture) return;
    this.captures.delete(id);
    this.track(this.flush(capture).finally(() => { capture.source.disconnect(); capture.node.disconnect(); }));
  }
  saveVoice(fragment: { id: string; text: string; voiceSessionId: string; startMs: number; endMs: number; startedAt: number }) {
    const send = () => this.send(fragment.id, { path: this.room.path("/transcript/assistant"), init: post({ ...fragment, final: true }) });
    this.voiceQueue = this.voiceQueue.then(send, send);
    this.track(this.voiceQueue);
  }
  async read(): Promise<MeetTranscriptTurn[]> {
    return (await meetRequest<{ turns: MeetTranscriptTurn[] }>(meetPath(this.room.snapshot.id, "/transcript"), this.room.owner)).turns;
  }
  async handoff(): Promise<{ text: string; commit(): void }> {
    await this.ready;
    await Promise.all([...this.captures.values()].map((capture) => this.flush(capture)));
    await Promise.all([...this.pending]);
    if (this.failure) throw new Error(`Transcript handoff stopped: ${this.failure}`);
    const included = new Set((await this.read()).map((turn) => turn.id));
    const deadline = Date.now() + 35_000;
    for (;;) {
      const turns = (await this.read()).filter((turn) => included.has(turn.id));
      const failed = turns.find((turn) => turn.status === "failed");
      if (failed) throw new Error(`Transcript handoff stopped: ${failed.speaker}: ${failed.error}`);
      if (!turns.some((turn) => turn.status === "queued" || turn.status === "processing")) {
        const changed = turns.filter((turn) => turn.text.trim() && this.handedOff.get(turn.id) !== turn.text);
        const lines = changed.map((turn) => {
          const previous = this.handedOff.get(turn.id);
          const continuation = previous && turn.text.startsWith(previous);
          const text = continuation ? turn.text.slice(previous.length).trim() : turn.text.trim();
          return `${turn.speaker}${continuation ? " continued" : previous ? " corrected" : ""}: ${text}`;
        });
        return {
          text: lines.length ? `Conversation since the last handoff:\n${lines.join("\n")}` : "No new meeting transcript since the last handoff.",
          commit: () => { for (const turn of changed) this.handedOff.set(turn.id, turn.text); },
        };
      }
      if (Date.now() > deadline) throw new Error("Transcript is still processing; the handoff has not been sent");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  async close() {
    if (this.audio.state === "closed") return;
    this.stopped = true;
    await this.ready;
    for (const capture of this.captures.values()) capture.source.disconnect();
    await Promise.all([...this.captures.values()].map((capture) => this.flush(capture)));
    await Promise.all([...this.pending]);
    if (this.failure || this.uploads.size) throw new Error(this.failure || "Audio is waiting for a save acknowledgement");
    for (const capture of this.captures.values()) capture.node.disconnect();
    this.captures.clear();
    await this.audio.close();
  }
}
