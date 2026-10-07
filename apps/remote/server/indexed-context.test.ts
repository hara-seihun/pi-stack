import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_CHUNK_BYTES, CONTEXT_RECORD_BYTES, forgetIndexedContext, openIndexedContext, probeIndexedContext, type IndexedContext } from "./indexed-context";
import { contextSplice, messageFinalizationKey, sha256 } from "./sync";

let db: Database;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "captured-context-index-"));
  db = new Database(join(directory, "context.sqlite"));
  db.exec(`CREATE TABLE session_contexts(session_id TEXT PRIMARY KEY,captured_at INTEGER NOT NULL,context TEXT NOT NULL);
    CREATE TABLE session_context_patches(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,captured_at INTEGER,
      base_hash TEXT,target_hash TEXT,prefix_bytes INTEGER,delete_bytes INTEGER,insert_base64 TEXT);`);
});
afterEach(() => { forgetIndexedContext(db, "s"); db.close(); rmSync(directory, { recursive: true, force: true }); });
const document = (messages: any[], extra: object = {}) => JSON.stringify({ systemPrompt: "System 日本 🌙", tools: [], messages, ...extra });
function put(text: string, time = 1) {
  db.query("INSERT INTO session_contexts VALUES('s',?,?) ON CONFLICT(session_id) DO UPDATE SET captured_at=excluded.captured_at,context=excluded.context").run(time, text);
}
function splice(base: string, target: string, time: number) {
  const patch = contextSplice(base, target);
  db.query(`INSERT INTO session_context_patches(session_id,captured_at,base_hash,target_hash,prefix_bytes,delete_bytes,insert_base64)
    VALUES('s',?,?,?,?,?,?)`).run(time, patch.baseHash, patch.targetHash, patch.prefixBytes, patch.deleteBytes, patch.insertBase64);
}
function indexed(): IndexedContext {
  const result = openIndexedContext(db, "s");
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  if (!result.value) throw new Error("Missing captured context");
  return result.value;
}

test("a missing capture is explicitly unset", () => {
  expect(openIndexedContext(db, "missing")).toEqual({ ok: true, value: null });
});

test("message descriptors count the real display slices without retaining message bodies", () => {
  const messages = [
    { role: "user", timestamp: 1, content: "hello 日本 🌙" },
    { role: "assistant", timestamp: 2, content: [
      { type: "thinking", thinking: " \n\t\u2000\u00a0\ufeff " },
      { type: "thinking", thinking: "why" },
      { type: "text", text: "" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "x" } },
      { type: "unrecognised", payload: "visible notice" },
    ] },
    { role: "toolResult", timestamp: 3, toolCallId: "call", content: [{ type: "text", text: "result" }] },
    { role: "assistant", timestamp: 4, content: [], errorMessage: " " },
    { role: "assistant", timestamp: 5, content: [] },
  ];
  const tools = [{ name: "read", description: "reader", parameters: { type: "object" } }];
  const text = document(messages, { tools, contextUsage: { tokens: 10 }, contextModel: "model", source: "captured" });
  put(text);
  const index = indexed();
  expect(index.capturedAt).toBe(1);
  expect(index.revision).toBe(sha256(text));
  expect(index.header).toEqual({ systemPrompt: "System 日本 🌙", tools, contextUsage: { tokens: 10 }, contextModel: "model", source: "captured" });
  expect(index.messages.map(message => message.displayItemCount)).toEqual([1, 5, 1, 1, 0]);
  expect(index.messages[1].blocks[0].thinkingNonempty).toBe(false);
  expect(index.messages[1].blocks[1].thinkingNonempty).toBe(true);
  expect(index.messages[1].blocks[4].id).toBe("call");
  expect(index.messages[2].toolCallId).toBe("call");
  expect(index.messages[1].finalizationKey).toBe(messageFinalizationKey(messages[1]));
  expect(index.messages[1].recordHash).toBe(sha256(JSON.stringify(messages[1])));
  expect(index.messages[1].blocks[0].thinkingEmpty).toBe(false);
  for (let i = 0; i < messages.length; i++) expect(index.readMessage(i)).toEqual({ ok: true, value: messages[i] });
  expect(JSON.stringify(index)).not.toContain("visible notice");
});

test("cold indexing reads a giant image in chunks; only the selected bounded message is hydrated", () => {
  const hugeMessage = { role: "assistant", content: [{ type: "image", data: "A".repeat(CONTEXT_RECORD_BYTES + CONTEXT_CHUNK_BYTES), mimeType: "image/png" }] };
  const smallMessage = { role: "assistant", timestamp: 8, content: [{ type: "text", text: "exact last message" }] };
  const text = document([hugeMessage, smallMessage]);
  put(text);
  const nativeQuery = db.query.bind(db);
  const chunks: number[] = [];
  db.query = ((sql: string) => {
    expect(sql).not.toMatch(/SELECT\s+(?:\*|context\b)/i);
    const statement = nativeQuery(sql);
    if (sql.includes("substr(CAST(context AS BLOB)")) {
      const get = statement.get.bind(statement);
      statement.get = ((...args: any[]) => { chunks.push(args[1]); return get(...args); }) as typeof statement.get;
    }
    return statement;
  }) as typeof db.query;
  const index = indexed();
  expect(index.messages).toHaveLength(2);
  expect(index.revision).toBe(sha256(text));
  expect(chunks).toEqual([]);
  expect(index.messages[0].finalizationKeyError?.code).toBe("oversized");
  expect(index.readMessage(0)).toMatchObject({ ok: false, error: { code: "oversized", limit: CONTEXT_RECORD_BYTES } });
  expect(index.readMessage(1)).toEqual({ ok: true, value: smallMessage });
  expect(JSON.stringify(index).length).toBeLessThan(3000);
});

test("byte splices reconstruct exact UTF-8 across chunk and base64 boundaries", () => {
  const prefix = "A".repeat(CONTEXT_CHUNK_BYTES - 150);
  const messages = [{ role: "user", content: prefix + "日本 é 🌙 tail" }, { role: "assistant", content: [{ type: "text", text: "before" }] }];
  const base = document(messages);
  put(base);
  const middle = document([{ ...messages[0], content: prefix + "日中 ê 🌚 tail" }, messages[1]]);
  splice(base, middle, 2);
  const targetMessages = [{ ...messages[0], content: prefix + "日中 ê 🌚 tail" }, { ...messages[1], content: [{ type: "text", text: "after 日本" }] }];
  const target = document(targetMessages);
  splice(middle, target, 3);
  const index = indexed();
  expect(index.capturedAt).toBe(3);
  expect(index.revision).toBe(sha256(target));
  expect(index.readMessage(0)).toEqual({ ok: true, value: targetMessages[0] });
  expect(index.readMessage(1)).toEqual({ ok: true, value: targetMessages[1] });
});

test("stale indexes and stale requested revisions cannot read a different capture", () => {
  const base = document([{ role: "user", content: "old" }]);
  put(base);
  const index = indexed();
  expect(index.readMessage(0, "different")).toMatchObject({ ok: false, error: { code: "stale" } });
  splice(base, document([{ role: "user", content: "new" }]), 2);
  expect(index.readMessage(0)).toMatchObject({ ok: false, error: { code: "stale" } });
  const newer = indexed();
  put(document([{ role: "user", content: "checkpoint" }]), 3);
  db.exec("DELETE FROM session_context_patches");
  expect(newer.readMessage(0)).toMatchObject({ ok: false, error: { code: "stale" } });
});

test("corrupt JSON, patch ranges, encodings and target hashes are typed invalid results", () => {
  for (const text of ["{}", '{"systemPrompt":"x","tools":[],"messages":[{"role":"user","content":"bad\\x"}]}',
    '{"systemPrompt":"x","tools":[],"messages":[],"messages":[]}', document([]) + "false"])
  {
    put(text);
    expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "invalid" } });
  }
  const base = document([{ role: "user", content: "old" }]);
  const target = document([{ role: "user", content: "new" }]);
  put(base);
  splice(base, target, 2);
  db.query("UPDATE session_context_patches SET prefix_bytes=-1").run();
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "invalid" } });
  db.exec("DELETE FROM session_context_patches"); splice(base, target, 2);
  db.query("UPDATE session_context_patches SET base_hash=?").run("0".repeat(64));
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "invalid" } });
  db.exec("DELETE FROM session_context_patches"); splice(base, target, 2);
  db.query("UPDATE session_context_patches SET insert_base64='!!!!'").run();
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "invalid" } });
  db.exec("DELETE FROM session_context_patches"); splice(base, target, 2);
  db.query("UPDATE session_context_patches SET target_hash=?").run("0".repeat(64));
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "invalid" } });
});

test("oversized headers and metadata fail explicitly; malformed nesting is bounded", () => {
  put(document([], { systemPrompt: "A".repeat(CONTEXT_RECORD_BYTES + 1) }));
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "oversized" } });
  put(document([{ role: "A".repeat(16 * 1024 + 1), content: "x" }]));
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "oversized" } });
  put('{"systemPrompt":"x","tools":[],"messages":[],"other":' + "[".repeat(130) + "0" + "]".repeat(130) + "}");
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "invalid" } });
});

test("storage failures are explicit and indexes validate exact message indices", () => {
  put(document([{ role: "user", content: "x" }]));
  const index = indexed();
  for (const value of [-1, 1, 0.5, NaN]) expect(index.readMessage(value)).toMatchObject({ ok: false, error: { code: "invalid" } });
  db.exec("DROP TABLE session_context_patches");
  expect(openIndexedContext(db, "s")).toMatchObject({ ok: false, error: { code: "storage" } });
  expect(index.readMessage(0)).toMatchObject({ ok: false, error: { code: "storage" } });
});

test("cached opens only probe metadata and native readers release their snapshot after each operation", () => {
  const first = document([{ role: "user", content: "first" }]);
  put(first);
  const index = indexed();
  const query = db.query.bind(db);
  const statements: string[] = [];
  db.query = ((sql: string) => { statements.push(sql); return query(sql); }) as typeof db.query;
  expect(indexed()).toBe(index);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("octet_length(context)");
  expect(statements[1]).not.toContain("substr(");
  expect(probeIndexedContext(db, "s")).toEqual({ ok: true, value: { sourceToken: index.sourceToken, capturedAt: 1 } });
  // A separate connection can replace the row immediately: no retained blob read transaction.
  const writer = new Database(db.filename);
  const next = document([{ role: "user", content: "second" }]);
  writer.query("UPDATE session_contexts SET context=?,captured_at=2").run(next);
  writer.close();
  expect(index.readMessage(0)).toMatchObject({ ok: false, error: { code: "stale" } });
  const newer = indexed();
  expect(newer).not.toBe(index);
  expect(newer.readMessage(0)).toEqual({ ok: true, value: { role: "user", content: "second" } });
});

test("exact raw chunk reads stream patched JSON without a complete document allocation", () => {
  const base = document([{ role: "user", content: "a".repeat(CONTEXT_CHUNK_BYTES) + "日本" }]);
  const target = document([{ role: "user", content: "b".repeat(CONTEXT_CHUNK_BYTES) + "🌙" }]);
  put(base); splice(base, target, 2);
  const index = indexed();
  expect(index.totalBytes).toBe(Buffer.byteLength(target));
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < index.totalBytes; offset += CONTEXT_CHUNK_BYTES) {
    const read = index.readBytes(offset, Math.min(CONTEXT_CHUNK_BYTES, index.totalBytes - offset));
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    chunks.push(read.value);
  }
  expect(Buffer.concat(chunks).toString()).toBe(target);
  expect(index.readBytes(0, CONTEXT_CHUNK_BYTES + 1)).toMatchObject({ ok: false, error: { code: "oversized" } });
  expect(index.readBytes(-1, 1)).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(index.readBytes(0, 1, "wrong")).toMatchObject({ ok: false, error: { code: "stale" } });
  put(base, 3); db.exec("DELETE FROM session_context_patches");
  expect(index.readBytes(0, 1)).toMatchObject({ ok: false, error: { code: "stale" } });
});

test("the assistant display substitution and question receipt descriptors match projection semantics", () => {
  const messages = [
    { role: "assistant", stopReason: "stop", content: [] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: " " }, { type: "text", text: "\n" }, { type: "thinking", thinking: "why" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "why" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
    { role: "user", content: "accepted", rootConsent: true, questionId: "q1" },
  ];
  put(document(messages));
  const index = indexed();
  expect(index.messages.map(message => message.displayItemCount)).toEqual([1, 2, 1, 0, 1]);
  expect(index.messages[3].blocks[0].thinkingEmpty).toBe(true);
  expect(index.messages[4].rootConsent).toBe(true);
  expect(index.messages[4].questionId).toBe("q1");
});

test("large memory-only sources explicitly refuse the nonincremental SQLite path", () => {
  const memory = new Database(":memory:");
  memory.exec(`CREATE TABLE session_contexts(session_id TEXT,captured_at INTEGER,context TEXT);
    CREATE TABLE session_context_patches(seq INTEGER,session_id TEXT,captured_at INTEGER,base_hash TEXT,target_hash TEXT,prefix_bytes INTEGER,delete_bytes INTEGER,insert_base64 TEXT);`);
  memory.query("INSERT INTO session_contexts VALUES('s',1,?)").run(document([{ role: "user", content: "A".repeat(CONTEXT_RECORD_BYTES) }]));
  expect(openIndexedContext(memory, "s")).toMatchObject({ ok: false, error: { code: "oversized" } });
  memory.close();
});

test("110 MiB captured image cold indexing stays under 256 MiB peak RSS in an isolated reader", () => {
  put(document([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(110 * 1024 * 1024) }] },
    { role: "assistant", content: [{ type: "text", text: "tail" }] }]));
  const script = `import { Database } from 'bun:sqlite';
    import { readFileSync } from 'node:fs';
    import { openIndexedContext } from ${JSON.stringify(new URL("./indexed-context.ts", import.meta.url).href)};
    const db = new Database(process.argv[1]);
    const result = openIndexedContext(db,'s');
    if (!result.ok || !result.value) throw new Error(JSON.stringify(result));
    const index = result.value;
    const tail = index.readMessage(1);
    if (!tail.ok || tail.value.content[0].text !== 'tail') throw new Error('Exact tail missing');
    const maxRSS = Number(readFileSync('/proc/self/status','utf8').match(/^VmHWM:\\s+(\\d+)/m)[1]);
    console.log(JSON.stringify({ maxRSS, totalBytes: index.totalBytes, descriptors: index.messages.length }));`;
  const child = Bun.spawnSync([process.execPath, "--eval", script, db.filename], { timeout: 30_000 });
  expect(child.exitCode).toBe(0);
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const report = JSON.parse(child.stdout.toString());
  expect(report.descriptors).toBe(2);
  expect(report.totalBytes).toBeGreaterThan(110 * 1024 * 1024);
  expect(report.maxRSS).toBeLessThan(256 * 1024);
}, 40_000);
