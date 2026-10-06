import { API } from "../../server/api";
import { api } from "./client";
import { toast } from "./toasts";
import { openWebSocket } from "./websocket";

const worklet = `class WriteCapture extends AudioWorkletProcessor {
  constructor() { super(); this.phase = 0; this.samples = []; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.samples.push(Math.max(-32768, Math.min(32767, Math.round(channel[i] * 32767))));
        if (this.samples.length === 320) {
          const bytes = new Int16Array(this.samples);
          this.port.postMessage(bytes.buffer, [bytes.buffer]);
          this.samples = [];
        }
      }
    }
    return true;
  }
}
registerProcessor('pi-write-capture', WriteCapture);`;

export interface WriteRecording {
  finish(): void;
  cancel(): void;
}

export async function startWrite(options: { context: string; partial(committed: string, tail: string): void; final(text: string): void; error(message: string): void }): Promise<WriteRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let context: AudioContext | undefined;
  let socket: WebSocket | undefined;
  let node: AudioWorkletNode | undefined;
  let ended = false;
  let finished = false;
  try {
    context = new AudioContext();
    const module = URL.createObjectURL(new Blob([worklet], { type: "text/javascript" }));
    try { await context.audioWorklet.addModule(module); } finally { URL.revokeObjectURL(module); }
    node = new AudioWorkletNode(context, "pi-write-capture");
    const source = context.createMediaStreamSource(stream);
    source.connect(node);
    // Worklets process only while attached to the graph. Zero gain keeps the
    // local microphone out of speakers without stopping the processing graph.
    const mute = context.createGain(); mute.gain.value = 0;
    node.connect(mute).connect(context.destination);
    socket = openWebSocket(API.writeStream.path());
    const peer = socket;
    const cleanup = () => {
      stream.getTracks().forEach(track => track.stop());
      node?.disconnect(); source.disconnect(); mute.disconnect();
      void context?.close();
    };
    peer.addEventListener("open", () => {
      peer.send(JSON.stringify({ type: "start", dictation: crypto.randomUUID(), context: options.context.slice(-2000) }));
      if (finished) peer.send(JSON.stringify({ type: "finish" }));
    });
    node.port.onmessage = event => { if (peer.readyState === WebSocket.OPEN && !ended && peer.bufferedAmount < 64 * 1024) peer.send(event.data); };
    peer.addEventListener("message", event => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "partial") options.partial(String(frame.committed ?? ""), String(frame.tail ?? ""));
        else if (frame.type === "final") {
          if (frame.rewrite?.status === "unavailable") {
            if (frame.rewrite.reason === "warming") toast("Local rewrite is warming up; inserted the transcript.");
            else toast.error("Local rewrite unavailable; inserted the transcript.");
          }
          else if (frame.rewrite?.status === "guarded") toast("Kept the original wording to avoid changing its meaning.");
          options.final(String(frame.text ?? "")); ended = true; cleanup();
        }
        else if (frame.type === "error") { options.error(String(frame.message ?? "Write failed")); ended = true; cleanup(); }
      } catch { options.error("Write returned an invalid response"); ended = true; cleanup(); }
    });
    peer.addEventListener("close", () => { cleanup(); if (!ended) options.error(finished ? "Write closed before returning final text" : "Write connection closed"); ended = true; });
    peer.addEventListener("error", () => { if (!ended) options.error("Write connection failed"); ended = true; cleanup(); });
    return {
      finish() { if (ended || finished) return; finished = true; stream.getTracks().forEach(track => track.stop()); if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "finish" })); },
      cancel() { if (ended) return; ended = true; if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "cancel" })); peer.close(); cleanup(); },
    };
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    void context?.close();
    socket?.close();
    throw error;
  }
}

export async function learnWrite(inserted: string, final: string) {
  if (inserted === final) return;
  try {
    const result = await api(API.writeLearn.method, API.writeLearn.path(), { inserted, final });
    const learned = [...(result.words ?? []), ...(result.replacements ?? []).map((rule: { from: string; to: string }) => `${rule.from} → ${rule.to}`)];
    if (learned.length) toast(`Added ‘${learned.join(", ")}’ to your dictionary`, {
      action: { label: "Undo", onClick: () => { if (result.undoId) void api(API.writeUndo.method, API.writeUndo.path(), { undoId: result.undoId }).catch(error => toast.error(`Could not undo: ${error}`)); } },
    });
  } catch (error) { toast.error(`Could not learn correction: ${error instanceof Error ? error.message : error}`); }
}
