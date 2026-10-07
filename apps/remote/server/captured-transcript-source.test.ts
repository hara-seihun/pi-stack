import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSupervisorSchema } from "./database";
import { CapturedTranscriptSource } from "./captured-transcript-source";
import { displayContextMessage } from "./context-display";
import { forgetIndexedContext, openIndexedContext } from "./indexed-context";
import { SourceTranscripts, type SourceResult, type SourceWindow } from "./source-transcripts";
import { messageFinalizationKey } from "./sync";
import type { ToolCallItem } from "./protocol";

let db: Database, directory: string, source: CapturedTranscriptSource;
let receipts: any[], capturedAt: number;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "captured-transcript-source-"));
  db = new Database(join(directory, "remote.sqlite"));
  ensureSupervisorSchema(db);
  db.query("INSERT INTO thread_views(id) VALUES('s')").run();
  receipts = []; capturedAt = 0;
  source = makeSource();
});
afterEach(() => { forgetIndexedContext(db, "s"); db.close(); rmSync(directory, { recursive: true, force: true }); });
function makeSource() {
  return new CapturedTranscriptSource(db, () => receipts.map(receipt => ({ questionId: receipt.questionId, timestamp: receipt.timestamp, entryId: `question:${receipt.questionId}` })),
    (_id, entryId) => {
      const receipt = receipts.find(receipt => `question:${receipt.questionId}` === entryId);
      return receipt ? { ok: true, value: receipt } : { ok: false, error: { code: "stale_source", message: "Receipt changed" } };
    });
}
function value<T>(result: SourceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function capture(messages: any[], header: object = {}) {
  const context = { systemPrompt: "Captured system", tools: [], messages, ...header };
  db.query(`INSERT INTO session_contexts(session_id,captured_at,context) VALUES('s',?,?)
    ON CONFLICT(session_id) DO UPDATE SET captured_at=excluded.captured_at,context=excluded.context`).run(++capturedAt, JSON.stringify(context));
  db.query("DELETE FROM session_context_patches WHERE session_id='s'").run();
  return context;
}
function read(before: number | undefined = undefined, limit = 60): SourceWindow {
  const window = value(source.read("s", before, limit));
  if (!window) throw new Error("Captured source is missing");
  return window;
}
function transcripts() {
  return new SourceTranscripts(db, async (id, before, limit) => {
    const result = source.read(id, before, limit);
    if (!result.ok) return result;
    return result.value ? { ok: true, value: result.value } : { ok: false, error: { code: "missing", message: "No capture" } };
  }, (_id, message, image) => {
    const key = message?.role === "assistant" ? messageFinalizationKey(message) : "";
    const fact = db.query("SELECT thinking FROM message_facts WHERE session_id='s' AND finalizes_message=?").get(key) as { thinking: string } | null;
    return displayContextMessage(message, fact?.thinking, image);
  }, (id, hash) => `/images/${id}/${hash}`);
}
function thinking(message: any, text: string) {
  db.query("INSERT OR REPLACE INTO message_facts(session_id,finalizes_message,thinking) VALUES('s',?,?)")
    .run(messageFinalizationKey(message), text);
}

test("missing captured context stays unset rather than substituting a native transcript", () => {
  expect(source.read("s", undefined, 60)).toEqual({ ok: true, value: null });
});

test("tool results pair across interleaved messages and page boundaries while unrelated results remain visible", async () => {
  capture([
    { role: "user", timestamp: 1, content: "Run both" },
    { role: "assistant", timestamp: 2, content: [
      { type: "text", text: "Running" },
      { type: "toolCall", id: "a", name: "bash", arguments: { command: "one" } },
      { type: "toolCall", id: "b", name: "bash", arguments: { command: "two" } },
    ] },
    { role: "user", timestamp: 3, content: "Interleaved user" },
    { role: "toolResult", timestamp: 4, toolCallId: "a", content: [{ type: "text", text: "First exact result" }] },
    { role: "assistant", timestamp: 5, content: [{ type: "text", text: "Interleaved assistant" }] },
    { role: "toolResult", timestamp: 6, toolCallId: "b", content: [{ type: "text", text: "Second exact result" }] },
    { role: "toolResult", timestamp: 7, toolCallId: "orphan", toolName: "other", content: [{ type: "text", text: "Unpaired" }] },
  ], { tools: [{ name: "bash", description: "Shell", parameters: {} }] });
  const rows = read();
  expect(rows.total).toBe(9);
  expect(rows.records.filter(record => !record.header).map(record => record.message.timestamp)).toEqual([1, 2, 3, 5, 7]);
  expect(rows.records.find(record => record.message?.timestamp === 2)?.results.map(result => result.toolCallId)).toEqual(["a", "b"]);
  const items = transcripts();
  const page = value(await items.page("s", 6, 2));
  expect(page.items.map(item => [item.seq, item.kind])).toEqual([[4, "toolCall"], [5, "toolCall"]]);
  expect(page.items.map(item => (item as ToolCallItem).result?.preview)).toEqual(["First exact result", "Second exact result"]);
  const body = JSON.parse(value(await items.body("s", page.items[1].id))!);
  expect(body.result.content).toEqual([{ type: "text", text: "Second exact result" }]);
  const tail = value(await items.page("s", undefined, 2));
  expect(tail.items.map(item => [item.seq, item.kind])).toEqual([[7, "assistant"], [8, "tool"]]);
});

test("archived thinking restores only a missing or exactly empty FIRST thinking block", async () => {
  const messages = [
    { role: "assistant", timestamp: 1, content: [{ type: "text", text: "No thinking block" }] },
    { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "" }, { type: "thinking", thinking: "existing" }] },
    { role: "assistant", timestamp: 3, content: [{ type: "thinking", thinking: "existing" }, { type: "thinking", thinking: "" }] },
    { role: "assistant", timestamp: 4, content: [{ type: "thinking", thinking: " \n\u2000 " }, { type: "text", text: "Whitespace is not empty" }] },
    { role: "assistant", timestamp: 5, stopReason: "stop", content: [] },
  ];
  capture(messages);
  for (const message of messages) thinking(message, `restored ${message.timestamp}`);
  const window = read();
  expect(window.records.filter(record => !record.header).map(record => record.count)).toEqual([2, 2, 1, 1, 2]);
  const page = value(await transcripts().page("s", undefined, 60));
  expect(page.total).toBe(9);
  const thinkingItems = page.items.filter(item => item.kind === "thinking");
  expect(thinkingItems).toHaveLength(5);
  expect(thinkingItems.map(item => item.timestamp)).toEqual([1, 2, 2, 3, 5]);
  expect(JSON.stringify(page)).not.toContain("restored 3");
  expect(JSON.stringify(page)).not.toContain("restored 4");
  expect(page.items.at(-1)).toMatchObject({ kind: "assistant", text: "👍" });
});

test("synthetic consent receipts suppress their captured duplicate and merge by timestamp", async () => {
  capture([
    { role: "user", timestamp: 10, content: "Before" },
    { role: "user", timestamp: 20, content: "Captured duplicate must disappear", rootConsent: true, questionId: "q1" },
    { role: "assistant", timestamp: 40, content: [{ type: "text", text: "After" }] },
  ]);
  receipts = [
    { role: "user", timestamp: 20, content: "Synthetic approved", rootConsent: true, questionId: "q1" },
    { role: "user", timestamp: 30, content: "Synthetic second", rootConsent: true, questionId: "q2" },
  ];
  const window = read();
  expect(window.total).toBe(5);
  expect(window.records.filter(record => !record.header).map(record => record.message.timestamp)).toEqual([10, 20, 30, 40]);
  const page = value(await transcripts().page("s", undefined, 60));
  expect(JSON.stringify(page)).not.toContain("Captured duplicate");
  expect(page.items.filter(item => item.kind === "user").map(item => "text" in item && item.text)).toEqual(["Before", "Synthetic approved", "Synthetic second"]);
});

test("a tail page hydrates only its owning message, and a large exact body is reread on demand", async () => {
  const text = "Exact lazy body 日本".repeat(2000);
  capture([{ role: "user", timestamp: 1, content: "Earlier" }, { role: "user", timestamp: 2, content: text }]);
  const opened = openIndexedContext(db, "s");
  if (!opened.ok || !opened.value) throw new Error("Index missing");
  const index = opened.value, originalRead = index.readMessage;
  const calls: number[] = [];
  index.readMessage = (number, revision) => { calls.push(number); return originalRead(number, revision); };
  const items = transcripts();
  const page = value(await items.page("s", undefined, 1));
  expect(calls).toEqual([1]);
  expect(page.items[0]).toMatchObject({ kind: "user", textTruncated: true });
  expect(page.items[0].body).toBeUndefined();
  expect(JSON.parse(value(await items.body("s", page.items[0].id))!)).toEqual({ kind: "user", text });
  expect(calls).toEqual([1, 1]);
  expect(JSON.stringify(db.query("SELECT * FROM transcript_locators").all())).not.toContain("Exact lazy body");
});

test("append and same-layout corrections preserve generation across restart; reset makes old locators stale", async () => {
  const first = { role: "user", timestamp: 1, content: "First" };
  capture([first]);
  let items = transcripts();
  const initial = value(await items.page("s", undefined, 60));
  const oldId = initial.items[1].id;
  const second = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Second" }] };
  capture([first, second]);
  expect(read().source.generation).toBe(initial.generation);
  capture([first, { ...second, content: [{ type: "text", text: "Corrected" }] }]);
  expect(read().source.generation).toBe(initial.generation);
  forgetIndexedContext(db, "s");
  source = makeSource();
  items = transcripts();
  expect(read().source.generation).toBe(initial.generation);
  expect(JSON.parse(value(await items.body("s", oldId))!)).toEqual({ kind: "user", text: "First" });
  capture([{ role: "user", timestamp: 100, content: "Replacement branch" }]);
  expect(await items.body("s", oldId)).toMatchObject({ ok: false, error: { code: "stale_source" } });
  expect(await items.page("s", undefined, 60, initial.generation)).toMatchObject({ ok: false, error: { code: "stale_source" } });
  expect(read().source.generation).not.toBe(initial.generation);
});

test("one selected call hydrates one output even when the assistant owns more than 8 MiB of results", async () => {
  const calls = Array.from({ length: 100 }, (_, index) => ({ type: "toolCall", id: `call:${index}`, name: "read", arguments: { index } }));
  capture([
    { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Reading" }, ...calls] },
    ...calls.map((call, index) => ({ role: "toolResult", timestamp: index + 2, toolCallId: call.id,
      content: [{ type: "text", text: `${index}:` + "x".repeat(100 * 1024) }] })),
  ]);
  const opened = openIndexedContext(db, "s");
  if (!opened.ok || !opened.value) throw new Error("Index missing");
  const index = opened.value, originalRead = index.readMessage;
  const reads: number[] = [];
  index.readMessage = (number, revision) => { reads.push(number); return originalRead(number, revision); };
  const items = transcripts();
  const page = value(await items.page("s", 53, 1));
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ kind: "toolCall", callId: "call:50", seq: 52 });
  expect(reads).toEqual([0, 51]);
  const body = JSON.parse(value(await items.body("s", page.items[0].id))!);
  expect(body.result.content[0].text).toBe("50:" + "x".repeat(100 * 1024));
  expect(reads).toEqual([0, 51, 0, 51]);
  expect(db.query("SELECT COUNT(*) AS count FROM transcript_locators").get()).toEqual({ count: 1 });
  expect(source.read("s", undefined, 100)).toMatchObject({ ok: false, error: { code: "oversized" } });
});

test("a later tool-call image locator rereads its own selected result, not the first call", async () => {
  capture([
    { role: "assistant", timestamp: 1, content: [
      { type: "toolCall", id: "first", name: "read", arguments: {} },
      { type: "toolCall", id: "second", name: "read", arguments: {} },
    ] },
    { role: "toolResult", timestamp: 2, toolCallId: "first", content: [{ type: "text", text: "No image" }] },
    { role: "toolResult", timestamp: 3, toolCallId: "second", content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] },
  ]);
  const items = transcripts();
  const page = value(await items.page("s", 3, 1));
  expect(page.items[0]).toMatchObject({ kind: "toolCall", callId: "second", seq: 2 });
  const locator = db.query("SELECT image_hash,seq FROM transcript_image_locators").get() as { image_hash: string; seq: number };
  expect(locator.seq).toBe(2);
  expect(value(await items.image("s", locator.image_hash))).toEqual({ mimeType: "image/png", data: "aW1hZ2U=" });
});

test("a removed canonical context refuses native fallback until a new capture replaces it", () => {
  capture([{ role: "user", timestamp: 1, content: "Before compaction" }]);
  expect(read().total).toBe(2);
  db.query("DELETE FROM session_contexts WHERE session_id='s'").run();
  db.query("INSERT INTO captured_context_unavailable(session_id,reason) VALUES('s','Awaiting compacted model context')").run();
  expect(source.read("s", undefined, 60)).toEqual({ ok: false,
    error: { code: "captured_context_unavailable", message: "Awaiting compacted model context" } });
  capture([{ role: "user", timestamp: 2, content: "After compaction" }]);
  db.query("DELETE FROM captured_context_unavailable WHERE session_id='s'").run();
  expect(read().records.at(-1)?.message.content).toBe("After compaction");
});

test("header content corrections preserve generation; changing the ordered tool keys replaces it", () => {
  const messages = [{ role: "user", timestamp: 1, content: "Same message" }];
  const tool = { name: "read", description: "Reader", parameters: { type: "object" } };
  capture(messages, { tools: [tool] });
  const initial = read().source.generation;
  capture(messages, { tools: [tool], systemPrompt: "New system prompt" });
  const changedSystem = read().source.generation;
  expect(changedSystem).toBe(initial);
  capture(messages, { tools: [{ ...tool, parameters: { type: "array" } }], systemPrompt: "New system prompt" });
  expect(read().source.generation).toBe(initial);
  capture(messages, { tools: [tool, { name: "write", description: "Writer", parameters: {} }] });
  expect(read().source.generation).not.toBe(initial);
});
