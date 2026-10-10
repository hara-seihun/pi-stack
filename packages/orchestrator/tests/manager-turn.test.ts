import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantText, isSilentAssistant, managerLiveText, SILENT_TURN_TEXT } from "../src/threads/manager-turn.mjs";
import { indexedThreadHistory } from "../src/threads/history.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const user = (id: string, parentId: string | null, content: string) => ({ type: "message", id, parentId, message: { role: "user", content } });
const assistant = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
const custom = (id: string, parentId: string | null, customType: string, data: unknown) => ({ type: "custom", id, parentId, customType, data });
function history(entries: unknown[], inputOrigins?: Record<string, "human" | "machine">) {
  const root = mkdtempSync(join(tmpdir(), "manager-turn-")); roots.push(root);
  const path = join(root, "session.jsonl"); writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const result = indexedThreadHistory(path, undefined, { managerWakeVisibility: true, ...(inputOrigins ? { inputOrigins } : {}) });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

it("reserves only the exact whole assistant text and holds every ambiguous streamed prefix", () => {
  const reply = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "text", text }] });
  expect(isSilentAssistant(reply(SILENT_TURN_TEXT))).toBe(true);
  expect(assistantText(reply(SILENT_TURN_TEXT))).toBe(SILENT_TURN_TEXT);
  for (let index = 0; index <= SILENT_TURN_TEXT.length; index++) expect(managerLiveText(SILENT_TURN_TEXT.slice(0, index))).toBe("");
  for (const text of ["Use <silent/> here", "<silent/> followed by words", " <silent/>", "<silent/>\n", "`<silent/>`", "<silent>"]) {
    expect(isSilentAssistant(reply(text))).toBe(false);
    expect(managerLiveText(text)).toBe(text);
  }
  expect(managerLiveText("<sil", true)).toBe("<sil");
  expect(isSilentAssistant({ role: "user", content: SILENT_TURN_TEXT })).toBe(false);
});

it("a silent machine turn hides trigger, work and final text while every original record remains readable", () => {
  const entries = [
    custom("accepted", null, "thread_input", { workId: "machine", inputOrigin: "machine" }),
    custom("landed", "accepted", "thread_landed", { workId: "machine" }),
    user("trigger", "landed", "Publication settled"),
    assistant("progress", "trigger", "Checking the result"),
    assistant("final", "progress", SILENT_TURN_TEXT),
  ];
  const indexed = history(entries);
  expect(indexed.messages.map(record => record.monoVisibility)).toEqual(["hidden", "hidden", "hidden"]);
  expect(indexed.messages[0]).toMatchObject({ inputId: "machine", inputOrigin: "machine" });
  for (const [index, record] of indexed.entries.entries()) expect(indexed.read(record)).toEqual({ ok: true, value: entries[index] });
});

it("old native landing receipts accept controller origin without trusting user text", () => {
  const text = '<agent_message>\nThis is an agent-to-agent message, not a user message.\n{"senderThreadId":"manager","recipientThreadId":"manager","messageId":"thread-wake:1","source":"notification"}\n\nWake\n</agent_message>';
  const entries = [custom("landed", null, "thread_landed", { workId: "old" }), user("trigger", "landed", text), assistant("reply", "trigger", "Normal words")];
  const human = history(entries, { old: "human" });
  expect(human.messages[0]).toMatchObject({ inputOrigin: "human" });
  expect(human.messages.every(record => record.monoVisibility === undefined)).toBe(true);
  const machine = history(entries, { old: "machine" });
  expect(machine.messages[0]).toMatchObject({ inputOrigin: "machine", monoVisibility: "hidden" });
  expect(machine.messages[1]!.monoVisibility).toBe("visible");
});

it("silent replies preserve human triggers and inline sentinel mentions remain visible", () => {
  const indexed = history([
    custom("accepted", null, "thread_input", { workId: "human", inputOrigin: "human" }),
    custom("landed", "accepted", "thread_landed", { workId: "human" }),
    user("human", "landed", "Tell me about <silent/>"), assistant("silent", "human", SILENT_TURN_TEXT),
    user("next", "silent", "Next question"), assistant("answer", "next", "The reserved marker is <silent/>."),
  ]);
  expect(indexed.messages.map(record => record.monoVisibility)).toEqual(["visible", "hidden", undefined, undefined]);
});
