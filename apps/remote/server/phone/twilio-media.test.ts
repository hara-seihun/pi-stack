import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TwilioMediaSession, encodeMuLawSample, decodeMuLawSample,
  MAX_TWILIO_MESSAGE_BYTES, MAX_MULAW_PACKET_BYTES, MAX_VOICE_PACKET_BYTES,
  type TwilioMediaResult, type TwilioMediaMessage,
} from "./twilio-media";

const accountSid = "AC" + "a".repeat(32), callSid = "CA" + "b".repeat(32), streamSid = "MZ" + "c".repeat(32);
const connected = { event: "connected", protocol: "Call", version: "1.0.0" };
const start = { event: "start", sequenceNumber: "1", streamSid,
  start: { callSid, streamSid, accountSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } };
const stop = { event: "stop", sequenceNumber: "2", streamSid, stop: { accountSid, callSid } };
function value<T>(result: TwilioMediaResult<T>): T { if (!result.ok) assert.fail(result.error); return result.value; }
function error<T>(result: TwilioMediaResult<T>, expected: string) { assert.deepEqual(result, { ok: false, error: expected }); }
function active(expectedCallSid: string | null = callSid) {
  const session = new TwilioMediaSession(expectedCallSid, accountSid);
  value(session.receive(JSON.stringify(connected))); value(session.receive(JSON.stringify(start)));
  return session;
}
function media(bytes: Buffer, chunk: number, timestamp: number, sequence = chunk + 1) {
  return { event: "media", sequenceNumber: String(sequence), streamSid, media: {
    track: "inbound", chunk: String(chunk), timestamp: String(timestamp), payload: bytes.toString("base64"),
  } };
}
function pcm(input: number[]) { const bytes = Buffer.alloc(input.length * 2); input.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2)); return bytes; }
function samples(bytes: Buffer) { return Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2)); }
function outputBytes(messages: TwilioMediaMessage[]) {
  for (const message of messages) {
    assert.equal(message.event, "media"); assert.equal(message.streamSid, streamSid);
    assert.equal(Buffer.from(message.media.payload, "base64").length, 160);
    assert.deepEqual(Object.keys(message).sort(), ["event", "media", "streamSid"]);
  }
  return Buffer.concat(messages.map(message => Buffer.from(message.media.payload, "base64")));
}
function rms(input: number[]) { return Math.sqrt(input.reduce((sum, x) => sum + x * x, 0) / input.length); }
function tone(rate: number, frequency: number) { return Array.from({ length: rate }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * frequency * i / rate))); }

// Fixed independent G.711 vectors detect sign/bias/segment/clipping errors.
test("G.711 matches known codewords and segment-edge samples", () => {
  const codes = [255, 127, 254, 126, 240, 112, 239, 111, 224, 96, 223, 95, 208, 80, 207, 79, 192, 64, 191, 63, 176, 48, 175, 47, 160, 32, 159, 31, 144, 16, 143, 15, 128, 0];
  assert.deepEqual(codes.map(decodeMuLawSample), [0, 0, 8, -8, 120, -120, 132, -132, 372, -372, 396, -396, 876, -876, 924, -924, 1884, -1884, 1980, -1980, 3900, -3900, 4092, -4092, 7932, -7932, 8316, -8316, 15996, -15996, 16764, -16764, 32124, -32124]);
  const input = [0, 1, -1, 8, -8, 16, -16, 123, -123, 124, -124, 379, -379, 380, -380, 892, -892, 1916, -1916, 3964, -3964, 8060, -8060, 16252, -16252, 32635, -32635, 32767, -32768];
  assert.deepEqual(input.map(encodeMuLawSample), [255, 255, 127, 254, 126, 253, 125, 240, 112, 239, 111, 224, 96, 223, 95, 207, 79, 191, 63, 175, 47, 159, 31, 143, 15, 128, 0, 128, 0]);
});

test("ordered Twilio handshake, codec/account/call/stream identities and envelope are mandatory", () => {
  error(new TwilioMediaSession(callSid, accountSid).receive(JSON.stringify(start)), "invalid-state");
  error(active().receive(JSON.stringify(start)), "invalid-state");
  for (const packet of [{ ...connected, version: "0.2.0" }, { ...connected, version: "1.0.1" }, { ...connected, protocol: "Other" }]) error(new TwilioMediaSession(callSid, accountSid).receive(JSON.stringify(packet)), "unsupported-protocol");
  for (const [packet, expected] of [
    [{ ...start, start: { ...start.start, accountSid: "other-account" } }, "identity-mismatch"],
    [{ ...start, start: { ...start.start, callSid: "other-call" } }, "identity-mismatch"],
    [{ ...start, streamSid: "other-stream" }, "identity-mismatch"], [{ ...start, streamSid: undefined }, "invalid-message"],
    [{ ...start, sequenceNumber: "2" }, "invalid-sequence"],
    [{ ...start, start: { ...start.start, tracks: ["outbound"] } }, "unsupported-codec"],
    [{ ...start, start: { ...start.start, mediaFormat: { ...start.start.mediaFormat, sampleRate: 16000 } } }, "unsupported-codec"],
  ] as const) {
    const session = new TwilioMediaSession(callSid, accountSid); value(session.receive(JSON.stringify(connected)));
    error(session.receive(JSON.stringify(packet)), expected); error(session.receive(JSON.stringify(start)), "session-closed");
  }
  for (const packet of [media(Buffer.alloc(160), 1, 0), stop,
    { event: "dtmf", sequenceNumber: "2", streamSid, dtmf: { track: "inbound_track", digit: "#" } },
    { event: "mark", sequenceNumber: "2", streamSid, mark: { name: "done" } }]) {
    error(active().receive(JSON.stringify({ ...packet, streamSid: undefined })), "invalid-message");
    error(active().receive(JSON.stringify({ ...packet, streamSid: "other-stream" })), "identity-mismatch");
  }
  for (const [packet, expected] of [
    [{ ...stop, stop: undefined }, "invalid-message"], [{ ...stop, stop: {} }, "invalid-message"],
    [{ ...stop, stop: { accountSid } }, "invalid-message"], [{ ...stop, stop: { callSid } }, "invalid-message"],
    [{ ...stop, stop: { accountSid: "other-account", callSid } }, "identity-mismatch"],
    [{ ...stop, stop: { accountSid, callSid: "other-call" } }, "identity-mismatch"],
  ] as const) error(active().receive(JSON.stringify(packet)), expected);
});

test("malformed, oversized, noncanonical, replayed or unsupported packets close the session", () => {
  for (const [raw, expected] of [["{", "invalid-json"], ["null", "invalid-message"], ["[]", "invalid-message"],
    [Buffer.alloc(160), "invalid-message"], ["x".repeat(MAX_TWILIO_MESSAGE_BYTES + 1), "message-too-large"],
    [JSON.stringify({ event: "unknown", streamSid, sequenceNumber: "2" }), "unsupported-event"]] as const) {
    const session = active(); error(session.receive(raw), expected); error(session.receive(JSON.stringify(stop)), "session-closed");
  }
  for (const payload of ["", "Zg", "Zg=", "Zh==", "Zg==\n", "!!!!", "____", 123, null, Buffer.alloc(MAX_MULAW_PACKET_BYTES + 1).toString("base64")]) {
    const packet = media(Buffer.alloc(160), 1, 0); error(active().receive(JSON.stringify({ ...packet, media: { ...packet.media, payload } })), "invalid-media");
  }
  for (const sequence of [2, "02", "2.0", "-1", "9007199254740992"]) error(active().receive(JSON.stringify({ ...media(Buffer.alloc(160), 1, 0), sequenceNumber: sequence })), "invalid-sequence");
  for (const bad of [media(Buffer.alloc(160), 2, 20, 2), media(Buffer.alloc(160), 1, 20, 3), media(Buffer.alloc(160), 3, 20, 3), media(Buffer.alloc(160), 2, 9, 3)]) {
    const session = active(); value(session.receive(JSON.stringify(media(Buffer.alloc(160), 1, 10, 2)))); assert.equal(session.receive(JSON.stringify(bad)).ok, false);
  }
  for (const dtmf of [{ digit: "#", duration: 200 }, { digit: "1" }, { track: "inbound", digit: "1" }, { track: "inbound_track", digit: "1", duration: 0 }, { track: "inbound_track", digit: "12" }]) error(active().receive(JSON.stringify({ event: "dtmf", sequenceNumber: "2", streamSid, dtmf })), "invalid-message");
  error(active().receive(JSON.stringify({ event: "mark", streamSid, mark: { name: "done" } })), "invalid-sequence");
});

test("documented Twilio duplex/control sequence ends cleanly", () => {
  const session = active(null), input = value(session.receive(JSON.stringify(media(Buffer.alloc(160, 255), 1, 0))));
  if (input.event !== "media") assert.fail();
  assert.deepEqual(input.pcm, [Buffer.alloc(640)]);
  assert.deepEqual(outputBytes(value(session.outgoing(input.pcm[0]))), Buffer.alloc(160, 255));
  assert.deepEqual(value(session.clear()), { event: "clear", streamSid });
  assert.deepEqual(value(session.receive(JSON.stringify({ event: "dtmf", streamSid, sequenceNumber: "3", dtmf: { track: "inbound_track", digit: "1" } }))), { event: "dtmf", digit: "1", duration: null });
  assert.deepEqual(value(session.receive(JSON.stringify({ event: "mark", streamSid, sequenceNumber: "4", mark: { name: "my label" } }))), { event: "mark", name: "my label" });
  assert.deepEqual(value(session.receive(JSON.stringify({ ...stop, sequenceNumber: "5" }))), { event: "stop" });
  error(session.outgoing(Buffer.alloc(640)), "session-closed"); error(session.clear(), "session-closed");
});

function incomingChunks(bytes: Buffer, lengths: number[]) {
  const session = active(), frames: Buffer[] = []; let offset = 0, chunk = 1;
  while (offset < bytes.length) {
    const length = Math.min(lengths[(chunk - 1) % lengths.length], bytes.length - offset);
    const event = value(session.receive(JSON.stringify(media(bytes.subarray(offset, offset + length), chunk++, Math.floor(offset / 8)))));
    if (event.event !== "media") assert.fail(); frames.push(...event.pcm); offset += length;
  }
  return Buffer.concat(frames);
}
function outgoingChunks(bytes: Buffer, lengths: number[]) {
  const session = active(), frames: TwilioMediaMessage[] = []; let offset = 0, chunk = 0;
  while (offset < bytes.length) {
    const length = Math.min(lengths[chunk++ % lengths.length], bytes.length - offset);
    frames.push(...value(session.outgoing(bytes.subarray(offset, offset + length)))); offset += length;
  }
  return outputBytes(frames);
}

test("16k PCM/8k PCMU conversion preserves speech/duration/history and rejects aliases", () => {
  const wire = Buffer.from(tone(8000, 1000).map(encodeMuLawSample)), up = incomingChunks(wire, [1600]);
  assert.equal(up.length, 32000); assert.deepEqual(incomingChunks(wire, [1, 17, 159, 321, 83]), up);
  assert.ok(Math.abs(rms(samples(up).slice(100)) / (10000 / Math.sqrt(2)) - 1) < 0.03);
  const down = outgoingChunks(pcm(tone(16000, 1000)), [6400]);
  assert.equal(down.length, 8000); assert.deepEqual(outgoingChunks(pcm(tone(16000, 1000)), [2, 34, 638, 1282, 166]), down);
  assert.ok(Math.abs(rms(Array.from(down, decodeMuLawSample).slice(100)) / (10000 / Math.sqrt(2)) - 1) < 0.03);
  assert.ok(rms(Array.from(outgoingChunks(pcm(tone(16000, 6000)), [640]), decodeMuLawSample).slice(100)) < 30);
  const input = samples(up).slice(100);
  const amplitude = (frequency: number) => {
    let real = 0, imaginary = 0;
    input.forEach((sample, i) => { real += sample * Math.cos(2 * Math.PI * frequency * i / 16000); imaginary += sample * Math.sin(2 * Math.PI * frequency * i / 16000); });
    return 2 * Math.hypot(real, imaginary) / input.length;
  };
  assert.ok(amplitude(1000) > 9500); assert.ok(amplitude(7000) < 30);
});

test("clear drops buffered output/tail, keeps inbound history; invalid PCM consumes no state", () => {
  const session = active(), reference = active();
  for (const input of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(MAX_VOICE_PACKET_BYTES + 2)]) error(session.outgoing(input), "invalid-pcm");
  const first = JSON.stringify(media(Buffer.alloc(80, 191), 1, 0)); value(session.receive(first)); value(reference.receive(first));
  assert.equal(value(session.outgoing(pcm(Array(101).fill(10000)))).length, 0);
  assert.deepEqual(value(session.clear()), { event: "clear", streamSid });
  assert.deepEqual(outputBytes(value(session.outgoing(Buffer.alloc(640)))), Buffer.alloc(160, 255));
  const second = JSON.stringify(media(Buffer.alloc(80, 191), 2, 10)); assert.deepEqual(value(session.receive(second)), value(reference.receive(second)));
  error(new TwilioMediaSession(callSid, accountSid).outgoing(Buffer.alloc(640)), "invalid-state");
});
