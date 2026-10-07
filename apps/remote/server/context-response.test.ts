import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextResponse, type ReadRawContext } from "./context-response";
import { ensureSupervisorSchema } from "./database";
import { forgetIndexedContext, openIndexedContext } from "./indexed-context";
import { contextSplice, sha256 } from "./sync";

let db: Database, directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "context-response-"));
  db = new Database(join(directory, "remote.sqlite"));
  ensureSupervisorSchema(db);
  db.query("INSERT INTO thread_views(id) VALUES('s')").run();
});
afterEach(() => { forgetIndexedContext(db, "s"); db.close(); rmSync(directory, { recursive: true, force: true }); });
function put(document: string, time = 1) {
  db.query(`INSERT INTO session_contexts(session_id,captured_at,context) VALUES('s',?,?)
    ON CONFLICT(session_id) DO UPDATE SET captured_at=excluded.captured_at,context=excluded.context`).run(time, document);
}
const request = (etag?: string) => new Request("http://remote.test/v1/sessions/s/context", { headers: etag ? { "if-none-match": etag } : {} });
const forbiddenNative: ReadRawContext = async () => { throw new Error("Captured export must not select native history"); };
const headers = { "x-fixture-header": "preserved" };

function nativeFixture(count: number) {
  const messages = Array.from({ length: count }, (_, index) => ({ role: "user", timestamp: index + 1, content: `Native record ${index} 日本 🌙` }));
  const calls: Array<{ after: number | undefined; limit: number; revision: string | undefined }> = [];
  let failure: { code: string; message: string } | undefined;
  const read: ReadRawContext = async (after, limit, revision) => {
    calls.push({ after, limit, revision });
    if (failure && after !== undefined) return { ok: false, error: failure };
    if (revision !== undefined && revision !== "native-revision") return { ok: false, error: { code: "stale_source", message: "Wrong native revision" } };
    const from = after === undefined ? 0 : after + 1;
    return { ok: true, value: { source: { revision: "native-revision" }, total: messages.length,
      records: messages.slice(from, from + limit).map((message, offset) => ({ index: from + offset, entryId: `native:${from + offset}`, message })) } };
  };
  return { messages, read, calls, fail: (value: typeof failure) => { failure = value; } };
}

test("captured context streams exact raw JSON including unknown fields and byte patches", async () => {
  const base = JSON.stringify({ systemPrompt: "System", tools: [], messages: [{ role: "user", content: "before" }], unknown: { future: true } });
  const target = JSON.stringify({ systemPrompt: "System", tools: [], messages: [{ role: "user", content: "after 日本 🌙" }], unknown: { future: true, values: [null, 0, "kept"] } }, null, 2);
  put(base);
  const splice = contextSplice(base, target);
  db.query(`INSERT INTO session_context_patches(session_id,captured_at,base_hash,target_hash,prefix_bytes,delete_bytes,insert_base64)
    VALUES('s',?,?,?,?,?,?)`).run(7, splice.baseHash, splice.targetHash, splice.prefixBytes, splice.deleteBytes, splice.insertBase64);
  const session = { id: "s", title: "Export" };
  const response = await contextResponse(db, "s", session, request(), forbiddenNative, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-fixture-header")).toBe("preserved");
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(response.headers.get("etag")).toBe(`"${sha256(target)}"`);
  const text = await response.text();
  expect(text).toBe(`{"capturedAt":7,"context":${target},"hash":${JSON.stringify(sha256(target))},"session":${JSON.stringify(session)}}`);
  expect(JSON.parse(text).context).toEqual(JSON.parse(target));
});

test("captured export uses at most 64 KiB raw reads and never hydrates complete message records", async () => {
  const document = JSON.stringify({ systemPrompt: "System", tools: [], messages: [{ role: "user", content: "A".repeat(200_000) + "日本 🌙" }] });
  put(document);
  const opened = openIndexedContext(db, "s");
  if (!opened.ok || !opened.value) throw new Error("Captured index missing");
  const index = opened.value, open = index.openByteStream;
  const reads: Array<{ offset: number; bytes: number }> = [];
  index.readMessage = () => { throw new Error("Full message hydration on raw context export"); };
  index.readBytes = () => { throw new Error("Export must own one stream reader rather than reopen each raw chunk"); };
  index.openByteStream = revision => {
    const result = open(revision);
    if (!result.ok) return result;
    let offset = 0;
    const next = result.value.next;
    result.value.next = () => {
      const read = next();
      if (read.ok && read.value !== null) { reads.push({ offset, bytes: read.value.length }); offset += read.value.length; }
      return read;
    };
    return result;
  };
  const response = await contextResponse(db, "s", { id: "s" }, request(), forbiddenNative, {});
  expect(JSON.parse(await response.text()).context.messages[0].content).toBe("A".repeat(200_000) + "日本 🌙");
  expect(reads.length).toBeGreaterThan(3);
  expect(reads.every(read => read.bytes <= 64 * 1024)).toBe(true);
  expect(reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(Buffer.byteLength(document));
  for (let i = 1; i < reads.length; i++) expect(reads[i].offset).toBe(reads[i - 1].offset + reads[i - 1].bytes);
});

test("captured conditional GET preserves the revision ETag and sends no body", async () => {
  const document = JSON.stringify({ systemPrompt: "System", tools: [], messages: [] });
  put(document);
  const response = await contextResponse(db, "s", null, request(`"${sha256(document)}"`), forbiddenNative, headers);
  expect(response.status).toBe(304);
  expect(response.headers.get("etag")).toBe(`"${sha256(document)}"`);
  expect(response.headers.get("x-fixture-header")).toBe("preserved");
  expect(await response.text()).toBe("");
});

test("native export walks ordered bounded pages with one pinned revision", async () => {
  const native = nativeFixture(73);
  const session = { id: "s", owner: "fixture" };
  const response = await contextResponse(db, "s", session, request(), native.read, headers);
  const body = await response.json();
  expect(body).toEqual({ capturedAt: 0, hash: "native-revision", session,
    context: { source: "native-history", systemPrompt: "", tools: [], messages: native.messages } });
  expect(native.calls).toEqual([
    { after: undefined, limit: 32, revision: undefined },
    { after: 31, limit: 32, revision: "native-revision" },
    { after: 63, limit: 32, revision: "native-revision" },
  ]);
});

test("an empty native history produces an explicit empty native context", async () => {
  const native = nativeFixture(0);
  const response = await contextResponse(db, "s", null, request(), native.read, {});
  expect(await response.json()).toEqual({ capturedAt: 0, hash: "native-revision", session: null,
    context: { source: "native-history", systemPrompt: "", tools: [], messages: [] } });
  expect(native.calls).toHaveLength(1);
});

test("native conditional GET discovers the source revision once and does not paginate", async () => {
  const native = nativeFixture(73);
  const response = await contextResponse(db, "s", null, request('"native-revision"'), native.read, {});
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(native.calls).toHaveLength(1);
});

test("typed source failures before streaming become explicit 422 responses", async () => {
  put('{"malformed":"context"}');
  const captured = await contextResponse(db, "s", null, request(), forbiddenNative, headers);
  expect(captured.status).toBe(422);
  expect(await captured.json()).toMatchObject({ code: "invalid" });
  db.query("DELETE FROM session_contexts WHERE session_id='s'").run();
  const failed: ReadRawContext = async () => ({ ok: false, error: { code: "oversized-record", message: "Native record exceeds its byte limit" } });
  const native = await contextResponse(db, "s", null, request(), failed, headers);
  expect(native.status).toBe(422);
  expect(await native.json()).toEqual({ code: "oversized-record", error: "Native record exceeds its byte limit" });
});

test("a native revision change after the first page errors the stream rather than completing partial JSON", async () => {
  const native = nativeFixture(40);
  native.fail({ code: "stale_source", message: "Native branch changed" });
  const response = await contextResponse(db, "s", null, request(), native.read, {});
  await expect(response.text()).rejects.toThrow("stale_source: Native branch changed");
  expect(native.calls).toHaveLength(2);
});

test("a captured revision change during raw download errors the stream explicitly", async () => {
  const document = JSON.stringify({ systemPrompt: "System", tools: [], messages: [{ role: "user", content: "A".repeat(150_000) }] });
  put(document);
  const opened = openIndexedContext(db, "s");
  if (!opened.ok || !opened.value) throw new Error("Captured index missing");
  const index = opened.value, open = index.openByteStream;
  let reads = 0;
  index.openByteStream = revision => {
    const result = open(revision);
    if (!result.ok) return result;
    const next = result.value.next;
    result.value.next = () => {
      const read = next();
      if (++reads === 1) put(JSON.stringify({ systemPrompt: "System", tools: [], messages: [] }), 2);
      return read;
    };
    return result;
  };
  const response = await contextResponse(db, "s", null, request(), forbiddenNative, {});
  await expect(response.text()).rejects.toThrow("stale: Captured context changed");
  expect(reads).toBe(2);
});

test("cancelling a raw export closes its owned blob reader and independent record reads cannot close it", async () => {
  const document = JSON.stringify({ systemPrompt: "System", tools: [], messages: [{ role: "user", content: "A".repeat(150_000) }] });
  put(document);
  const opened = openIndexedContext(db, "s");
  if (!opened.ok || !opened.value) throw new Error("Captured index missing");
  const index = opened.value, open = index.openByteStream;
  let closes = 0;
  index.openByteStream = revision => {
    const result = open(revision);
    if (!result.ok) return result;
    const close = result.value.close;
    result.value.close = () => { closes++; return close(); };
    return result;
  };
  const response = await contextResponse(db, "s", null, request(), forbiddenNative, {});
  const reader = response.body!.getReader();
  await reader.read();
  const chunk = await reader.read();
  expect(chunk.value?.length).toBe(64 * 1024);
  expect(index.readMessage(0).ok).toBe(true);
  expect((await reader.read()).value?.length).toBe(64 * 1024);
  await reader.cancel();
  expect(closes).toBe(1);
  expect(index.readMessage(0).ok).toBe(true);
});
