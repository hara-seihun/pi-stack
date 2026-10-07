import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexedThreadHistory, MAX_HISTORY_RECORD_BYTES, MAX_HISTORY_INDEX_BYTES, MAX_HISTORY_INDEXES, type IndexedThreadHistory } from "../src/threads/history.mjs";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const message = (id: string, parentId: string | null, role: string, content: unknown, extra = {}) =>
  ({ id, parentId, type: "message", timestamp: "2026-10-07T00:00:00Z", message: { role, content, ...extra } });
function source(entries: unknown[], terminated = true) {
  const directory = mkdtempSync(join(tmpdir(), "native-history-index-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + (terminated ? "\n" : ""));
  return path;
}
function index(path: string, leafId?: string): IndexedThreadHistory {
  const result = indexedThreadHistory(path, leafId);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

it("indexes branch metadata only and reads one exact multichunk UTF-8 native record", () => {
  const large = "BODY_NOT_INDEXED_λ".repeat(50_000);
  const entries = [
    { type: "session", id: "header", version: 3 },
    message("root", null, "user", "Hello"),
    message("discarded", "root", "assistant", [{ type: "text", text: "Other branch" }]),
    { type: "model_change", id: "model", parentId: "root", modelId: "native" },
    message("active", "model", "assistant", [{ type: "thinking", thinking: "   " }, { type: "thinking", thinking: large },
      { type: "text", text: large }, { type: "toolCall", id: "call", name: "bash", arguments: { command: large } }]),
    message("result", "active", "toolResult", [{ type: "text", text: large }], { toolCallId: "call" }),
  ];
  const path = source(entries);
  const history = index(path);
  expect(history.source.leafId).toBe("result");
  expect(history.messages.map(record => record.id)).toEqual(["root", "active", "result"]);
  expect(history.messages[1]).toMatchObject({ role: "assistant", displayedItemCount: 3, toolCallIds: ["call"],
    blocks: [{ displayed: false }, { displayed: true }, { displayed: true }, { displayed: true, toolCallId: "call", name: "bash" }] });
  expect(history.messages[2]).toMatchObject({ displayedItemCount: 1, pairedToolResult: true, toolResultId: "call" });
  expect(JSON.stringify(history.messages)).not.toContain("BODY_NOT_INDEXED");
  expect(history.read(history.messages[1]!)).toEqual({ ok: true, value: entries[4] });
  expect(history.read({ ...history.messages[1]! })).toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
  expect(index(path, "discarded").messages.map(record => record.id)).toEqual(["root", "discarded"]);
});

it("exposes every native active-path descriptor and reads nonmessage records without retaining their bodies", () => {
  const entries = [
    { type: "session", id: "header", version: 3 },
    { type: "model_change", id: "model", parentId: null, timestamp: "2026-10-07T00:00:00Z", modelId: "MODEL_BODY_NOT_INDEXED", provider: "opaque" },
    { type: "custom", id: "receipt", parentId: "model", timestamp: 100, customType: "receipt", data: { body: "RECEIPT_BODY_NOT_INDEXED".repeat(20_000) } },
    message("words", "receipt", "user", "MESSAGE_BODY_NOT_INDEXED"),
    { type: "thinking_level_change", id: "setting", parentId: "words", thinkingLevel: "high" },
    message("other-branch", "model", "user", "OTHER_BRANCH"),
  ];
  const path = source(entries);
  const history = index(path, "setting");
  expect(history.entries.map(record => record.id)).toEqual(["model", "receipt", "words", "setting"]);
  expect(history.messages.map(record => record.id)).toEqual(["words"]);
  expect(history.entries[2]).toBe(history.messages[0]);
  expect(history.entries[0]).toMatchObject({ type: "model_change", timestamp: Date.parse("2026-10-07T00:00:00Z") });
  expect(history.entries[1]).toMatchObject({ type: "custom", customType: "receipt", timestamp: 100 });
  expect(history.entries[3]).toMatchObject({ timestamp: null });
  expect(JSON.stringify(history.entries)).not.toMatch(/BODY_NOT_INDEXED|opaque|thinkingLevel/);
  for (const [index, descriptor] of history.entries.entries()) expect(history.read(descriptor)).toEqual({ ok: true, value: entries[index + 1] });
  expect(history.read(history.messages[0]!)).toEqual({ ok: true, value: entries[3] });
  const other = index(path, "other-branch");
  expect(other.entries.map(record => record.id)).toEqual(["model", "other-branch"]);
  expect(other.read(history.entries[1]!)).toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
  appendFileSync(path, JSON.stringify({ type: "custom", customType: "thread_input", id: "new-receipt", parentId: "setting", timestamp: 200, data: "APPENDED_BODY" }) + "\n");
  const next = index(path);
  expect(next.source.generation).toBe(history.source.generation);
  expect(next.entries.map(record => record.id)).toEqual(["model", "receipt", "words", "setting", "new-receipt"]);
  expect(next.entries.at(-1)).toMatchObject({ customType: "thread_input" });
  expect(history.read(history.entries[0]!)).toMatchObject({ ok: false, error: { code: "stale-source" } });
});

it("memoizes unchanged full snapshots per leaf without reconstructing branches or reader closures", () => {
  const path = source([message("root", null, "user", "Root"), message("old", "root", "assistant", []), message("latest", "root", "assistant", [])]);
  const current = index(path), old = index(path, "old");
  const reverse = vi.spyOn(Array.prototype, "reverse");
  const values = Array.from({ length: 10 }, () => [index(path), index(path, "old")]);
  const reverseCalls = reverse.mock.calls.length;
  reverse.mockRestore();
  expect(reverseCalls).toBe(0);
  for (const [sameCurrent, sameOld] of values) {
    expect(sameCurrent).toBe(current);
    expect(sameCurrent!.read).toBe(current.read);
    expect(sameOld).toBe(old);
    expect(sameOld!.entries).toBe(old.entries);
  }
  appendFileSync(path, JSON.stringify(message("appended", "latest", "user", "New")) + "\n");
  const next = index(path);
  expect(next).not.toBe(current);
  expect(next.source.generation).toBe(current.source.generation);
  expect(index(path, "old")).not.toBe(old);
  expect(current.read(current.entries[0]!)).toMatchObject({ ok: false, error: { code: "stale-source" } });
});

it("bounds per-file memoized leaf snapshots with access-LRU eviction", () => {
  const path = source([message("root", null, "user", "Root"), ...Array.from({ length: MAX_HISTORY_INDEXES + 1 }, (_, i) => message(`branch-${i}`, "root", "user", "Branch"))]);
  const first = index(path, "branch-0"), second = index(path, "branch-1");
  for (let i = 2; i < MAX_HISTORY_INDEXES; i++) index(path, `branch-${i}`);
  expect(index(path, "branch-0")).toBe(first);
  index(path, `branch-${MAX_HISTORY_INDEXES}`);
  expect(index(path, "branch-0")).toBe(first);
  expect(index(path, "branch-1")).not.toBe(second);
});

it("charges retained branch snapshot arrays and descriptor ownership sets to the byte budget", () => {
  const records = Array.from({ length: 30_000 }, (_, i) => message(`node-${i}`, i ? `node-${i - 1}` : null, "user", "body"));
  const path = source(records);
  const first = index(path, "node-29999");
  for (let i = 1; i <= 20; i++) index(path, `node-${29999 - i}`);
  const refreshed = index(path, "node-29999");
  expect(refreshed).not.toBe(first);
  expect(refreshed.source.generation).toBe(first.source.generation);
  expect(refreshed.entries.length).toBe(30_000);
});

it("reuses unchanged metadata, parses only appended records and fences old readers", () => {
  const path = source([message("a", null, "user", "A")]);
  const first = index(path);
  expect(index(path).messages[0]).toBe(first.messages[0]);
  const parse = vi.spyOn(JSON, "parse");
  appendFileSync(path, JSON.stringify(message("b", "a", "assistant", [{ type: "text", text: "B" }])) + "\n");
  const next = index(path);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(next.source.generation).toBe(first.source.generation);
  expect(next.source.revision).not.toBe(first.source.revision);
  expect(next.messages[0]).toBe(first.messages[0]);
  expect(first.read(first.messages[0]!)).toMatchObject({ ok: false, error: { code: "stale-source" } });
  expect(next.read(next.messages[1]!)).toMatchObject({ ok: true, value: { id: "b" } });
});

it("detects rewrites even when followed by growth and does not reuse stale branch metadata", () => {
  const path = source([message("a", null, "user", "A")]);
  const first = index(path);
  writeFileSync(path, [message("z", null, "user", "Z"), message("b", "z", "user", "B")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const next = index(path);
  expect(next.source.generation).not.toBe(first.source.generation);
  expect(next.messages.map(record => record.id)).toEqual(["z", "b"]);
  writeFileSync(path, JSON.stringify(message("x", null, "user", "X")) + "\n");
  expect(index(path).source.generation).not.toBe(next.source.generation);
});

it("resumes a valid unterminated last record without duplication", () => {
  const path = source([message("a", null, "user", "λ")], false);
  const first = index(path);
  appendFileSync(path, "\n" + JSON.stringify(message("b", "a", "user", "β")));
  const next = index(path);
  expect(next.source.generation).toBe(first.source.generation);
  expect(next.messages.map(record => record.id)).toEqual(["a", "b"]);
  expect(next.messages.map(record => record.line)).toEqual([1, 2]);
  expect(next.read(next.messages[1]!)).toMatchObject({ ok: true, value: { id: "b" } });
});

it("returns explicit missing, invalid, duplicate, oversized and invalid-branch errors", () => {
  const path = source([]);
  expect(index(path).messages).toEqual([]);
  expect(index(path).source.leafId).toBeNull();
  expect(indexedThreadHistory(path, "missing")).toMatchObject({ ok: false, error: { code: "invalid-branch" } });
  expect(indexedThreadHistory(path + ".missing")).toMatchObject({ ok: false, error: { code: "missing" } });
  for (const text of ["{\n", "{", '"not an entry"\n', JSON.stringify(message("a", null, "assistant", [{ type: "toolCall" }])) + "\n", JSON.stringify({ type: "custom", id: "receipt", parentId: null, timestamp: {} }) + "\n"]) {
    writeFileSync(path, text);
    expect(indexedThreadHistory(path)).toMatchObject({ ok: false, error: { code: "invalid-record", line: 1, offset: 0 } });
  }
  writeFileSync(path, "x".repeat(MAX_HISTORY_RECORD_BYTES + 1));
  expect(indexedThreadHistory(path)).toMatchObject({ ok: false, error: { code: "oversized-record", limit: MAX_HISTORY_RECORD_BYTES } });
  const missingParent = source([message("a", "absent", "user", "A")]);
  expect(indexedThreadHistory(missingParent)).toMatchObject({ ok: false, error: { code: "invalid-branch" } });
  const cycle = source([message("a", "b", "user", "A"), message("b", "a", "user", "B")]);
  expect(indexedThreadHistory(cycle)).toMatchObject({ ok: false, error: { code: "invalid-branch" } });
  const duplicate = source([message("a", null, "user", "A"), message("a", null, "user", "B")]);
  expect(indexedThreadHistory(duplicate)).toMatchObject({ ok: false, error: { code: "invalid-record", entryId: "a" } });
});

it("bounds cached index count using actual access order", () => {
  const paths = Array.from({ length: MAX_HISTORY_INDEXES }, (_, i) => source([message(`entry-${i}`, null, "user", "body")]));
  const first = index(paths[0]!);
  const second = index(paths[1]!);
  for (const path of paths.slice(2)) index(path);
  expect(index(paths[0]!).source.generation).toBe(first.source.generation);
  index(source([message("new", null, "user", "body")]));
  expect(index(paths[0]!).source.generation).toBe(first.source.generation);
  expect(index(paths[1]!).source.generation).not.toBe(second.source.generation);
});

it("bounds global cached metadata bytes and rejects an individually oversized index", () => {
  const blocks = Array.from({ length: 80_000 }, () => ({ type: "text" }));
  const paths = Array.from({ length: 3 }, (_, i) => source([message(`big-${i}`, null, "assistant", blocks)]));
  const firstGeneration = index(paths[0]!).source.generation;
  index(paths[1]!);
  index(paths[2]!);
  expect(index(paths[0]!).source.generation).not.toBe(firstGeneration);
  const oversized = source([message("oversized", null, "assistant", Array.from({ length: 300_000 }, () => ({ type: "text" })))]);
  expect(indexedThreadHistory(oversized)).toMatchObject({ ok: false, error: { code: "oversized-index", limit: MAX_HISTORY_INDEX_BYTES } });
  writeFileSync(oversized, JSON.stringify(message("repaired", null, "user", "Small")) + "\n");
  expect(index(oversized).messages.map(record => record.id)).toEqual(["repaired"]);
});

it("counts the successful empty-answer projection without counting collapsed blank text blocks", () => {
  const examples = [
    { content: [], stopReason: "stop", count: 1 },
    { content: [], stopReason: "toolUse", count: 0 },
    { content: [{ type: "thinking", thinking: " " }], stopReason: "stop", count: 0 },
    { content: [{ type: "thinking", thinking: "reason" }], stopReason: "stop", count: 1 },
    { content: [{ type: "text", text: " " }, { type: "text", text: "" }], stopReason: "stop", count: 1 },
    { content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: " " }, { type: "text", text: "" }], stopReason: "stop", count: 2 },
    { content: [{ type: "text", text: "answer" }, { type: "text", text: "" }], stopReason: "stop", count: 2 },
  ];
  const path = source(examples.map((example, index) => message(String(index), index ? String(index - 1) : null,
    "assistant", example.content, { stopReason: example.stopReason })));
  expect(index(path).messages.map(record => record.displayedItemCount)).toEqual(examples.map(example => example.count));
});

it("preserves standalone display counts, receipt metadata and branch-local pairing order", () => {
  const path = source([
    message("answer", null, "user", "RECEIPT_BODY", { rootConsent: true, questionId: "q1" }),
    message("early", "answer", "toolResult", [], { toolCallId: "c" }),
    message("call", "early", "assistant", [{ type: "toolCall", id: "c", name: "bash", arguments: {} }]),
    message("error", "call", "assistant", [], { errorMessage: "ERROR_BODY" }),
    { type: "custom_message", id: "custom", parentId: "error", customType: "notice", content: "CUSTOM_BODY" },
  ]);
  const history = index(path);
  expect(history.messages[0]).toMatchObject({ rootConsent: true, questionId: "q1", displayedItemCount: 1 });
  expect(history.messages[1]!.pairedToolResult).toBeUndefined();
  expect(history.messages.map(record => record.displayedItemCount)).toEqual([1, 1, 1, 1, 1]);
  expect(history.messages[4]!.role).toBe("custom");
  expect(JSON.stringify(history.messages)).not.toMatch(/RECEIPT_BODY|ERROR_BODY|CUSTOM_BODY/);
});
