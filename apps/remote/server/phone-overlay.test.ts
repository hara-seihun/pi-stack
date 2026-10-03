import { describe, expect, test } from "bun:test";
import { PhoneBroker, type PhoneDevice } from "./phones";
import { PhoneOverlay, spokenText, type OverlayHost } from "./phone-overlay";
import { validatePhoneCommand } from "./phone-commands";
import { parsePhoneArgs } from "./phone-cli";

const device: PhoneDevice = { id: "pixel", name: "Pixel 7", model: "Pixel 7", android: "16", capabilities: {} };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function host(overrides: Partial<OverlayHost> = {}) {
  const sent: Array<[string, Record<string, unknown>]> = []; const prompts: string[] = []; const created: string[] = [];
  const saved = new Map<string, string>(); const threads = new Map<string, { archived: boolean }>();
  let online = true;
  const value: OverlayHost = {
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
  test("first message briefs a new thread, later ones steer it, and replies come back as bubbles", async () => {
    const h = host(); const overlay = new PhoneOverlay(h.value);
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
      ["overlay.say", { text: "That's Settings." }], ["overlay.state", { state: "idle" }]]);
  });

  test("an archived thread is replaced and a reply to an offline phone waits for reconnect", async () => {
    const h = host(); h.saved.set("pixel", "old"); h.threads.set("old", { archived: true });
    const overlay = new PhoneOverlay(h.value);
    expect(await overlay.message(device, { id: "m", text: "hi", context: { package: null, label: null } })).toEqual({ ok: true, threadId: "thread-1" });
    h.offline();
    overlay.event("thread-1", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "later" }] } });
    overlay.event("old", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } });
    h.online(); overlay.ready(device); await tick();
    expect(h.sent.filter(([command]) => command === "overlay.say")).toEqual([["overlay.say", { text: "later" }]]);
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

  test("catalogue and CLI shapes", () => {
    expect(validatePhoneCommand({ command: "overlay.point", args: { x: 1, y: 2, text: "here" } }).ok).toBe(true);
    expect(validatePhoneCommand({ command: "overlay.point", args: { x: 1 } }).ok).toBe(false);
    expect(validatePhoneCommand({ command: "overlay.point", args: { x: 1, y: 2, nodeId: "1:0" } }).ok).toBe(false);
    expect(validatePhoneCommand({ command: "overlay.say", args: { text: "x".repeat(2001) } }).ok).toBe(false);
    const point = parsePhoneArgs(["point", "10", "20", "tap", "here"]);
    expect(point.ok && point.value.kind === "command" && point.value.args).toEqual({ x: 10, y: 20, text: "tap here" });
    const say = parsePhoneArgs(["say", "hello"]);
    expect(say.ok && say.value.kind === "command" && say.value.command).toBe("overlay.say");
    expect(spokenText({ content: [{ type: "text", text: "a".repeat(3000) }] }).length).toBe(2000);
  });
});
