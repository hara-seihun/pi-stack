import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CompatibilityMediaSession, encodeMuLawSample, decodeMuLawSample,
  MAX_COMPATIBILITY_MESSAGE_BYTES, MAX_MULAW_PACKET_BYTES, MAX_VOICE_PACKET_BYTES,
  type CompatibilityMediaResult, type CompatibilityMediaMessage,
} from "./compatibility-media";

const accountSid = "b08dacad-2f6c-4de1-93d6-cc732e0c69c5";
const callSid = "76ac3c36-56da-4a3e-a0d6-b5f8df6da9ad";
const streamSid = "7d56cc11-536d-4a45-b4fb-ed3d55be843b";
const connected = { event: "connected", protocol: "Call", version: "0.2.0" };
const start = {
  event: "start", sequenceNumber: "1",
  start: { callSid, streamSid, accountSid, tracks: ["inbound"],
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
};
function value<T>(result: CompatibilityMediaResult<T>): T {
  if (!result.ok) assert.fail(result.error);
  return result.value;
}
function error<T>(result: CompatibilityMediaResult<T>, expected: string) {
  assert.deepEqual(result, { ok: false, error: expected });
}
function active(expectedCallSid: string | null = callSid) {
  const session = new CompatibilityMediaSession("signalwire", expectedCallSid, accountSid);
  assert.deepEqual(value(session.receive(JSON.stringify(connected))), { event: "connected" });
  assert.deepEqual(value(session.receive(JSON.stringify(start))), { event: "start", callSid, streamSid });
  return session;
}
function media(bytes: Buffer, chunk: number, timestamp: number, sequence = chunk + 1) {
  return JSON.stringify({ event: "media", sequenceNumber: String(sequence), media: {
    track: "inbound", chunk: String(chunk), timestamp: String(timestamp), payload: bytes.toString("base64"),
  } });
}
function pcm(samples: number[]) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2));
  return buffer;
}
function samples(bytes: Buffer) {
  return Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2));
}
function outputBytes(messages: CompatibilityMediaMessage[]) {
  for (const message of messages) {
    assert.equal(message.event, "media"); assert.equal(message.streamSid, streamSid);
    assert.equal(Buffer.from(message.media.payload, "base64").length, 160);
    assert.deepEqual(Object.keys(message).sort(), ["event", "media", "streamSid"]);
  }
  return Buffer.concat(messages.map(message => Buffer.from(message.media.payload, "base64")));
}
function rms(values: number[]) { return Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length); }
function tone(rate: number, frequency: number, seconds: number) {
  return Array.from({ length: rate * seconds }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * frequency * i / rate)));
}

// Fixed G.711 PCMU sign, bias, segment-boundary and saturation vectors, not
// a round-trip oracle: encoder and decoder cannot hide the same mistake.
test("G.711 decoder matches known codewords, including both zero signs and extrema", () => {
  const codes = [0xff, 0x7f, 0xfe, 0x7e, 0xf0, 0x70, 0xef, 0x6f, 0xe0, 0x60,
    0xdf, 0x5f, 0xd0, 0x50, 0xcf, 0x4f, 0xc0, 0x40, 0xbf, 0x3f, 0xb0, 0x30,
    0xaf, 0x2f, 0xa0, 0x20, 0x9f, 0x1f, 0x90, 0x10, 0x8f, 0x0f, 0x80, 0x00];
  assert.deepEqual(codes.map(decodeMuLawSample), [0, 0, 8, -8, 120, -120, 132, -132, 372, -372,
    396, -396, 876, -876, 924, -924, 1884, -1884, 1980, -1980, 3900, -3900,
    4092, -4092, 7932, -7932, 8316, -8316, 15996, -15996, 16764, -16764, 32124, -32124]);
});

test("G.711 encoder matches independent segment-edge and clipping vectors", () => {
  const input = [0, 1, -1, 8, -8, 16, -16, 123, -123, 124, -124, 379, -379, 380, -380,
    892, -892, 1916, -1916, 3964, -3964, 8060, -8060, 16252, -16252, 32635, -32635, 32767, -32768];
  assert.deepEqual(input.map(encodeMuLawSample), [0xff, 0xff, 0x7f, 0xfe, 0x7e, 0xfd, 0x7d,
    0xf0, 0x70, 0xef, 0x6f, 0xe0, 0x60, 0xdf, 0x5f, 0xcf, 0x4f, 0xbf, 0x3f,
    0xaf, 0x2f, 0x9f, 0x1f, 0x8f, 0x0f, 0x80, 0x00, 0x80, 0x00]);
});

test("documented messages bind one stream; identity-less media/stop remain socket-scoped", () => {
  const session = active(null);
  const event = value(session.receive(media(Buffer.alloc(160, 255), 1, 0)));
  assert.equal(event.event, "media");
  if (event.event !== "media") assert.fail();
  assert.equal(event.pcm.length, 1); assert.equal(event.pcm[0].length, 640);
  assert.ok(event.pcm[0].every(byte => byte === 0));
  assert.deepEqual(value(session.receive('{"event":"stop","sequenceNumber":"3"}')), { event: "stop" });
  error(session.receive(JSON.stringify(start)), "session-closed");
  error(session.outgoing(Buffer.alloc(640)), "session-closed");
  error(session.clear(), "session-closed");
});

test("ordered handshake is mandatory and invalid or duplicate starts are terminal", () => {
  error(new CompatibilityMediaSession("signalwire", callSid, accountSid).receive(JSON.stringify(start)), "invalid-state");
  error(active().receive(JSON.stringify(start)), "invalid-state");
  const session = new CompatibilityMediaSession("signalwire", callSid, accountSid);
  error(session.receive(JSON.stringify({ ...connected, version: "unknown" })), "unsupported-protocol");
  error(session.receive(JSON.stringify(connected)), "session-closed");
  const repeated = new CompatibilityMediaSession("signalwire", callSid, accountSid);
  value(repeated.receive(JSON.stringify(connected)));
  error(repeated.receive(JSON.stringify(connected)), "invalid-state");
});

test("codec, track, identity and initial sequence are validated before audio starts", () => {
  const invalid: readonly (readonly [unknown, string])[] = [
    [{ ...start, start: { ...start.start, callSid: "other-call" } }, "identity-mismatch"],
    [{ ...start, start: { ...start.start, accountSid: "other-account" } }, "identity-mismatch"],
    [{ ...start, streamSid: "other-stream" }, "identity-mismatch"],
    [{ ...start, start: { ...start.start, streamSid: "" } }, "invalid-message"],
    [{ ...start, start: { ...start.start, tracks: ["inbound", "outbound"] } }, "unsupported-codec"],
    ...[{ encoding: "audio/x-L16", sampleRate: 8000, channels: 1 },
      { encoding: "audio/x-mulaw", sampleRate: 16000, channels: 1 },
      { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 2 }].map(mediaFormat =>
      [{ ...start, start: { ...start.start, mediaFormat } }, "unsupported-codec"] as const),
    [{ ...start, sequenceNumber: "2" }, "invalid-sequence"],
  ] as const;
  for (const [message, expected] of invalid) {
    const session = new CompatibilityMediaSession("signalwire", callSid, accountSid);
    value(session.receive(JSON.stringify(connected)));
    error(session.receive(JSON.stringify(message)), expected);
    error(session.receive(JSON.stringify(start)), "session-closed");
  }
});

test("malformed external JSON, binary, oversized and unknown packets return errors without throws", () => {
  for (const [raw, expected] of [["{", "invalid-json"], ["null", "invalid-message"], ["[]", "invalid-message"],
    [Buffer.alloc(160), "invalid-message"], [{}, "invalid-message"], ["x".repeat(MAX_COMPATIBILITY_MESSAGE_BYTES + 1), "message-too-large"],
    [JSON.stringify({ event: "unknown", sequenceNumber: "2" }), "unsupported-event"]] as const) {
    const session = active();
    error(session.receive(raw), expected);
    error(session.receive(media(Buffer.alloc(160), 1, 0)), "session-closed");
  }
});

test("payload requires nonempty bounded canonical base64, never Node's permissive decoding", () => {
  for (const bad of ["", "Zg", "Zg=", "Zh==", "Zg==\n", "!!!!", "____", 123, null,
    Buffer.alloc(MAX_MULAW_PACKET_BYTES + 1).toString("base64")]) {
    const packet = JSON.parse(media(Buffer.alloc(160), 1, 0)); packet.media.payload = bad;
    error(active().receive(JSON.stringify(packet)), "invalid-media");
  }
  const session = active();
  const event = value(session.receive(media(Buffer.alloc(MAX_MULAW_PACKET_BYTES, 255), 1, 0)));
  assert.equal(event.event, "media");
  if (event.event !== "media") assert.fail();
  assert.equal(event.pcm.length, 10);
});

test("active session rejects other stream/call identities, including nested stop identity", () => {
  const packet = JSON.parse(media(Buffer.alloc(160), 1, 0));
  for (const message of [{ ...packet, streamSid: "other-stream" }, { ...packet, callSid: "other-call" },
    { event: "stop", sequenceNumber: "2", stop: { callSid: "other-call" } },
    { event: "stop", sequenceNumber: "2", stop: { accountSid: "other-account" } },
    { event: "stop", sequenceNumber: "2", stop: { streamSid: "other-stream" } }]) {
    error(active().receive(JSON.stringify(message)), "identity-mismatch");
  }
});

test("media rejects duplicate/reordered sequence, skipped chunks and regressing timestamps", () => {
  for (const bad of [media(Buffer.alloc(160), 2, 20, 2), media(Buffer.alloc(160), 1, 20, 3),
    media(Buffer.alloc(160), 3, 20, 3), media(Buffer.alloc(160), 2, 9, 3)]) {
    const session = active(); value(session.receive(media(Buffer.alloc(160), 1, 10, 2)));
    assert.equal(session.receive(bad).ok, false);
  }
  for (const sequence of [2, "02", "2.0", "-1", "9007199254740992"]) {
    const packet = JSON.parse(media(Buffer.alloc(160), 1, 0)); packet.sequenceNumber = sequence;
    error(active().receive(JSON.stringify(packet)), "invalid-sequence");
  }
});

test("DTMF and unsequenced mark acknowledgements preserve audio session ordering", () => {
  const session = active();
  assert.deepEqual(value(session.receive(JSON.stringify({ event: "dtmf", sequenceNumber: "2", streamSid, dtmf: { digit: "#", duration: 200 } }))),
    { event: "dtmf", digit: "#", duration: 200 });
  assert.deepEqual(value(session.receive(JSON.stringify({ event: "mark", streamSid, mark: { name: "done" } }))), { event: "mark", name: "done" });
  assert.equal(value(session.receive(media(Buffer.alloc(160), 1, 0, 3))).event, "media");
});

const twilioAccountSid = "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const twilioCallSid = "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const twilioStreamSid = "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const twilioConnected = { event: "connected", protocol: "Call", version: "1.0.0" };
const twilioStart = {
  event: "start", sequenceNumber: "1",
  start: {
    accountSid: twilioAccountSid, streamSid: twilioStreamSid, callSid: twilioCallSid,
    tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    customParameters: { FirstName: "Jane", LastName: "Doe", RemoteParty: "Bob" },
  },
  streamSid: twilioStreamSid,
};
function twilioActive(expectedCallSid: string | null = twilioCallSid) {
  const session = new CompatibilityMediaSession("twilio", expectedCallSid, twilioAccountSid);
  assert.deepEqual(value(session.receive(JSON.stringify(twilioConnected))), { event: "connected" });
  assert.deepEqual(value(session.receive(JSON.stringify(twilioStart))), { event: "start", callSid: twilioCallSid, streamSid: twilioStreamSid });
  return session;
}
function twilioMedia(bytes: Buffer, chunk: number, timestamp: number, sequence = chunk + 1) {
  return { ...JSON.parse(media(bytes, chunk, timestamp, sequence)), streamSid: twilioStreamSid };
}
const twilioStop = {
  event: "stop", sequenceNumber: "2", streamSid: twilioStreamSid,
  stop: { accountSid: twilioAccountSid, callSid: twilioCallSid },
};

// Twilio WebSocket Messages documentation, with complete rather than abbreviated audio payloads.
test("documented Twilio start/media/DTMF/mark/stop sequence uses the shared duplex codec", () => {
  const session = twilioActive(null);
  const wire = Buffer.from(tone(8000, 1000, 0.02).map(encodeMuLawSample));
  const incoming = value(session.receive(JSON.stringify(twilioMedia(wire, 1, 5))));
  const reference = active();
  assert.deepEqual(incoming, value(reference.receive(media(wire, 1, 5))));
  if (incoming.event !== "media") assert.fail();
  assert.equal(incoming.pcm.length, 1);
  assert.equal(incoming.pcm[0].length, 640);
  const outgoing = value(session.outgoing(incoming.pcm[0]));
  assert.deepEqual(outgoing, value(reference.outgoing(incoming.pcm[0])).map(packet => ({ ...packet, streamSid: twilioStreamSid })));
  assert.deepEqual(value(session.clear()), { event: "clear", streamSid: twilioStreamSid });
  assert.deepEqual(value(session.receive(JSON.stringify({
    event: "dtmf", streamSid: twilioStreamSid, sequenceNumber: "3", dtmf: { track: "inbound_track", digit: "1" },
  }))), { event: "dtmf", digit: "1", duration: null });
  assert.deepEqual(value(session.receive(JSON.stringify({
    event: "mark", streamSid: twilioStreamSid, sequenceNumber: "4", mark: { name: "my label" },
  }))), { event: "mark", name: "my label" });
  assert.deepEqual(value(session.receive(JSON.stringify({ ...twilioStop, sequenceNumber: "5" }))), { event: "stop" });
  error(session.receive(JSON.stringify(twilioStart)), "session-closed");
  error(session.outgoing(Buffer.alloc(640)), "session-closed");
  error(session.clear(), "session-closed");
});

test("the explicit dialect rejects the other protocol and unsupported Call versions", () => {
  for (const [kind, wrong] of [["signalwire", twilioConnected], ["twilio", connected]] as const) {
    const session = new CompatibilityMediaSession(kind, null, accountSid);
    error(session.receive(JSON.stringify(wrong)), "unsupported-protocol");
    error(session.receive(JSON.stringify(connected)), "session-closed");
  }
  for (const packet of [{ ...twilioConnected, version: "1.0.1" }, { ...twilioConnected, protocol: "Other" }]) {
    error(new CompatibilityMediaSession("twilio", twilioCallSid, twilioAccountSid).receive(JSON.stringify(packet)), "unsupported-protocol");
  }
});

test("Twilio binds account, optional expected call and envelope stream before opening audio", () => {
  for (const [packet, expected] of [
    [{ ...twilioStart, start: { ...twilioStart.start, accountSid: "other-account" } }, "identity-mismatch"],
    [{ ...twilioStart, start: { ...twilioStart.start, accountSid: "" } }, "invalid-message"],
    [{ ...twilioStart, start: { ...twilioStart.start, callSid: "other-call" } }, "identity-mismatch"],
    [{ ...twilioStart, streamSid: "other-stream" }, "identity-mismatch"],
    [{ ...twilioStart, streamSid: undefined }, "invalid-message"],
    [{ ...twilioStart, sequenceNumber: "2" }, "invalid-sequence"],
    [{ ...twilioStart, start: { ...twilioStart.start, tracks: ["outbound"] } }, "unsupported-codec"],
    [{ ...twilioStart, start: { ...twilioStart.start, mediaFormat: { ...twilioStart.start.mediaFormat, sampleRate: 16000 } } }, "unsupported-codec"],
  ] as const) {
    const session = new CompatibilityMediaSession("twilio", twilioCallSid, twilioAccountSid);
    value(session.receive(JSON.stringify(twilioConnected)));
    error(session.receive(JSON.stringify(packet)), expected);
    error(session.receive(JSON.stringify(twilioStart)), "session-closed");
  }
  const session = new CompatibilityMediaSession("twilio", null, twilioAccountSid);
  value(session.receive(JSON.stringify(twilioConnected)));
  error(session.receive(JSON.stringify({ ...twilioStart, start: { ...twilioStart.start, accountSid: "other-account" } })), "identity-mismatch");
});

test("Twilio requires stream envelopes and complete nested stop identity", () => {
  const packets = [
    twilioMedia(Buffer.alloc(160, 255), 1, 0), twilioStop,
    { event: "dtmf", sequenceNumber: "2", streamSid: twilioStreamSid, dtmf: { track: "inbound_track", digit: "#" } },
    { event: "mark", sequenceNumber: "2", streamSid: twilioStreamSid, mark: { name: "my label" } },
  ];
  for (const packet of packets) {
    error(twilioActive().receive(JSON.stringify({ ...packet, streamSid: undefined })), "invalid-message");
    error(twilioActive().receive(JSON.stringify({ ...packet, streamSid: "other-stream" })), "identity-mismatch");
  }
  for (const [packet, expected] of [
    [{ ...twilioStop, stop: undefined }, "invalid-message"],
    [{ ...twilioStop, stop: {} }, "invalid-message"],
    [{ ...twilioStop, stop: { accountSid: twilioAccountSid } }, "invalid-message"],
    [{ ...twilioStop, stop: { callSid: twilioCallSid } }, "invalid-message"],
    [{ ...twilioStop, stop: { ...twilioStop.stop, accountSid: "other-account" } }, "identity-mismatch"],
    [{ ...twilioStop, stop: { ...twilioStop.stop, callSid: "other-call" } }, "identity-mismatch"],
    [{ ...twilioStop, stop: { ...twilioStop.stop, streamSid: "other-stream" } }, "identity-mismatch"],
  ] as const) error(twilioActive().receive(JSON.stringify(packet)), expected);
});

test("DTMF shapes cannot cross dialects and invalid digits/tracks/durations close the session", () => {
  const twilioDtmf = { track: "inbound_track", digit: "1" };
  const signalwireDtmf = { digit: "#", duration: 200 };
  for (const dtmf of [signalwireDtmf, { digit: "1" }, { ...twilioDtmf, track: "inbound" },
    { ...twilioDtmf, duration: 0 }, { ...twilioDtmf, duration: null },
    { ...twilioDtmf, digit: "" }, { ...twilioDtmf, digit: "12" }, { ...twilioDtmf, digit: 1 }]) {
    const session = twilioActive();
    error(session.receive(JSON.stringify({ event: "dtmf", sequenceNumber: "2", streamSid: twilioStreamSid, dtmf })), "invalid-message");
    error(session.receive(JSON.stringify(twilioStop)), "session-closed");
  }
  for (const dtmf of [twilioDtmf, { ...signalwireDtmf, track: "inbound_track" }, { digit: "#" },
    { ...signalwireDtmf, duration: "200" }, { ...signalwireDtmf, duration: -1 }, { ...signalwireDtmf, duration: 0.5 }]) {
    error(active().receive(JSON.stringify({ event: "dtmf", sequenceNumber: "2", dtmf })), "invalid-message");
  }
});

test("Twilio marks participate in monotonic ordering; SignalWire-only unsequenced marks are rejected", () => {
  const mark = { event: "mark", streamSid: twilioStreamSid, mark: { name: "my label" } };
  error(twilioActive().receive(JSON.stringify(mark)), "invalid-sequence");
  const session = twilioActive();
  value(session.receive(JSON.stringify({ ...mark, sequenceNumber: "2" })));
  error(session.receive(JSON.stringify(twilioMedia(Buffer.alloc(160, 255), 1, 0, 2))), "invalid-sequence");
});

function incomingChunks(bytes: Buffer, lengths: number[]) {
  const session = active(); const frames: Buffer[] = [];
  let offset = 0, chunk = 1;
  while (offset < bytes.length) {
    const length = Math.min(lengths[(chunk - 1) % lengths.length], bytes.length - offset);
    const event = value(session.receive(media(bytes.subarray(offset, offset + length), chunk++, Math.floor(offset / 8))));
    if (event.event !== "media") assert.fail();
    frames.push(...event.pcm); offset += length;
  }
  return Buffer.concat(frames);
}
function outgoingChunks(bytes: Buffer, lengths: number[]) {
  const session = active(); const frames: CompatibilityMediaMessage[] = [];
  let offset = 0, chunk = 0;
  while (offset < bytes.length) {
    const length = Math.min(lengths[chunk++ % lengths.length], bytes.length - offset);
    frames.push(...value(session.outgoing(bytes.subarray(offset, offset + length)))); offset += length;
  }
  return outputBytes(frames);
}

test("8k to 16k preserves duration, speech tone and little-endian signed PCM across arbitrary packet boundaries", () => {
  const encoded = Buffer.from(tone(8000, 1000, 1).map(encodeMuLawSample));
  const full = incomingChunks(encoded, [1600]);
  assert.equal(full.length, 32000);
  assert.deepEqual(incomingChunks(encoded, [1, 17, 159, 321, 83]), full);
  const output = samples(full).slice(100);
  assert.ok(Math.abs(rms(output) / (10000 / Math.sqrt(2)) - 1) < 0.03);
  const crossings = output.filter((x, i) => i > 0 && x > 0 && output[i - 1] <= 0).length;
  assert.ok(Math.abs(crossings - output.length / 16) <= 1);
  const constant = samples(incomingChunks(Buffer.alloc(800, 0x3f), [7, 153]));
  assert.ok(constant.slice(100).every(x => Math.abs(x + 1980) <= 2));
  const alternating = samples(incomingChunks(Buffer.from(Array.from({ length: 800 }, (_, i) => i % 2 ? 0 : 128)), [160]));
  assert.ok(alternating.every(x => x >= -32768 && x <= 32767));
});

test("16k to 8k preserves speech and duration; downsample phase and FIR history survive single-sample packets", () => {
  const input = pcm(tone(16000, 1000, 1));
  const full = outgoingChunks(input, [6400]);
  assert.equal(full.length, 8000);
  assert.deepEqual(outgoingChunks(input, [2, 34, 638, 1282, 166]), full);
  const output = Array.from(full, decodeMuLawSample).slice(100);
  assert.ok(Math.abs(rms(output) / (10000 / Math.sqrt(2)) - 1) < 0.03);
  const crossings = output.filter((x, i) => i > 0 && x > 0 && output[i - 1] <= 0).length;
  assert.ok(Math.abs(crossings - output.length / 8) <= 1);
});

test("resampling filters decimation aliases and zero-insertion images", () => {
  const high = Array.from(outgoingChunks(pcm(tone(16000, 6000, 1)), [640]), decodeMuLawSample).slice(100);
  assert.ok(rms(high) < 30, `6 kHz alias RMS ${rms(high)}`);
  const upsampled = samples(incomingChunks(Buffer.from(tone(8000, 1000, 1).map(encodeMuLawSample)), [160])).slice(100);
  const amplitude = (frequency: number) => {
    let real = 0, imaginary = 0;
    upsampled.forEach((sample, i) => {
      real += sample * Math.cos(2 * Math.PI * frequency * i / 16000);
      imaginary += sample * Math.sin(2 * Math.PI * frequency * i / 16000);
    });
    return 2 * Math.hypot(real, imaginary) / upsampled.length;
  };
  assert.ok(amplitude(1000) > 9500);
  assert.ok(amplitude(7000) < 30);
});

test("outgoing packets are bounded and malformed PCM does not consume converter state", () => {
  const session = active();
  for (const input of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(MAX_VOICE_PACKET_BYTES + 2)]) error(session.outgoing(input), "invalid-pcm");
  assert.equal(value(session.outgoing(Buffer.alloc(MAX_VOICE_PACKET_BYTES))).length, 10);
  assert.ok(outputBytes(value(session.outgoing(Buffer.alloc(640)))).every(x => x === 255));
  error(new CompatibilityMediaSession("signalwire", callSid, accountSid).outgoing(Buffer.alloc(640)), "invalid-state");
});

test("clear drops buffered speech and output filter tail without resetting inbound history", () => {
  const session = active();
  const reference = active();
  const first = media(Buffer.alloc(80, 0xbf), 1, 0);
  value(session.receive(first)); value(reference.receive(first));
  assert.equal(value(session.outgoing(pcm(Array(101).fill(10000)))).length, 0);
  assert.deepEqual(value(session.clear()), { event: "clear", streamSid });
  assert.deepEqual(outputBytes(value(session.outgoing(Buffer.alloc(640)))), Buffer.alloc(160, 255));
  const second = media(Buffer.alloc(80, 0xbf), 2, 10);
  assert.deepEqual(value(session.receive(second)), value(reference.receive(second)));
  session.close();
  error(session.receive(JSON.stringify(connected)), "session-closed");
});
