import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceTranscripts, type ReadSourceWindow, type SourceRecord, type SourceResult, type SourceWindow } from "./source-transcripts";
import { displayContextMessage } from "./context-display";
import { INLINE_BODY_LIMIT, PREVIEW_CHARACTERS } from "./transcript-items";
import { sha256 } from "./sync";
import type { ToolCallItem } from "./protocol";

const dbs: Database[] = [], dirs: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function database(path = ":memory:") { const db = new Database(path); dbs.push(db); return db; }
function value<T>(result: SourceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const imageUrl = (sessionId: string, hash: string) => `/v1/sessions/${sessionId}/context/images/${hash}`;
const project = (_sessionId: string, message: any, image: any) => displayContextMessage(message, image);
function fixture(records: SourceRecord[]) {
  const calls: { before: number | undefined; limit: number; loaded: string[] }[] = [];
  let source = { revision: "r1", generation: "g1", context: "native" };
  let failure: { code: string; message: string } | undefined;
  const total = records.reduce((end, record) => Math.max(end, record.seq + record.count), 0);
  const read: ReadSourceWindow = async (_sessionId, before, limit) => {
    if (failure) return { ok: false, error: failure };
    const end = before === undefined ? total : Math.min(before, total);
    const from = Math.max(0, end - limit);
    const selected = records.filter(record => record.seq < end && record.seq + record.count > from);
    calls.push({ before, limit, loaded: selected.map(record => record.entryId) });
    return { ok: true, value: { source, total, records: structuredClone(selected) } satisfies SourceWindow };
  };
  return { read, calls, replace: () => { source = { ...source, generation: "g2", revision: "r2" }; },
    fail: (error: { code: string; message: string }) => { failure = error; } };
}

const user = (seq: number, entryId: string, text: string): SourceRecord =>
  ({ seq, count: 1, entryId, message: { role: "user", timestamp: seq + 1, content: text }, results: [] });

test("cold pages preserve global item offsets and tool pairing outside the selected message window", async () => {
  const toolResult = { role: "toolResult", toolCallId: "cross-page", timestamp: 30, content: [{ type: "text", text: "Exact separate source result" }] };
  const record: SourceRecord = { seq: 3, count: 3, entryId: "assistant", message: { role: "assistant", timestamp: 20, content: [
    { type: "thinking", thinking: "Reasoning" }, { type: "toolCall", id: "cross-page", name: "bash", arguments: { command: "pwd" } },
    { type: "text", text: "Finished" },
  ] }, results: [toolResult] };
  const source = fixture([
    { seq: 0, count: 2, entryId: "header", message: null, results: [], header: { systemPrompt: "Exact system", tools: [{ name: "bash", description: "shell", parameters: {} }] } },
    user(2, "user", "Run it"), record,
  ]);
  const transcripts = new SourceTranscripts(database(), source.read, project, imageUrl);
  const tail = value(await transcripts.page("s", undefined, 1));
  expect(tail.total).toBe(6);
  expect(tail.items.map(item => [item.seq, item.kind])).toEqual([[5, "assistant"]]);
  expect(source.calls[0]!.loaded).toEqual(["assistant"]);
  const page = value(await transcripts.page("s", 5, 1));
  expect(page.items.map(item => [item.seq, item.kind])).toEqual([[4, "toolCall"]]);
  expect((page.items[0] as ToolCallItem).result?.preview).toBe("Exact separate source result");
  const body = JSON.parse(value(await transcripts.body("s", page.items[0]!.id))!);
  expect(body.result.content).toEqual(toolResult.content);
  expect(source.calls.at(-1)).toEqual({ before: 5, limit: 1, loaded: ["assistant"] });
  const header = value(await transcripts.page("s", 2, 2));
  expect(header.items.map(item => [item.seq, item.kind])).toEqual([[0, "system"], [1, "tool"]]);
});

test("large heads are bounded while exact bodies are reread lazily; only locators survive database restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "source-transcripts-")); dirs.push(dir);
  const path = join(dir, "transcripts.sqlite");
  const text = "NATIVE_BODY_λ".repeat(20_000);
  const source = fixture([user(0, "small", "Earlier"), user(1, "large", text)]);
  let db = database(path);
  db.exec("CREATE TABLE transcript_items(body TEXT); INSERT INTO transcript_items VALUES('OLD_BODY'); CREATE TABLE transcript_generations(context TEXT)");
  let transcripts = new SourceTranscripts(db, source.read, project, imageUrl);
  const page = value(await transcripts.page("s", undefined, 1));
  const head = page.items[0]!;
  expect(head.kind).toBe("user");
  expect("textTruncated" in head && head.textTruncated).toBe(true);
  expect("text" in head && head.text.length).toBe(PREVIEW_CHARACTERS + 1);
  expect(head.size).toBeGreaterThan(INLINE_BODY_LIMIT);
  expect(head.body).toBeUndefined();
  expect(source.calls).toEqual([{ before: undefined, limit: 1, loaded: ["large"] }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([
    { name: "transcript_image_locators" }, { name: "transcript_locators" },
  ]);
  const rows = db.query("SELECT * FROM transcript_locators").all();
  expect(JSON.stringify(rows)).not.toContain("NATIVE_BODY");
  db.close(); dbs.splice(dbs.indexOf(db), 1);
  db = database(path);
  transcripts = new SourceTranscripts(db, source.read, project, imageUrl);
  expect(JSON.parse(value(await transcripts.body("s", head.id))!)).toEqual({ kind: "user", text });
  expect(source.calls.at(-1)).toEqual({ before: 2, limit: 1, loaded: ["large"] });
  transcripts.forget("s");
  expect(value(await transcripts.body("s", head.id))).toBeUndefined();
});

test("image bytes remain source-owned and are fetched from one record after restart", async () => {
  const image = { type: "image", mimeType: "image/png", data: "SOURCE_IMAGE_BYTES".repeat(100_000) };
  const source = fixture([user(0, "before", "Before"), { seq: 1, count: 1, entryId: "image", message: { role: "user", timestamp: 9, content: [image] }, results: [] }]);
  const db = database();
  let transcripts = new SourceTranscripts(db, source.read, project, imageUrl);
  const page = value(await transcripts.page("s", undefined, 1));
  const hash = sha256(`${image.mimeType}\0${image.data}`);
  expect(JSON.stringify(page)).toContain(imageUrl("s", hash));
  expect(JSON.stringify(page)).not.toContain("SOURCE_IMAGE_BYTES");
  expect(JSON.stringify(db.query("SELECT * FROM transcript_image_locators").all())).not.toContain("SOURCE_IMAGE_BYTES");
  transcripts = new SourceTranscripts(db, source.read, project, imageUrl);
  expect(value(await transcripts.image("s", hash))).toEqual({ mimeType: image.mimeType, data: image.data });
  expect(source.calls.at(-1)).toEqual({ before: 2, limit: 1, loaded: ["image"] });
});

test("generation replacement rejects saved body, image and page locators explicitly", async () => {
  const image = { type: "image", mimeType: "image/png", data: "source" };
  const source = fixture([{ seq: 0, count: 1, entryId: "image", message: { role: "user", content: [image] }, results: [] }]);
  const transcripts = new SourceTranscripts(database(), source.read, project, imageUrl);
  const page = value(await transcripts.page("s", undefined, 1));
  source.replace();
  expect(await transcripts.page("s", undefined, 1, page.generation)).toMatchObject({ ok: false, error: { code: "stale_source" } });
  expect(await transcripts.body("s", page.items[0]!.id)).toMatchObject({ ok: false, error: { code: "stale_source" } });
  expect(await transcripts.image("s", sha256(`${image.mimeType}\0${image.data}`))).toMatchObject({ ok: false, error: { code: "stale_source" } });
});

test("unchanged pages and lazy bodies do not rewrite durable locators", async () => {
  const source = fixture([user(0, "before", "Before"), {
    seq: 1, count: 1, entryId: "image", results: [],
    message: { role: "user", timestamp: 9, content: [{ type: "image", mimeType: "image/png", data: "source" }] },
  }]);
  const db = database();
  const transcripts = new SourceTranscripts(db, source.read, project, imageUrl);
  const changes = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
  const first = value(await transcripts.page("s", undefined, 2));
  const written = changes();
  expect(written).toBe(3);
  expect(value(await transcripts.page("s", undefined, 2))).toEqual(first);
  expect(value(await transcripts.body("s", first.items[1]!.id))).toBeDefined();
  expect(changes()).toBe(written);
  source.replace();
  const replaced = value(await transcripts.page("s", undefined, 2));
  expect(replaced.generation).toBe("g2");
  expect(changes()).toBe(written + 3);
});

test("a failed page leaves the prior generation intact without partially committing new locators", async () => {
  const db = database();
  const source = fixture([user(0, "saved", "Original")]);
  const transcripts = new SourceTranscripts(db, source.read, project, imageUrl);
  value(await transcripts.page("s", undefined, 1));
  const original = db.query("SELECT * FROM transcript_locators").all();
  const invalid = fixture([user(0, "new", "Changed"), { ...user(1, "bad", "Malformed"), count: 2 }]);
  invalid.replace();
  const failed = new SourceTranscripts(db, invalid.read, project, imageUrl);
  expect(await failed.page("s", undefined, 3)).toMatchObject({ ok: false, error: { code: "invalid_record" } });
  expect(db.query("SELECT * FROM transcript_locators").all()).toEqual(original);
});

test("successful empty assistant projection agrees with source counts including collapsed blank text", async () => {
  const source = fixture([
    { seq: 0, count: 1, entryId: "empty", message: { role: "assistant", stopReason: "stop", content: [] }, results: [] },
    { seq: 1, count: 2, entryId: "blank", message: { role: "assistant", stopReason: "stop", content: [
      { type: "thinking", thinking: "reason" }, { type: "text", text: " " }, { type: "text", text: "" },
    ] }, results: [] },
  ]);
  const transcripts = new SourceTranscripts(database(), source.read, project, imageUrl);
  const page = value(await transcripts.page("s", undefined, 3));
  expect(page.items.map(item => [item.seq, item.kind])).toEqual([[0, "assistant"], [1, "thinking"], [2, "assistant"]]);
  expect(page.items.filter(item => item.kind === "assistant").map(item => "text" in item && item.text)).toEqual(["👍", "👍"]);
});

test("typed source failures and malformed display counts remain errors, not empty success windows", async () => {
  const source = fixture([user(0, "one", "One")]);
  const transcripts = new SourceTranscripts(database(), source.read, project, imageUrl);
  source.fail({ code: "oversized-record", message: "Native record exceeds source cap" });
  expect(await transcripts.page("s", undefined, 1)).toEqual({ ok: false, error: { code: "oversized-record", message: "Native record exceeds source cap" } });
  const malformed = fixture([{ ...user(0, "bad-count", "One"), count: 2 }]);
  const invalid = new SourceTranscripts(database(), malformed.read, project, imageUrl);
  expect(await invalid.page("s", undefined, 1)).toMatchObject({ ok: false, error: { code: "invalid_record" } });
});
