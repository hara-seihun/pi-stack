import callAudioWorklet from "./messaging-call-audio.worklet.js?raw";
import { openWebSocket } from "./websocket";

export const CALL_SAMPLE_RATE = 48_000;
export const CALL_FRAME_SAMPLES = 960;
export const CALL_FRAME_BYTES = CALL_FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;

export class PCMFrameEncoder {
  private carry = new Float32Array(CALL_FRAME_SAMPLES);
  private length = 0;

  push(samples: Float32Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let source = 0;
    while (source < samples.length) {
      const count = Math.min(CALL_FRAME_SAMPLES - this.length, samples.length - source);
      this.carry.set(samples.subarray(source, source + count), this.length);
      this.length += count;
      source += count;
      if (this.length !== CALL_FRAME_SAMPLES) continue;
      const frame = new Int16Array(CALL_FRAME_SAMPLES);
      for (let index = 0; index < frame.length; index++) {
        const sample = Math.max(-1, Math.min(1, this.carry[index]));
        frame[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      }
      frames.push(frame);
      this.length = 0;
    }
    return frames;
  }

  pendingSamples() { return this.length; }
}

export class FrameJitterBuffer<T> {
  private readonly frames = new Map<number, T>();
  private next: number | null = null;
  private playing = false;

  constructor(readonly targetDepth = 3) {
    if (!Number.isInteger(targetDepth) || targetDepth < 1) throw new Error("Jitter target depth must be a positive integer");
  }

  push(sequence: number, frame: T): boolean {
    if (!Number.isInteger(sequence) || sequence < 0 || (this.next !== null && sequence < this.next) || this.frames.has(sequence)) return false;
    this.frames.set(sequence, frame);
    return true;
  }

  pull(): T | null {
    if (!this.playing) {
      if (this.frames.size < this.targetDepth) return null;
      this.next = Math.min(...this.frames.keys());
      this.playing = true;
    }
    const sequence = this.next!;
    const frame = this.frames.get(sequence);
    if (frame !== undefined) {
      this.frames.delete(sequence);
      this.next = sequence + 1;
      return frame;
    }
    this.playing = false;
    return null;
  }

  get depth() { return this.frames.size; }
}

export class MessagingCallAudio {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private muted = false;
  private retry = 0;
  private receivedSequence = 0;

  constructor(private callId: string, private readonly onStatus: (message: string) => void) {}

  attachCall(callId: string) {
    this.callId = callId;
    if (this.node && !this.socket && !this.stopped) this.connect();
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable. Open PiStack Remote over HTTPS and allow microphone access.");
    const context = new AudioContext({ sampleRate: CALL_SAMPLE_RATE, latencyHint: "interactive" });
    this.context = context;
    if (context.sampleRate !== CALL_SAMPLE_RATE) {
      await context.close();
      this.context = null;
      throw new Error(`Calling needs 48 kHz audio; this browser opened ${context.sampleRate} Hz.`);
    }
    const moduleUrl = URL.createObjectURL(new Blob([callAudioWorklet], { type: "text/javascript" }));
    try {
      await Promise.all([context.resume(), context.audioWorklet.addModule(moduleUrl)]);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    if (this.stopped) { await context.close(); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, sampleRate: CALL_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }, video: false });
    if (this.stopped) { stream.getTracks().forEach(track => track.stop()); await context.close(); return; }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "signal-call-audio", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
      processorOptions: { frameSamples: CALL_FRAME_SAMPLES, targetFrames: 3 },
    });
    node.port.onmessage = ({ data }) => {
      if (!(data?.microphone instanceof ArrayBuffer) || data.microphone.byteLength !== CALL_FRAME_BYTES || this.muted) return;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data.microphone);
    };
    source.connect(node);
    node.connect(context.destination);
    this.stream = stream;
    this.source = source;
    this.node = node;
    if (this.callId) this.connect();
  }

  setMuted(muted: boolean) { this.muted = muted; }

  private connect() {
    if (this.stopped || !this.callId) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const socket = openWebSocket(`/v1/messaging/calls/${encodeURIComponent(this.callId)}/audio`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => { if (this.socket === socket) { this.retry = 0; this.onStatus(""); } };
    socket.onmessage = event => {
      if (this.socket !== socket || !(event.data instanceof ArrayBuffer) || event.data.byteLength !== CALL_FRAME_BYTES) return;
      this.node?.port.postMessage({ remote: event.data, sequence: this.receivedSequence++ }, [event.data]);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.onStatus("Audio reconnecting…");
      const delay = Math.min(3_000, 300 * 2 ** Math.min(this.retry++, 4));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Call audio stopped");
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.source = null; this.node = null; this.stream = null;
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
  }
}
