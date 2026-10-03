import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TracePrivacy, TRACE_WITHHELD, type TraceState } from "./trace-privacy";
import { isMachineAdministrator } from "../../../packages/orchestrator/src/threads/trace-access";
import { displayContextDocument } from "./context-display";
import { deriveTranscriptItems, TranscriptItems, transcriptWindow } from "./transcript-items";
import { ClientStream } from "./stream";
import { messageFinalizationKey } from "./sync";

const root = mkdtempSync(join(tmpdir(), "trace-privacy-"));
const a = join(root, "a"), b = join(root, "b");
mkdirSync(a); mkdirSync(b);
const persons = [{ user: "a", unlock: { mountpoint: a, cipherDir: a + "-cipher" } },
  { user: "b", unlock: { mountpoint: b, cipherDir: b + "-cipher" } }];
afterAll(() => rmSync(root, { recursive: true, force: true }));
function privacy(enabled = true, states = new Map<string, TraceState>()) {
  return new TracePrivacy({ enabled, viewer: "a", persons, load: id => states.get(id), save: (id, state) => { states.set(id, state); } });
}
const scope = { cwd: a, running: false };
function context(about = ["b"]): any {
  return { systemPrompt: "SYSTEM_SECRET", tools: [], messages: [
    { role: "user", timestamp: 100, content: "First" },
    { role: "assistant", timestamp: 101, content: [{ type: "thinking", thinking: "CLEAN_THINK" }, { type: "text", text: "First answer" }] },
    { role: "user", timestamp: 200, content: "Second" },
    { role: "assistant", timestamp: 201, content: [{ type: "thinking", thinking: "PRIVATE_THINK" },
      { type: "toolCall", name: "memory_read", id: "read-1", arguments: { ids: ["ARG_SECRET"] }, partialOutput: "PARTIAL_SECRET" }] },
    { role: "toolResult", toolCallId: "read-1", timestamp: 202, content: [{ type: "text", text: "RESULT_SECRET" },
      { type: "image", mimeType: "image/png", data: "IMAGE_SECRET" }],
      details: { kenanMemoryRead: { person: "a", threadId: "s", turnId: "turn", touchedOtherPeople: about.some(id => id !== "a"), about } } },
    { role: "assistant", timestamp: 203, content: [{ type: "text", text: "Chosen public answer" }] },
  ] };
}
const secrets = ["PRIVATE_THINK", "ARG_SECRET", "PARTIAL_SECRET", "RESULT_SECRET", "IMAGE_SECRET", "SYSTEM_SECRET"];
const noSecrets = (value: unknown) => { const wire = JSON.stringify(value); for (const secret of secrets) expect(wire).not.toContain(secret); };

describe("One Kenan trace boundary", () => {
  test("full context/work cards redact the whole touched turn, not only the reading step", () => {
    const p = privacy(), source = context();
    const safe = p.context("s", source, scope);
    noSecrets(safe);
    expect(JSON.stringify(safe)).toContain("CLEAN_THINK");
    expect(JSON.stringify(safe)).toContain("Chosen public answer");
    expect(JSON.stringify(safe)).toContain(TRACE_WITHHELD);
    expect(JSON.stringify(source)).toContain("PRIVATE_THINK");
  });
  test("transcript heads, previews, lazy bodies and old body hashes use the redacted generation", () => {
    const source = context(), p = privacy();
    const transcript = new TranscriptItems();
    const original = transcript.derive("s", "raw", () => source).current;
    const oldBody = original.items.find(item => item.head.kind === "toolCall")!.head.id;
    const safe = transcript.derive("s", "safe", () => p.context("s", source, scope)).current;
    noSecrets(transcriptWindow(safe.items));
    for (const item of safe.items) noSecrets(JSON.parse(item.body));
    expect(safe.bodies.has(oldBody)).toBe(false);
    expect(safe.items.some(item => item.head.kind === "notice" && item.head.label === "Privacy")).toBe(true);
  });
  test("restored streamed thinking and image resources are redacted before image registration", () => {
    const p = privacy(), source = context();
    source.messages[3].content[0].thinking = "";
    const restored = new Map([[messageFinalizationKey(source.messages[3]), "PRIVATE_THINK"]]);
    const images: string[] = [];
    const display = displayContextDocument(JSON.stringify(source), restored, image => { images.push(image.data); return "/image"; }, [], new Map(),
      value => p.context("s", value, scope));
    noSecrets(JSON.parse(display));
    expect(images).toEqual([]);
  });
  test("SSE event delivery and Voice catch-up never expose tool arguments or results", () => {
    const p = privacy(); p.context("s", context(), scope);
    const events = p.events("s", [
      { seq: 1, time: new Date(201).toISOString(), type: "tool_start", args: "ARG_SECRET" },
      { seq: 2, time: new Date(202).toISOString(), type: "tool_end", output: "RESULT_SECRET" },
      { seq: 3, time: new Date(203).toISOString(), type: "assistant", text: "Chosen public answer" },
    ], scope);
    noSecrets(events);
    let wire = "";
    const stream = new ClientStream({ write: text => { wire += text; }, close() {} });
    stream.send({ type: "events", sessionId: "s", events });
    for (const secret of secrets) expect(wire).not.toContain(secret);
    expect(wire).toContain("Chosen public answer");
    expect(p.liveThinking("s", "PRIVATE_THINK", scope)).toBe("");
  });
  test("pending turns hold earlier thoughts before a later private read, then replay own-only traces", () => {
    const p = privacy(), own = context(["a"]);
    noSecrets(p.context("s", own, { ...scope, running: true }).messages.slice(2));
    expect(p.liveThinking("s", "PRIVATE_THINK", { ...scope, running: true })).toBe("");
    expect(JSON.stringify(p.context("s", own, scope))).toContain("PRIVATE_THINK");
    expect(p.liveThinking("s", "PRIVATE_THINK", scope)).toBe("PRIVATE_THINK");
    expect(p.state("s").privateSince).toBeUndefined();
  });
  test("notification payloads carry only public notification fields", () => {
    const p = privacy();
    const safe = p.notifications({ cursor: 4, notifications: [{ seq: 4, sessionId: "s", name: "Thread", time: "now", body: "Session is idle", thinking: "PRIVATE_THINK", toolResult: "RESULT_SECRET" }] });
    noSecrets(safe);
    expect(safe.cursor).toBe(4);
    expect(safe.notifications[0].body).toBe("Session is idle");
  });
  test("native transcript and HTML exports are refused through file delivery, including copies and symlinks", () => {
    const p = privacy(), threads = join(root, "threads"); mkdirSync(threads);
    writeFileSync(join(threads, "s.jsonl"), '{"type":"session","version":3}\n');
    const copied = join(a, "renamed.txt"); writeFileSync(copied, '{"type":"session","version":3}\n');
    const html = join(a, "export.txt"); writeFileSync(html, '<!DOCTYPE html><title>Session Export</title>PRIVATE_THINK');
    symlinkSync(join(threads, "s.jsonl"), join(a, "alias"));
    for (const path of [join(threads, "s.jsonl"), copied, html, join(a, "alias")]) expect(p.rawFileAllowed(path, [threads])).toBe(false);
    writeFileSync(join(a, "report.txt"), "Intentionally shared report");
    expect(p.rawFileAllowed(join(a, "report.txt"), [threads])).toBe(true);
  });
  test("relative paths, symlinks, nested owner roots and opaque tools taint persistently", () => {
    const p = privacy(); symlinkSync(b, join(a, "other"));
    expect(p.callTouchesOther("read", { path: "other/notes" }, a)).toBe(true);
    expect(p.callTouchesOther("read", { path: "notes" }, a)).toBe(false);
    expect(p.callTouchesOther("bash", { command: "arbitrary program" }, a)).toBe(true);
    expect(p.callTouchesOther("agent_browser", { args: ["read", "file:///private"] }, a)).toBe(true);
    expect(p.callTouchesOther("thread_read", { threadId: "other-thread" }, a)).toBe(true);
  });
  test("taint survives supervisor restart and compaction and covers later reasoning from retained private information", () => {
    const states = new Map<string, TraceState>(), p = privacy(true, states); p.context("s", context(), scope);
    const restarted = privacy(true, states);
    const compacted = { systemPrompt: "SYSTEM_SECRET", tools: [], messages: [
      { role: "custom", content: "RESULT_SECRET" }, { role: "user", timestamp: 400, content: "Later" },
      { role: "assistant", timestamp: 401, content: [{ type: "thinking", thinking: "PRIVATE_THINK" }, { type: "text", text: "Later public answer" }] },
    ] };
    noSecrets(restarted.context("s", compacted, scope));
  });
  test("rooms always withhold traces, including empty memory reads", () => {
    const p = privacy(), own = context(["a"]);
    own.messages[4].details.kenanMemoryRead = { ...own.messages[4].details.kenanMemoryRead, roomId: "room", about: [], touchedOtherPeople: true };
    noSecrets(p.context("s", own, { ...scope, room: true }));
  });
  test("unreported memory reads fail closed", () => {
    const own = context(["a"]); delete own.messages[4].details;
    noSecrets(privacy().context("s", own, scope));
  });
  test("absent flag and registry-marked administrator keep today's live traces exactly", () => {
    expect(isMachineAdministrator("a", [{ ...persons[0]!, machineAdministrator: true }])).toBe(true);
    expect(isMachineAdministrator("b", [{ ...persons[0]!, machineAdministrator: true }])).toBe(false);
    expect(isMachineAdministrator("kenan", persons)).toBe(false);
    const source = context(), p = privacy(false);
    expect(p.context("s", source, { room: true, running: true })).toBe(source);
    expect(p.liveThinking("s", "PRIVATE_THINK", { room: true, running: true })).toBe("PRIVATE_THINK");
    expect(deriveTranscriptItems(p.context("s", source, scope)).some(item => item.head.kind === "thinking")).toBe(true);
  });
});
