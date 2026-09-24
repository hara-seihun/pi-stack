import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessagingCall, MessagingSnapshot } from "../server/messaging/protocol";
import { CALL_FRAME_BYTES, CALL_FRAME_SAMPLES, FrameJitterBuffer, PCMFrameEncoder } from "./src/messaging-call-audio";
import { MessagingCallProvider, MessagingCallSurface, SignalCallButton } from "./src/messaging-call";

const call = (extra: Partial<MessagingCall> = {}): MessagingCall => ({
  id: "call-1", backendId: "signal", conversationId: "conversation-1", peer: "+12025550123", peerName: "Jo",
  avatar: null, direction: "incoming", state: "ringing_incoming", muted: false, startedAt: 1,
  connectedAt: null, endedAt: null, reason: null, error: null, ...extra,
});
const conversations = [{
  id: "conversation-1", backendId: "signal", externalId: "+12025550123", title: "Jo", kind: "direct" as const,
  updatedAt: 1, unread: 0, current: true, avatar: null, revision: 0,
}];
const snapshot = (active: MessagingCall): MessagingSnapshot => ({
  version: 2,
  backends: [{ id: "signal", label: "Signal", plugin: "signal", icon: "signal", capabilities: { attachments: true, groups: true, calls: true }, status: "ready", detail: "", linkable: false, link: null }],
  conversations,
  calls: [active],
});

function surface(active: MessagingCall) {
  return renderToStaticMarkup(createElement(MessagingCallSurface, {
    call: active, conversations, busy: false, error: "", onAccept() {}, onHangup() {}, onMute() {},
  }));
}

test("microphone conversion emits only exact 20 ms Int16 frames at boundary sizes", () => {
  const encoder = new PCMFrameEncoder();
  expect(encoder.push(new Float32Array(CALL_FRAME_SAMPLES - 1).fill(0.5))).toEqual([]);
  expect(encoder.pendingSamples()).toBe(CALL_FRAME_SAMPLES - 1);
  const completed = encoder.push(new Float32Array([-1]));
  expect(completed).toHaveLength(1);
  expect(completed[0].byteLength).toBe(CALL_FRAME_BYTES);
  expect(completed[0][0]).toBe(16384);
  expect(completed[0][CALL_FRAME_SAMPLES - 1]).toBe(-32768);
  expect(encoder.pendingSamples()).toBe(0);

  const over = new Float32Array(CALL_FRAME_SAMPLES + 1);
  over[0] = 2;
  over[CALL_FRAME_SAMPLES - 1] = -2;
  const frames = encoder.push(over);
  expect(frames).toHaveLength(1);
  expect(frames[0][0]).toBe(32767);
  expect(frames[0][CALL_FRAME_SAMPLES - 1]).toBe(-32768);
  expect(encoder.pendingSamples()).toBe(1);
});

test("the 60 ms jitter buffer orders late frames and rejects duplicates", () => {
  const jitter = new FrameJitterBuffer<string>(3);
  expect(jitter.push(10, "ten")).toBe(true);
  expect(jitter.pull()).toBeNull();
  expect(jitter.push(12, "twelve")).toBe(true);
  expect(jitter.push(11, "eleven")).toBe(true);
  expect(jitter.push(11, "duplicate")).toBe(false);
  expect(jitter.pull()).toBe("ten");
  expect(jitter.push(9, "too late")).toBe(false);
  expect(jitter.pull()).toBe("eleven");
  expect(jitter.pull()).toBe("twelve");
  expect(jitter.pull()).toBeNull();
});

test("mute controls render the server snapshot rather than optimistic local state", () => {
  const html = surface(call({ state: "connected", direction: "outgoing", muted: true, connectedAt: Date.now() - 4_000 }));
  expect(html).toContain("Unmute");
  expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain(">Mute<");
});

test("an incoming call in the messaging snapshot renders outside the selected conversation", () => {
  const html = renderToStaticMarkup(createElement(MessagingCallProvider, { snapshot: snapshot(call()) }, createElement("main", null, "Another chat")));
  expect(html).toContain("Another chat");
  expect(html).toContain("Incoming Signal call");
  expect(html).toContain("Jo");
  expect(html).toContain("Accept");
  expect(html).toContain("Decline");
});

test("a direct Signal chat keeps the call control visible when calling is unavailable", () => {
  const unavailable = { ...snapshot(call()), calls: [] };
  const html = renderToStaticMarkup(createElement(MessagingCallProvider, { snapshot: unavailable },
    createElement(SignalCallButton, { conversation: conversations[0], available: true, enabled: false })));
  expect(html).toContain("Call Jo on Signal");
  expect(html).toContain("Signal calling is unavailable");
  expect(html).toContain("disabled");
});
