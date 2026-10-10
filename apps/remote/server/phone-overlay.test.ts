import { describe, expect, test } from "bun:test";
import { PhoneBroker, type PhoneDevice } from "./phones";
import { PhoneOverlay, spokenText, type OverlayHost } from "./phone-overlay";
import { validatePhoneCommand } from "./phone-commands";
import { parsePhoneArgs } from "./phone-cli";

const device: PhoneDevice = { id: "pixel", name: "Pixel 7", model: "Pixel 7", android: "16", capabilities: { overlayEnabled: true } };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function host(overrides: Partial<OverlayHost> = {}) {
  const sent: Array<[string, Record<string, unknown>]> = []; const prompts: string[] = []; const created: string[] = [];
  const prepared = new Map<string, { input: string; text: string }>();
  const saved = new Map<string, string>(); const threads = new Map<string, { archived: boolean }>();
  let online = true;
  const value: OverlayHost = {
    prepare: (deviceId, messageId, input, text) => {
      const key = `${deviceId}:${messageId}`, prior = prepared.get(key);
      if (prior && prior.input !== input) throw new Error("Conflicting source identity");
      if (!prior) prepared.set(key, { input, text });
      return prepared.get(key)!.text;
    },
    thread: id => threads.get(id) ?? null,
    create: async text => { created.push(text); const id = `thread-${created.length}`; threads.set(id, { archived: false }); return id; },
    prompt: async (_id, _request, text) => { prompts.push(text); },
    send: async (_device, command, args) => { sent.push([command, args]); return { type: "result", id: "x", ok: true, result: {} }; },
    online: () => online,
    load: () => [...saved].map(([deviceId, threadId]) => ({ deviceId, threadId })),
    save: (deviceId, threadId) => { saved.set(deviceId, threadId); },
    log: () => {},
    ...overrides,
  };
  return { value, sent, prompts, created, saved, threads, offline: () => { online = false; }, online: () => { online = true; } };
}

describe("phone overlay conversation", () => {
  test("first message briefs the attached conversation; transient events update state but never deliver replies", async () => {
    const h = host(); const overlay = new PhoneOverlay(h.value); overlay.ready(device);
    const first = await overlay.message(device, { id: "m1", text: "what's this button?", context: { package: "com.example", label: "Example" } });
    expect(first).toEqual({ ok: true, threadId: "thread-1" });
    expect(h.created[0]).toContain("pi-phone point");
    expect(h.created[0]).toContain("[Phone overlay · in Example (com.example)]\nwhat's this button?");
    expect(h.saved.get("pixel")).toBe("thread-1");
    await overlay.message(device, { id: "m2", text: "thanks", context: { package: null, label: null } });
    expect(h.prompts).toEqual(["[Phone overlay]\nthanks"]);
    overlay.event("thread-1", { type: "tool_execution_start" });
    overlay.event("other", { type: "message_end", message: { role: "assistant", content: "ignored" } });
    overlay.event("thread-1", { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "That's Settings. <pi-remote-image id=\"a\" />" }] } });
    overlay.event("thread-1", { type: "thread_settled", outcome: "completed" });
    await tick();
    expect(h.sent).toEqual([["overlay.state", { state: "thinking" }], ["overlay.state", { state: "working" }],
      ["overlay.state", { state: "idle" }]]);
  });

  test("an archived thread is replaced without replaying transient output to a reconnected phone", async () => {
    const h = host(); h.saved.set("pixel", "old"); h.threads.set("old", { archived: true });
    const overlay = new PhoneOverlay(h.value); overlay.ready(device);
    expect(await overlay.message(device, { id: "m", text: "hi", context: { package: null, label: null } })).toEqual({ ok: true, threadId: "thread-1" });
    h.offline();
    overlay.event("thread-1", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "later" }] } });
    overlay.event("old", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } });
    h.online(); overlay.ready(device); await tick();
    expect(h.sent.filter(([command]) => command === "overlay.say")).toEqual([]);
  });

  test("broker acknowledges overlay messages and rejects malformed ones without dropping the phone", async () => {
    const broker = new PhoneBroker({ overlayMessage: async (_device, message) => ({ ok: true, threadId: `t-${message.text}` }) });
    const sent: any[] = []; const closes: number[] = [];
    const connection = broker.open({ send(frame) { sent.push(JSON.parse(frame)); return frame.length; }, close(code) { closes.push(code); } });
    broker.receive(connection, JSON.stringify({ type: "hello", device: { ...device, capabilities: {} } }));
    broker.receive(connection, JSON.stringify({ type: "overlay.message", id: "a1", text: " hello ", context: { package: "p" } }));
    broker.receive(connection, JSON.stringify({ type: "overlay.message", id: "a2", text: "", context: {} }));
    await tick();
    expect(sent.slice(1)).toEqual([{ type: "overlay.ack", id: "a2", ok: false, error: { code: "invalid_request", message: "Message must be 1..8000 characters" } },
      { type: "overlay.ack", id: "a1", ok: true, threadId: "t-hello" }]);
    expect(closes).toEqual([]);
    broker.stop();
  });

  test("disabled chat creates no execution and forwards no replies or reconnect backlog", async () => {
    const h = host(); const overlay = new PhoneOverlay(h.value);
    const disabled = { ...device, capabilities: { overlayEnabled: false } };
    overlay.ready(disabled);
    expect((await overlay.message(disabled, { id: "m", text: "hi", context: { package: null, label: null } })).ok).toBe(false);
    expect(h.created).toEqual([]);
    overlay.ready(device);
    await overlay.message(device, { id: "m2", text: "hi", context: { package: null, label: null } });
    h.offline();
    overlay.event("thread-1", { type: "message_end", message: { role: "assistant", content: "old reply" } });
    overlay.ready(disabled);
    overlay.event("thread-1", { type: "tool_execution_start" });
    h.online(); overlay.ready(device);
    await tick();
    expect(h.sent.filter(([command]) => command === "overlay.say")).toEqual([]);
  });

  test("phones share the manager while source message IDs survive uncertain acknowledgement", async () => {
    const requests: string[] = [], deliveries: string[] = [];
    const second = { ...device, id: "tablet" };
    const h = host({
      load: () => [{ deviceId: device.id, threadId: "manager" }, { deviceId: second.id, threadId: "manager" }],
      thread: () => ({ archived: false }),
      prompt: async (_threadId, requestId) => { requests.push(requestId); if (requests.length === 1) throw new Error("Receipt lost"); },
      send: async (deviceId, command) => { if (command === "overlay.say") deliveries.push(deviceId); return { type: "result", id: "x", ok: true, result: {} }; },
    });
    const overlay = new PhoneOverlay(h.value); overlay.ready(device); overlay.ready(second);
    const message = { id: "original-id", text: "Hi", context: { package: null, label: null } };
    await expect(overlay.message(device, message)).rejects.toThrow("Receipt lost");
    expect(await overlay.message(device, message)).toEqual({ ok: true, threadId: "manager" });
    expect(requests).toEqual(["overlay:pixel:original-id", "overlay:pixel:original-id"]);
    overlay.event("manager", { type: "message_end", message: { role: "assistant", content: "Reply" } });
    await tick();
    expect(deliveries).toEqual([]); // Canonical receipt fanout, not token events, delivers replies.
  });

  test("retrying the first message after binding preserves its original briefing bytes", async () => {
    const calls: Array<{ requestId: string; text: string }> = [];
    const h = host({
      create: async (text, _device, requestId) => { calls.push({ text, requestId }); return "manager"; },
      thread: () => ({ archived: false }),
      prompt: async (_id, requestId, text) => { calls.push({ text, requestId }); },
    });
    const message = { id: "first", text: "Hello", context: { package: null, label: null } };
    const first = new PhoneOverlay(h.value); first.ready(device);
    await first.message(device, message);
    const restarted = new PhoneOverlay(h.value); restarted.ready(device);
    await restarted.message({ ...device, name: "Renamed phone" }, message);
    expect(calls[1]).toEqual(calls[0]);
  });

  test("catalogue and CLI shapes", () => {
    expect(validatePhoneCommand({ command: "overlay.point", args: { x: 1, y: 2, text: "here" } }).ok).toBe(true);
    expect(validatePhoneCommand({ command: "overlay.point", args: { x: 1 } }).ok).toBe(false);
    expect(validatePhoneCommand({ command: "overlay.point", args: { x: 1, y: 2, nodeId: "1:0" } }).ok).toBe(false);
    expect(validatePhoneCommand({ command: "overlay.say", args: { text: "x".repeat(2001) } }).ok).toBe(false);
    expect(validatePhoneCommand({ command: "overlay.say", args: { text: "Reply", receiptId: "manager-reply:manager:execution" } }).ok).toBe(true);
    expect(validatePhoneCommand({ command: "overlay.say", args: { text: "Reply", receiptId: " " } }).ok).toBe(false);
    const point = parsePhoneArgs(["point", "10", "20", "tap", "here"]);
    expect(point.ok && point.value.kind === "command" && point.value.args).toEqual({ x: 10, y: 20, text: "tap here" });
    const say = parsePhoneArgs(["say", "hello"]);
    expect(say.ok && say.value.kind === "command" && say.value.command).toBe("overlay.say");
    expect(spokenText({ content: [{ type: "text", text: "a".repeat(3000) }] }).length).toBe(2000);
  });
});
