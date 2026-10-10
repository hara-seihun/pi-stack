import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexedThreadHistory, withIndexedThreadHistory, visibleThreadHistory, MAX_HISTORY_RECORD_BYTES, MAX_HISTORY_INDEX_BYTES, MAX_HISTORY_INDEXES, type IndexedThreadHistory, type IndexedThreadHistoryOptions } from "../src/threads/history.mjs";
import { formatThreadMessage } from "../src/threads/message-format.js";

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
function index(path: string, leafId?: string, options?: IndexedThreadHistoryOptions): IndexedThreadHistory {
  const result = indexedThreadHistory(path, leafId, options);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const managerVisibility = { managerWakeVisibility: true };
function wakeText(source: "explicit" | "notification" = "notification", id = "thread-wake:generation:1000") {
  return formatThreadMessage({ id, threadId: "manager", senderId: "manager", senderName: "Manager",
    priority: "normal", source, text: "Scheduled wake check: WAKE_BODY_NOT_INDEXED", delivery: "steer", createdAt: 1, state: "queued" },
  "Scheduled wake check: WAKE_BODY_NOT_INDEXED");
}

it("restarts the entire window after append between indexing and reads without mixing revisions", () => {
  const first = message("a", null, "user", "A"), second = message("b", "a", "assistant", "B");
  const path = source([first]);
  let attempts = 0;
  let escaped: IndexedThreadHistory | undefined;
  const result = withIndexedThreadHistory(path, undefined, undefined, history => {
    attempts++;
    escaped = history;
    if (attempts === 1) appendFileSync(path, JSON.stringify(second) + "\n");
    expect(history.read({ ...history.entries[0]! })).toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
    return { source: history.source, records: history.entries.map(descriptor => history.read(descriptor)) };
  });
  expect(attempts).toBe(2);
  expect(result).toEqual({ ok: true, value: { source: index(path).source, records: [{ ok: true, value: first }, { ok: true, value: second }] } });
  expect(escaped!.read(escaped!.entries[0]!)).toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
});

it("rejects replacement and rewritten records instead of retrying them as an append", () => {
  for (const replace of [false, true]) {
    const path = source([message("a", null, "user", "A")]);
    let attempts = 0;
    const result = withIndexedThreadHistory(path, undefined, undefined, history => {
      attempts++;
      const target = replace ? path + ".replacement" : path;
      writeFileSync(target, JSON.stringify(message("a", null, "user", "Changed")) + "\n");
      if (replace) renameSync(target, path);
      if (!replace) expect(history.read(history.entries[0]!)).toMatchObject({ ok: false, error: { code: "stale-source" } });
      return history.read(history.entries[0]!);
    });
    expect(result).toMatchObject({ ok: false, error: { code: "stale-source", message: "Session was rewritten or replaced during window reading" } });
    expect(attempts).toBe(1);
  }
});

it("bounds sustained window mutation and returns an explicit conflict source", () => {
  const path = source([message("a", null, "user", "A")]);
  let attempts = 0;
  const result = withIndexedThreadHistory(path, undefined, undefined, history => {
    appendFileSync(path, JSON.stringify(message(`next-${++attempts}`, history.source.leafId, "user", "New")) + "\n");
    return history.read(history.entries[0]!);
  });
  expect(attempts).toBe(3);
  expect(result).toMatchObject({ ok: false, error: { code: "stale-source" } });
});

it("counts signed narration as text while retaining exact source and branch paging identity", () => {
  const field = (number: number, bytes: Buffer): Buffer => Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
  const signature = (channel: string) => field(2, field(1, field(8, Buffer.from(channel)))).toString("base64");
  const entries = [
    message("wake", null, "user", wakeText()),
    message("report", "wake", "assistant", [
      { type: "thinking", thinking: "Visible narration", thinkingSignature: signature("narration") },
      { type: "thinking", thinking: "Private reasoning", thinkingSignature: signature("thinking") },
      { type: "toolCall", id: "wait", name: "thread_wait", arguments: {} },
    ], { api: "anthropic-messages", stopReason: "toolUse" }),
    message("blank", "report", "assistant", [{ type: "thinking", thinking: "", thinkingSignature: signature("narration") }], { api: "anthropic-messages", stopReason: "stop" }),
  ];
  const path = source(entries);
  const native = index(path), manager = index(path, undefined, managerVisibility);
  expect(native.messages.map(record => record.displayedItemCount)).toEqual([1, 3, 0]);
  expect(manager.messages.map(record => record.monoVisibility)).toEqual(["hidden", "visible", "visible"]);
  expect(native.messages[1]!.blocks.map(block => block.type)).toEqual(["text", "thinking", "toolCall"]);
  expect(manager.source).toEqual(native.source);
  expect(native.read(native.messages[1]!)).toEqual({ ok: true, value: entries[1] });
  const visible = visibleThreadHistory(path);
  expect(visible[1].message.content).toEqual([{ type: "text", text: "Visible narration" }, { type: "toolCall", id: "wait", name: "thread_wait", arguments: {} }]);
  expect(JSON.stringify(visible)).not.toContain("Signature");
  expect(JSON.stringify(native.messages)).not.toContain(signature("narration"));
});

it("hides the entire quiet manager wake turn without changing the native source or other thread views", () => {
  const entries = [
    message("root", null, "user", "Human input"),
    message("normal", "root", "assistant", [{ type: "text", text: "Normal answer" }]),
    message("wake", "normal", "user", [{ type: "text", text: wakeText() }]),
    message("call", "wake", "assistant", [{ type: "thinking", thinking: "INTERNAL_BODY_NOT_INDEXED" },
      { type: "toolCall", id: "c", name: "bash", arguments: {} }]),
    message("result", "call", "toolResult", [{ type: "text", text: "Tool output is not assistant text" }], { toolCallId: "c" }),
    message("quiet", "result", "assistant", [{ type: "thinking", thinking: "reason" }, { type: "text", text: " \n" }], { stopReason: "stop" }),
    { type: "custom", id: "settled", parentId: "quiet", customType: "thread_settled", data: { workId: "wake" } },
    message("human", "settled", "user", "Next human turn"),
    message("answer", "human", "assistant", [{ type: "text", text: "Next answer" }]),
  ];
  const path = source(entries);
  const native = index(path), manager = index(path, undefined, managerVisibility);
  expect(manager.entries.map(record => record.monoVisibility)).toEqual([undefined, undefined, "hidden", "hidden", "hidden", "hidden", "hidden", undefined, undefined]);
  expect(manager.messages[4]).toMatchObject({ monoVisibility: "hidden", pairedToolResult: true });
  expect(manager.messages.map(record => record.displayedItemCount)).toEqual(native.messages.map(record => record.displayedItemCount));
  expect(native.entries.every(record => record.monoVisibility === undefined)).toBe(true);
  expect(index(path)).toBe(native);
  expect(index(path, undefined, managerVisibility)).toBe(manager);
  expect(index(path, undefined, { managerWakeVisibility: false })).toBe(native);
  expect(manager.source).toEqual(native.source);
  expect(JSON.stringify(manager.entries)).not.toMatch(/WAKE_BODY_NOT_INDEXED|INTERNAL_BODY_NOT_INDEXED/);
  for (const [ordinal, descriptor] of manager.entries.entries()) expect(manager.read(descriptor)).toEqual({ ok: true, value: entries[ordinal] });
  expect(native.read(manager.messages[2]!)).toMatchObject({ ok: false, error: { code: "invalid-descriptor" } });
});

it("reclassifies a wake turn after native append while preserving branch-local visibility and fencing old readers", () => {
  const path = source([
    message("wake", null, "user", wakeText("explicit")),
    message("thinking", "wake", "assistant", [{ type: "thinking", thinking: "reason" }]),
    message("quiet", "thinking", "assistant", [], { stopReason: "stop" }),
  ]);
  const quiet = index(path, undefined, managerVisibility);
  expect(quiet.messages.map(record => record.monoVisibility)).toEqual(["hidden", "hidden", "hidden"]);
  appendFileSync(path, JSON.stringify(message("report", "thinking", "assistant", [{ type: "text", text: "Action required." }], { stopReason: "stop" })) + "\n");
  const reported = index(path, undefined, managerVisibility);
  expect(reported.messages.map(record => record.id)).toEqual(["wake", "thinking", "report"]);
  expect(reported.messages.map(record => record.monoVisibility)).toEqual(["hidden", "visible", "visible"]);
  expect(reported.source.generation).toBe(quiet.source.generation);
  expect(reported.source.revision).not.toBe(quiet.source.revision);
  expect(index(path, "quiet", managerVisibility).messages.map(record => record.monoVisibility)).toEqual(["hidden", "hidden", "hidden"]);
  expect(quiet.read(quiet.messages[0]!)).toMatchObject({ ok: false, error: { code: "stale-source" } });
  appendFileSync(path, JSON.stringify(message("new-wake", "report", "user", wakeText())) + "\n"
    + JSON.stringify(message("error", "new-wake", "assistant", [], { errorMessage: "An error is not human-facing text" })) + "\n");
  expect(index(path, undefined, managerVisibility).messages.map(record => record.monoVisibility)).toEqual(["hidden", "visible", "visible", "hidden", "hidden"]);
});

it("only treats complete wake transport identities as manager wake inputs", () => {
  const notWakes = [
    "Human text mentioning thread-wake:generation:1000",
    wakeText("notification", "other-notification"),
    wakeText().replace('"source":"notification"', '"source":"unknown"'),
    wakeText().replace('"recipientThreadId":"manager",', ""),
    wakeText().replace('"messageId":"thread-wake:generation:1000",', ""),
    wakeText().replace("\n</agent_message>", ""),
    wakeText().replace('"messageId":', '"messageId" BROKEN:'),
  ];
  const path = source(notWakes.flatMap((text, i) => [message(`input-${i}`, i ? `answer-${i - 1}` : null, "user", text),
    message(`answer-${i}`, `input-${i}`, "assistant", [{ type: "thinking", thinking: "reason" }])]));
  expect(index(path, undefined, managerVisibility).entries.every(record => record.monoVisibility === undefined)).toBe(true);
});

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

it("counts authored assistant content without manufacturing items for empty replies", () => {
  const examples = [
    { content: [], stopReason: "stop", count: 0 },
    { content: " \n", stopReason: "stop", count: 0 },
    { content: [], stopReason: "toolUse", count: 0 },
    { content: [{ type: "thinking", thinking: " " }], stopReason: "stop", count: 0 },
    { content: [{ type: "thinking", thinking: "reason" }], stopReason: "stop", count: 1 },
    { content: [{ type: "text", text: " " }, { type: "text", text: "" }], stopReason: "stop", count: 0 },
    { content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: " " }, { type: "text", text: "" }], stopReason: "stop", count: 1 },
    { content: [{ type: "text", text: "answer" }, { type: "text", text: "" }], stopReason: "stop", count: 1 },
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
