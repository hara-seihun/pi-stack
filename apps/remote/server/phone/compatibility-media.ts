export type CompatibilityMediaKind = "signalwire" | "twilio";
export type CompatibilityMediaError =
  | "invalid-json" | "message-too-large" | "invalid-message" | "unsupported-event"
  | "invalid-state" | "session-closed" | "unsupported-protocol" | "unsupported-codec"
  | "identity-mismatch" | "invalid-sequence" | "invalid-media" | "invalid-pcm";
export type CompatibilityMediaResult<T> = { ok: true; value: T } | { ok: false; error: CompatibilityMediaError };
export type CompatibilityMediaMessage = { event: "media"; streamSid: string; media: { payload: string } };
export type CompatibilityClearMessage = { event: "clear"; streamSid: string };
export type CompatibilityMediaEvent =
  | { event: "connected" }
  | { event: "start"; callSid: string; streamSid: string }
  | { event: "media"; pcm: Buffer[] }
  | { event: "stop" }
  | { event: "dtmf"; digit: string; duration: number | null }
  | { event: "mark"; name: string };

export const MAX_COMPATIBILITY_MESSAGE_BYTES = 16_384;
export const MAX_MULAW_PACKET_BYTES = 1_600;
export const MAX_VOICE_PACKET_BYTES = 6_400;
export const VOICE_FRAME_BYTES = 640;
export const MULAW_FRAME_BYTES = 160;

export function decodeMuLawSample(byte: number): number {
  const code = (~byte) & 255;
  const magnitude = (((code & 15) << 3) + 132) << ((code >> 4) & 7);
  return code & 128 ? 132 - magnitude : magnitude - 132;
}

export function encodeMuLawSample(sample: number): number {
  const mask = sample < 0 ? 127 : 255;
  const magnitude = Math.min(32635, Math.abs(sample)) + 132;
  let segment = 0;
  while (segment < 7 && magnitude > ((256 << segment) - 1)) segment++;
  return ((segment << 4) | ((magnitude >> (segment + 3)) & 15)) ^ mask;
}

// A 63-tap Hamming-windowed low-pass at 3.6 kHz. Both directions preserve
// history across packets; upsampling inserts zeros and applies a gain of two.
const FILTER = (() => {
  const taps = Array.from({ length: 63 }, (_, i) => {
    const x = i - 31;
    return (x === 0 ? 0.45 : Math.sin(0.45 * Math.PI * x) / (Math.PI * x))
      * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / 62));
  });
  const sum = taps.reduce((a, b) => a + b, 0);
  return Float64Array.from(taps, x => x / sum);
})();

class LowPass {
  private history = new Float64Array(FILTER.length);
  private cursor = 0;
  push(sample: number): number {
    this.history[this.cursor] = sample;
    let value = 0;
    for (let i = 0; i < FILTER.length; i++) value += FILTER[i] * this.history[(this.cursor - i + FILTER.length) % FILTER.length];
    this.cursor = (this.cursor + 1) % FILTER.length;
    return Math.max(-32768, Math.min(32767, Math.round(value)));
  }
}

class StreamAudio {
  private inputFilter = new LowPass();
  private outputFilter = new LowPass();
  private inputRemainder = Buffer.alloc(0);
  private outputRemainder = Buffer.alloc(0);
  private downsamplePhase = 0;

  incoming(mulaw: Buffer): Buffer[] {
    const pcm = Buffer.alloc(mulaw.length * 4);
    for (let i = 0; i < mulaw.length; i++) {
      pcm.writeInt16LE(this.inputFilter.push(2 * decodeMuLawSample(mulaw[i])), i * 4);
      pcm.writeInt16LE(this.inputFilter.push(0), i * 4 + 2);
    }
    const joined = Buffer.concat([this.inputRemainder, pcm]);
    const complete = joined.length - joined.length % VOICE_FRAME_BYTES;
    this.inputRemainder = Buffer.from(joined.subarray(complete));
    const frames: Buffer[] = [];
    for (let i = 0; i < complete; i += VOICE_FRAME_BYTES) frames.push(joined.subarray(i, i + VOICE_FRAME_BYTES));
    return frames;
  }

  outgoing(pcm: Buffer): Buffer[] {
    const mulaw = Buffer.alloc(Math.floor((pcm.length / 2 + this.downsamplePhase) / 2));
    let count = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = this.outputFilter.push(pcm.readInt16LE(i));
      this.downsamplePhase ^= 1;
      if (this.downsamplePhase === 0) mulaw[count++] = encodeMuLawSample(sample);
    }
    const joined = Buffer.concat([this.outputRemainder, mulaw]);
    const complete = joined.length - joined.length % MULAW_FRAME_BYTES;
    this.outputRemainder = Buffer.from(joined.subarray(complete));
    const frames: Buffer[] = [];
    for (let i = 0; i < complete; i += MULAW_FRAME_BYTES) frames.push(joined.subarray(i, i + MULAW_FRAME_BYTES));
    return frames;
  }

  clearOutput(): void {
    this.outputFilter = new LowPass();
    this.outputRemainder = Buffer.alloc(0);
    this.downsamplePhase = 0;
  }
}

type Active = { state: "active"; callSid: string; streamSid: string; sequence: number; chunk: number; timestamp: number; audio: StreamAudio };
type Session = { state: "awaiting-connected" } | { state: "awaiting-start" } | Active | { state: "closed" };
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const counter = (value: unknown): number | null => typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const success = <T>(value: T): CompatibilityMediaResult<T> => ({ ok: true, value });
const failure = (error: CompatibilityMediaError): CompatibilityMediaResult<never> => ({ ok: false, error });

function payload(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_MULAW_PACKET_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.length <= MAX_MULAW_PACKET_BYTES && decoded.toString("base64") === value ? decoded : null;
}

export class CompatibilityMediaSession {
  private session: Session = { state: "awaiting-connected" };
  constructor(
    private readonly kind: CompatibilityMediaKind,
    private readonly expectedCallSid: string | null,
    private readonly expectedAccountSid: string,
  ) {}

  receive(raw: unknown): CompatibilityMediaResult<CompatibilityMediaEvent> {
    if (this.session.state === "closed") return failure("session-closed");
    if (typeof raw !== "string") return this.reject("invalid-message");
    if (Buffer.byteLength(raw, "utf8") > MAX_COMPATIBILITY_MESSAGE_BYTES) return this.reject("message-too-large");
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return this.reject("invalid-json"); }
    if (!object(message) || typeof message.event !== "string") return this.reject("invalid-message");
    if (message.event === "connected") {
      if (this.session.state !== "awaiting-connected") return this.reject("invalid-state");
      const version = this.kind === "signalwire" ? "0.2.0" : "1.0.0";
      if (message.protocol !== "Call" || message.version !== version) return this.reject("unsupported-protocol");
      this.session = { state: "awaiting-start" };
      return success({ event: "connected" });
    }
    if (message.event === "start") {
      if (this.session.state !== "awaiting-start") return this.reject("invalid-state");
      const start = message.start;
      if (!object(start) || !identifier(start.callSid) || !identifier(start.streamSid) || !identifier(start.accountSid)) return this.reject("invalid-message");
      if (this.kind === "twilio" && !identifier(message.streamSid)) return this.reject("invalid-message");
      if (start.accountSid !== this.expectedAccountSid
        || (message.accountSid !== undefined && message.accountSid !== this.expectedAccountSid)
        || (this.expectedCallSid !== null && start.callSid !== this.expectedCallSid)
        || (message.streamSid !== undefined && message.streamSid !== start.streamSid)
        || (message.callSid !== undefined && message.callSid !== start.callSid)) return this.reject("identity-mismatch");
      if (!Array.isArray(start.tracks) || start.tracks.length !== 1 || start.tracks[0] !== "inbound") return this.reject("unsupported-codec");
      const format = start.mediaFormat;
      if (!object(format) || format.encoding !== "audio/x-mulaw" || format.sampleRate !== 8000 || format.channels !== 1) return this.reject("unsupported-codec");
      if (counter(message.sequenceNumber) !== 1) return this.reject("invalid-sequence");
      this.session = { state: "active", callSid: start.callSid, streamSid: start.streamSid, sequence: 1, chunk: 0, timestamp: 0, audio: new StreamAudio() };
      return success({ event: "start", callSid: start.callSid, streamSid: start.streamSid });
    }
    if (this.session.state !== "active") return this.reject("invalid-state");
    const session = this.session;
    if (this.kind === "twilio" && !identifier(message.streamSid)) return this.reject("invalid-message");
    if ((message.streamSid !== undefined && message.streamSid !== session.streamSid)
      || (message.callSid !== undefined && message.callSid !== session.callSid)
      || (message.accountSid !== undefined && message.accountSid !== this.expectedAccountSid)) return this.reject("identity-mismatch");
    const sequence = counter(message.sequenceNumber);
    // Only SignalWire's mark acknowledgements may omit sequenceNumber.
    if (!(this.kind === "signalwire" && message.event === "mark" && message.sequenceNumber === undefined)) {
      if (sequence === null || sequence <= session.sequence) return this.reject("invalid-sequence");
    }
    switch (message.event) {
      case "media": {
        const media = message.media;
        if (!object(media) || media.track !== "inbound") return this.reject("invalid-media");
        const chunk = counter(media.chunk), timestamp = counter(media.timestamp), bytes = payload(media.payload);
        if (chunk !== session.chunk + 1 || timestamp === null || timestamp < session.timestamp || bytes === null) return this.reject("invalid-media");
        session.chunk = chunk; session.timestamp = timestamp; session.sequence = sequence!;
        return success({ event: "media", pcm: session.audio.incoming(bytes) });
      }
      case "stop": {
        const stop = message.stop;
        if (this.kind === "twilio" && (!object(stop) || !identifier(stop.accountSid) || !identifier(stop.callSid))) return this.reject("invalid-message");
        if (stop !== undefined) {
          if (!object(stop)) return this.reject("invalid-message");
          if ((stop.callSid !== undefined && stop.callSid !== session.callSid)
            || (stop.accountSid !== undefined && stop.accountSid !== this.expectedAccountSid)
            || (stop.streamSid !== undefined && stop.streamSid !== session.streamSid)) return this.reject("identity-mismatch");
        }
        this.close();
        return success({ event: "stop" });
      }
      case "dtmf": {
        const dtmf = message.dtmf;
        if (!object(dtmf) || typeof dtmf.digit !== "string" || !/^[0-9*#A-D]$/.test(dtmf.digit)) return this.reject("invalid-message");
        if (this.kind === "twilio") {
          if (dtmf.track !== "inbound_track" || dtmf.duration !== undefined) return this.reject("invalid-message");
          session.sequence = sequence!;
          return success({ event: "dtmf", digit: dtmf.digit, duration: null });
        }
        if (dtmf.track !== undefined || typeof dtmf.duration !== "number" || !Number.isSafeInteger(dtmf.duration) || dtmf.duration < 0) return this.reject("invalid-message");
        session.sequence = sequence!;
        return success({ event: "dtmf", digit: dtmf.digit, duration: dtmf.duration });
      }
      case "mark": {
        const mark = message.mark;
        if (!object(mark) || typeof mark.name !== "string" || mark.name.length === 0 || mark.name.length > 128) return this.reject("invalid-message");
        if (sequence !== null) session.sequence = sequence;
        return success({ event: "mark", name: mark.name });
      }
      default: return this.reject("unsupported-event");
    }
  }

  outgoing(pcm: Buffer): CompatibilityMediaResult<CompatibilityMediaMessage[]> {
    if (this.session.state !== "active") return failure(this.session.state === "closed" ? "session-closed" : "invalid-state");
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > MAX_VOICE_PACKET_BYTES || pcm.length % 2 !== 0) return failure("invalid-pcm");
    const { streamSid, audio } = this.session;
    return success(audio.outgoing(pcm).map(frame => ({ event: "media", streamSid, media: { payload: frame.toString("base64") } })));
  }

  clear(): CompatibilityMediaResult<CompatibilityClearMessage> {
    if (this.session.state !== "active") return failure(this.session.state === "closed" ? "session-closed" : "invalid-state");
    this.session.audio.clearOutput();
    return success({ event: "clear", streamSid: this.session.streamSid });
  }

  close(): void { this.session = { state: "closed" }; }
  private reject(error: CompatibilityMediaError): CompatibilityMediaResult<never> { this.close(); return failure(error); }
}
