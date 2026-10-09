import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, chmod, rm, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateNativeHistory } from "./migrate-native-history.mjs";

const key = message => createHash("sha256").update(JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content })).digest("hex");
const retained = ["session_contexts", "session_context_patches", "captured_context_unavailable", "captured_context_usage", "captured_transcript_generations"];
async function fixture(t, content = [{ type: "thinking", thinking: "", signature: "exact-provider-signature" }, { type: "text", text: "Answer" }]) {
  const root = await mkdtemp(join(tmpdir(), "native-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, "native.jsonl");
  const options = { supervisorDb: join(root, "supervisor.sqlite"), threadDb: join(root, "threads.sqlite"), outputDir: join(root, "custody"), writersStopped: true };
  const message = { role: "assistant", timestamp: 1234, content, usage: { input: 100, output: 12 } };
  const assistant = { type: "message", id: "assistant", parentId: "receipt", timestamp: "2026-10-08T00:00:00Z", message };
  const receipt = ' {"type":"custom","id":"receipt","parentId":"header","data":{"responseReceipt":{"requestId":"exact"}}}\r\n';
  const suffix = '{"type":"message","id":"branch","parentId":"header","message":{"role":"user","content":[{"type":"text","text":"branch"}],"timestamp":2}}';
  const original = '{"type":"session","id":"header","version":3}\n' + receipt + JSON.stringify(assistant) + "\n" + suffix;
  await writeFile(native, original, { mode: 0o640 });
  await chmod(native, 0o640); // Exercise mode preservation independently of the invoking account's umask.
  const db = new DatabaseSync(options.supervisorDb);
  db.exec(`CREATE TABLE message_facts(session_id TEXT,finalizes_message TEXT,thinking TEXT,metrics TEXT,PRIMARY KEY(session_id,finalizes_message));
    CREATE TABLE thread_views(id TEXT PRIMARY KEY); INSERT INTO thread_views VALUES('s');`);
  for (const name of retained) {
    db.exec(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY,body BLOB);`);
    db.prepare(`INSERT INTO ${name} VALUES(1,?)`).run(Buffer.from([0, 255, 10, 0]));
  }
  db.prepare("INSERT INTO message_facts VALUES('s',?,?,?)").run(key(message), "Recovered unique thinking 🦊", '{"ttftMs":42}');
  db.prepare("INSERT INTO message_facts VALUES('s','unmatched','Only retained in snapshot',NULL)").run();
  db.close();
  const threads = new DatabaseSync(options.threadDb);
  threads.exec("CREATE TABLE thread(id TEXT PRIMARY KEY,session_file TEXT NOT NULL)");
  threads.prepare("INSERT INTO thread VALUES('s',?)").run(native);
  threads.close();
  return { root, native, options, assistant, message, original, receipt, suffix };
}
function names(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return [...db.prepare("SELECT name FROM sqlite_master WHERE type='table'").iterate()].map(row => row.name); }
  finally { db.close(); }
}

test("durable snapshot, native promotion, metric rekey, exact untouched receipts, and replay", async t => {
  const f = await fixture(t);
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.promoted, 1);
  assert.equal(result.value.unmatchedFacts, 1);
  const rewritten = await readFile(f.native, "utf8");
  assert.ok(rewritten.includes(f.receipt));
  assert.ok(rewritten.endsWith(f.suffix));
  const entry = JSON.parse(rewritten.split("\n")[2]);
  assert.deepEqual({ id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp }, { id: "assistant", parentId: "receipt", timestamp: f.assistant.timestamp });
  assert.deepEqual(entry.message.usage, f.message.usage);
  assert.deepEqual(entry.message.content[0], { type: "thinking", thinking: "Recovered unique thinking 🦊", signature: "exact-provider-signature" });
  assert.equal((await stat(f.native)).mode & 0o777, 0o640);
  const db = new DatabaseSync(f.options.supervisorDb);
  assert.equal(db.prepare("SELECT metrics FROM message_facts WHERE finalizes_message=?").get(key(entry.message)).metrics, '{"ttftMs":42}');
  assert.ok(![...db.prepare("PRAGMA table_info(message_facts)").iterate()].some(row => row.name === "thinking"));
  db.close();
  for (const name of retained) assert.ok(!names(f.options.supervisorDb).includes(name));
  const saved = new DatabaseSync(result.value.supervisorSnapshot, { readOnly: true });
  for (const name of retained) assert.deepEqual(Buffer.from(saved.prepare(`SELECT body FROM ${name}`).get().body), Buffer.from([0, 255, 10, 0]));
  assert.equal(saved.prepare("SELECT thinking FROM message_facts WHERE finalizes_message='unmatched'").get().thinking, "Only retained in snapshot");
  saved.close();
  const journal = new DatabaseSync(result.value.receipt, { readOnly: true });
  const preimage = journal.prepare("SELECT preimage FROM native").get().preimage;
  journal.close();
  assert.equal(await readFile(preimage, "utf8"), f.original);
  assert.equal((await stat(preimage)).mode & 0o777, 0o400);
  assert.deepEqual(await migrateNativeHistory(f.options), result);
  assert.equal(await readFile(f.native, "utf8"), rewritten);
});

test("promotion inserts a missing block and does not replace existing nonempty native thinking", async t => {
  const f = await fixture(t, [{ type: "text", text: "Answer" }]);
  assert.equal((await migrateNativeHistory(f.options)).ok, true);
  const entry = JSON.parse((await readFile(f.native, "utf8")).split("\n")[2]);
  assert.equal(entry.message.content[0].thinking, "Recovered unique thinking 🦊");
  const g = await fixture(t, [{ type: "thinking", thinking: "Already native" }, { type: "text", text: "Answer" }]);
  const result = await migrateNativeHistory(g.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.different, 1);
  assert.equal(result.value.promoted, 0);
  assert.equal(await readFile(g.native, "utf8"), g.original);
});

test("corrupt and missing native sources keep supervisor tables and unique facts preserved", async t => {
  for (const missing of [false, true]) {
    const f = await fixture(t);
    if (missing) await rm(f.native);
    else await writeFile(f.native, f.original + "\n{not-json}");
    const result = await migrateNativeHistory(f.options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, missing ? "missing-native" : "invalid-jsonl");
    for (const name of retained) assert.ok(names(f.options.supervisorDb).includes(name));
    const snapshot = new DatabaseSync(join(f.options.outputDir, "supervisor.sqlite"), { readOnly: true });
    assert.equal(snapshot.prepare("SELECT thinking FROM message_facts WHERE finalizes_message=?").get(key(f.message)).thinking, "Recovered unique thinking 🦊");
    snapshot.close();
    if (!missing) {
      const journal = new DatabaseSync(join(f.options.outputDir, "receipt.sqlite"));
      const row = journal.prepare("SELECT * FROM native").get();
      assert.equal(await readFile(row.preimage, "utf8"), f.original + "\n{not-json}");
      assert.equal(await readFile(f.native, "utf8"), f.original + "\n{not-json}");
      journal.close();
    } else {
      await writeFile(f.native, f.original, { mode: 0o640 });
      assert.equal((await migrateNativeHistory(f.options)).ok, true);
    }
  }
});

test("prepared native rewrite and post-drop receipt interruption recover without duplicate thinking", async t => {
  const f = await fixture(t);
  assert.equal((await migrateNativeHistory(f.options)).ok, true);
  const rewritten = await readFile(f.native, "utf8");
  const journal = new DatabaseSync(join(f.options.outputDir, "receipt.sqlite"));
  journal.exec("UPDATE native SET state='prepared'; UPDATE migration SET state='retirement-ready'");
  journal.close();
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await readFile(f.native, "utf8"), rewritten);
  assert.equal(result.value.promoted, 1);
});

test("snapshot corruption refuses replay and does not modify remaining live data", async t => {
  const f = await fixture(t);
  await rm(f.native);
  assert.equal((await migrateNativeHistory(f.options)).error.code, "missing-native");
  const path = join(f.options.outputDir, "supervisor.sqlite");
  await chmod(path, 0o600);
  await writeFile(path, "corrupt snapshot");
  await writeFile(f.native, f.original);
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.error.code, "snapshot-corrupt");
  assert.equal(await readFile(f.native, "utf8"), f.original);
  for (const name of retained) assert.ok(names(f.options.supervisorDb).includes(name));
});

test("pre-facts events thinking promotes and rekeys metrics before runtime event retirement", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.options.supervisorDb);
  db.exec("DELETE FROM message_facts; CREATE TABLE events(seq INTEGER PRIMARY KEY,session_id TEXT,type TEXT,payload TEXT)");
  db.prepare("INSERT INTO events VALUES(1,'s','thinking',?)").run(JSON.stringify({ finalizesMessage: key(f.message), text: "Old event thought" }));
  db.prepare("INSERT INTO events VALUES(2,'s','metrics',?)").run(JSON.stringify({ finalizesMessage: key(f.message), metrics: { ttftMs: 12 } }));
  db.close();
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const entry = JSON.parse((await readFile(f.native, "utf8")).split("\n")[2]);
  assert.equal(entry.message.content[0].thinking, "Old event thought");
  const live = new DatabaseSync(f.options.supervisorDb);
  const metric = JSON.parse(live.prepare("SELECT payload FROM events WHERE type='metrics'").get().payload);
  assert.equal(metric.finalizesMessage, key(entry.message));
  assert.deepEqual(metric.metrics, { ttftMs: 12 });
  live.close();
});

test("active-writer assertion and supervisor change on restart are explicit failures", async t => {
  const f = await fixture(t);
  assert.equal((await migrateNativeHistory({ ...f.options, writersStopped: false })).error.code, "writers-not-stopped");
  await rm(f.native);
  await migrateNativeHistory(f.options);
  const db = new DatabaseSync(f.options.supervisorDb);
  db.exec("INSERT INTO thread_views VALUES('unexpected-writer')");
  db.close();
  await writeFile(f.native, f.original);
  assert.equal((await migrateNativeHistory(f.options)).error.code, "supervisor-changed");
  assert.equal(await readFile(f.native, "utf8"), f.original);
});

test("deleted-thread orphans are named preserved-only warnings, including capture-only history", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.options.supervisorDb);
  db.exec("DROP TABLE session_contexts; CREATE TABLE session_contexts(session_id TEXT PRIMARY KEY,context BLOB)");
  const rawContext = Buffer.from("not reconstructed JSON ".repeat(10_000));
  db.prepare("INSERT INTO session_contexts VALUES('deleted',?)").run(rawContext);
  db.prepare("INSERT INTO session_contexts VALUES('capture-only-deleted',?)").run(Buffer.from([0, 255]));
  db.prepare("INSERT INTO message_facts VALUES('deleted','orphan','Orphan unique body',NULL)").run();
  db.close();
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.preservedOrphans, {
    sessions: 2, facts: 1, captureRows: 2,
    firstSessions: [{ sessionId: "capture-only-deleted", facts: 0, captureRows: 1 }, { sessionId: "deleted", facts: 1, captureRows: 1 }],
  });
  assert.equal(result.value.unmatchedFacts, 2);
  const snapshot = new DatabaseSync(result.value.supervisorSnapshot, { readOnly: true });
  assert.deepEqual(Buffer.from(snapshot.prepare("SELECT context FROM session_contexts WHERE session_id='deleted'").get().context), rawContext);
  snapshot.close();
});

test("mapped capture-only native loss is an explicit recovery issue", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.options.supervisorDb);
  db.exec("DELETE FROM message_facts; DROP TABLE session_contexts; CREATE TABLE session_contexts(session_id TEXT,context TEXT); INSERT INTO session_contexts VALUES('s','original captured history')");
  db.close();
  await rm(f.native);
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.error.code, "missing-native");
  assert.ok(names(f.options.supervisorDb).includes("session_contexts"));
});

test("crash after prepared receipt but before native rename replays the original preimage", async t => {
  const f = await fixture(t);
  assert.equal((await migrateNativeHistory(f.options)).ok, true);
  const rewritten = await readFile(f.native, "utf8");
  await writeFile(f.native, f.original);
  await copyFile(join(f.options.outputDir, "supervisor.sqlite"), f.options.supervisorDb);
  await chmod(f.options.supervisorDb, 0o600);
  const journal = new DatabaseSync(join(f.options.outputDir, "receipt.sqlite"));
  journal.exec("UPDATE native SET state='prepared'; UPDATE migration SET state='promoting'");
  journal.close();
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await readFile(f.native, "utf8"), rewritten);
  assert.equal(result.value.promoted, 1);
});

test("metric rekey collision rolls back the entire supervisor retirement transaction", async t => {
  const f = await fixture(t);
  const rewrittenMessage = structuredClone(f.message);
  rewrittenMessage.content[0].thinking = "Recovered unique thinking 🦊";
  const db = new DatabaseSync(f.options.supervisorDb);
  db.prepare("INSERT INTO message_facts VALUES('s',?,NULL,'conflicting metrics')").run(key(rewrittenMessage));
  db.close();
  const result = await migrateNativeHistory(f.options);
  assert.equal(result.error.code, "fact-key-conflict");
  for (const name of retained) assert.ok(names(f.options.supervisorDb).includes(name));
  const live = new DatabaseSync(f.options.supervisorDb);
  assert.equal(live.prepare("SELECT thinking FROM message_facts WHERE finalizes_message=?").get(key(f.message)).thinking, "Recovered unique thinking 🦊");
  assert.equal(live.prepare("SELECT metrics FROM message_facts WHERE finalizes_message=?").get(key(rewrittenMessage)).metrics, "conflicting metrics");
  live.close();
});
