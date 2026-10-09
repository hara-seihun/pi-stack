#!/usr/bin/env node
import { DatabaseSync, backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TABLES = ["session_contexts", "session_context_patches", "captured_context_unavailable", "captured_context_usage", "captured_transcript_generations"];
const RECORD_LIMIT = 64 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
const key = message => hash(JSON.stringify({ role: message.role ?? null, timestamp: message.timestamp ?? null, content: message.content ?? null }));

class MaintenanceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new MaintenanceError(code, message); };
const errorData = error => error instanceof MaintenanceError
  ? { code: error.code, message: error.message }
  : { code: "io", message: String(error?.message ?? error) };

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function syncDirectory(path) {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}
async function digest(path) {
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(path)) sha.update(chunk);
  return sha.digest("hex");
}
async function immutableFile(path, producer) {
  const temp = `${path}.pending`;
  if (await exists(path)) fail("artifact-exists", `Refusing to replace immutable artifact ${path}`);
  if (await exists(temp)) await unlink(temp);
  const file = await open(temp, "wx", 0o600);
  try { await producer(file); await file.sync(); } finally { await file.close(); }
  await chmod(temp, 0o400);
  await rename(temp, path);
  await syncDirectory(dirname(path));
}
async function immutableCopy(source, destination) {
  await immutableFile(destination, async file => {
    for await (const chunk of createReadStream(source)) await writeAll(file, chunk);
  });
}
async function writeAll(file, data) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset);
    if (!bytesWritten) fail("short-write", "Filesystem made no progress writing migration output");
    offset += bytesWritten;
  }
}
async function sqliteSnapshot(db, path) {
  const temp = `${path}.pending`;
  if (await exists(temp)) await unlink(temp);
  await backup(db, temp, { rate: 64 });
  await chmod(temp, 0o600);
  const check = new DatabaseSync(temp, { readOnly: true });
  try {
    for (const row of check.prepare("PRAGMA quick_check").iterate()) {
      if (Object.values(row)[0] !== "ok") fail("invalid-snapshot", `SQLite integrity failure in ${path}`);
    }
  } finally { check.close(); }
  const file = await open(temp, "r");
  try { await file.sync(); } finally { await file.close(); }
  await chmod(temp, 0o400);
  await rename(temp, path);
  await syncDirectory(dirname(path));
  return await digest(path);
}
function tables(db) {
  return new Set([...db.prepare("SELECT name FROM sqlite_master WHERE type='table'").iterate()].map(row => row.name));
}
function version(db) { return db.prepare("PRAGMA data_version").get().data_version; }
function requireColumns(db, table, columns) {
  const present = new Set([...db.prepare(`PRAGMA table_info(${table})`).iterate()].map(row => row.name));
  for (const name of columns) if (!present.has(name)) fail("schema", `Required column ${table}.${name} is absent`);
}

// Keep untouched lines byte-for-byte; bound memory to one explicitly limited record.
async function* lines(path) {
  let parts = [], bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index + 1);
      bytes += part.length;
      if (bytes > RECORD_LIMIT) fail("record-too-large", `Native JSONL record exceeds ${RECORD_LIMIT} bytes: ${path}`);
      parts.push(part);
      yield Buffer.concat(parts, bytes);
      parts = []; bytes = 0; start = index + 1;
    }
    if (start < chunk.length) { parts.push(chunk.subarray(start)); bytes += chunk.length - start; }
    if (bytes > RECORD_LIMIT) fail("record-too-large", `Native JSONL record exceeds ${RECORD_LIMIT} bytes: ${path}`);
  }
  if (bytes) yield Buffer.concat(parts, bytes);
}
function promote(message, thinking) {
  if (!Array.isArray(message.content)) fail("unsupported-message", "Matched assistant content is not a native block array");
  const blocks = message.content.filter(block => block?.type === "thinking");
  if (blocks.some(block => typeof block.thinking !== "string")) fail("invalid-thinking", "Native thinking block has no string body");
  const body = blocks.map(block => block.thinking).join("");
  if (body) return { state: body === thinking ? "existing" : "different" };
  if (!blocks.length) message.content.unshift({ type: "thinking", thinking });
  else blocks[0].thinking = thinking;
  return { state: "promoted" };
}

async function processSession(mapping, journal, output, sessionId) {
  const mapped = mapping.prepare("SELECT session_file FROM thread WHERE id=?").get(sessionId);
  if (!mapped?.session_file) fail("missing-mapping", `No native session_file mapping for thread ${sessionId}; source facts remain in supervisor snapshot`);
  if (!resolve(mapped.session_file).endsWith(".jsonl") || !mapped.session_file.startsWith("/")) fail("invalid-path", `Native session_file must be an absolute JSONL path for ${sessionId}`);
  if (!await exists(mapped.session_file)) fail("missing-native", `Native source is missing for ${sessionId}: ${mapped.session_file}; source facts remain in supervisor snapshot`);
  const path = await realpath(mapped.session_file);
  if (path.startsWith(output + "/")) fail("invalid-path", "Native source must be outside migration output directory");
  const info = await stat(path);
  if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1) fail("native-ownership", `Native source must be a singly linked file owned by the invoking user: ${path}`);
  let receipt = journal.prepare("SELECT * FROM native WHERE session_id=?").get(sessionId);
  if (receipt && receipt.path !== path) fail("mapping-changed", `Native mapping changed for ${sessionId}`);
  if (!receipt) {
    const preimage = join(output, "native", `${hash(path)}.jsonl`);
    // A crash after creating the preimage but before its receipt is safe to replay.
    if (!await exists(preimage)) await immutableCopy(path, preimage);
    const before = await digest(preimage);
    if (await digest(path) !== before) fail("native-changed", `Native source changed before preimage receipt: ${path}`);
    journal.prepare("INSERT INTO native(session_id,path,preimage,before_sha,state,mode) VALUES(?,?,?,?, 'preserved',?)")
      .run(sessionId, path, preimage, before, info.mode & 0o777);
    receipt = journal.prepare("SELECT * FROM native WHERE session_id=?").get(sessionId);
  }
  if (await digest(receipt.preimage) !== receipt.before_sha) fail("preimage-corrupt", `Immutable native preimage is corrupt: ${receipt.preimage}`);
  const current = await digest(path);
  if (receipt.after_sha && current === receipt.after_sha) {
    journal.prepare("UPDATE native SET state='complete' WHERE session_id=?").run(sessionId);
    return;
  }
  if (current !== receipt.before_sha) fail("native-changed", `Native file is neither its source nor its prepared output: ${path}`);
  if (receipt.state === "complete") fail("native-changed", `Completed native file was reverted: ${path}`);
  journal.exec("BEGIN IMMEDIATE");
  journal.prepare("DELETE FROM matched WHERE session_id=?").run(sessionId);
  const temp = join(dirname(path), `.native-history-${hash(output + path)}.pending`);
  if (await exists(temp)) await unlink(temp);
  const file = await open(temp, "wx", receipt.mode);
  let promoted = 0, existing = 0, different = 0, lineNumber = 0;
  const sha = createHash("sha256");
  try {
    for await (const raw of lines(receipt.preimage)) {
      lineNumber++;
      let entry;
      try { entry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
      catch { fail("invalid-jsonl", `Corrupt native JSONL at ${path}:${lineNumber}; preimage is preserved`); }
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string") fail("invalid-jsonl", `Invalid native entry at ${path}:${lineNumber}`);
      let bytes = raw;
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const finalized = key(entry.message);
        const size = journal.prepare("SELECT length(CAST(thinking AS BLOB)) AS bytes FROM fact_source WHERE session_id=? AND finalizes_message=?").get(sessionId, finalized);
        if (size?.bytes > RECORD_LIMIT) fail("thinking-too-large", `Thinking body exceeds ${RECORD_LIMIT} bytes for ${sessionId}; source snapshot is preserved`);
        const fact = size ? journal.prepare("SELECT thinking FROM fact_source WHERE session_id=? AND finalizes_message=?").get(sessionId, finalized) : null;
        if (typeof fact?.thinking === "string" && fact.thinking.length) {
          if (typeof entry.id !== "string" || !entry.id) fail("invalid-entry-id", `Matched native entry has no ID at ${path}:${lineNumber}`);
          const result = promote(entry.message, fact.thinking);
          journal.prepare("INSERT OR IGNORE INTO matched(session_id,finalizes_message,new_key) VALUES(?,?,?)").run(sessionId, finalized, key(entry.message));
          if (result.state === "promoted") {
            promoted++;
            const newline = raw.at(-1) === 10 ? (raw.at(-2) === 13 ? "\r\n" : "\n") : "";
            bytes = Buffer.from(JSON.stringify(entry) + newline);
          } else if (result.state === "existing") existing++;
          else different++;
        }
      }
      sha.update(bytes);
      await writeAll(file, bytes);
    }
    await file.sync();
  } catch (error) { await file.close(); await unlink(temp); journal.exec("ROLLBACK"); throw error; }
  await file.close();
  await chmod(temp, receipt.mode);
  const after = sha.digest("hex");
  if (await digest(temp) !== after) fail("output-corrupt", `Native staged output failed durability hash: ${temp}`);
  journal.prepare("UPDATE native SET after_sha=?,state='prepared',promoted=?,existing=?,different=? WHERE session_id=?")
    .run(after, promoted, existing, different, sessionId);
  journal.exec("COMMIT");
  if (await digest(path) !== receipt.before_sha) fail("native-changed", `Native source changed during promotion: ${path}`);
  await rename(temp, path);
  await syncDirectory(dirname(path));
  if (await digest(path) !== after) fail("output-corrupt", `Native replacement failed durability hash: ${path}`);
  journal.prepare("UPDATE native SET state='complete' WHERE session_id=?").run(sessionId);
}

async function migrate(options) {
  if (options.writersStopped !== true) fail("writers-not-stopped", "Explicit --writers-stopped assertion is required after stopping all native and supervisor writers");
  if (!options.supervisorDb || !options.threadDb || !options.outputDir) fail("arguments", "supervisorDb, threadDb and outputDir are required");
  const supervisorPath = await realpath(options.supervisorDb);
  const threadPath = await realpath(options.threadDb);
  if (supervisorPath === threadPath) fail("arguments", "Supervisor and thread databases must be distinct");
  for (const path of [supervisorPath, threadPath]) {
    const info = await stat(path);
    if (!info.isFile() || info.uid !== process.getuid()) fail("input-ownership", `Input database must be a file owned by the invoking user: ${path}`);
  }
  const output = resolve(options.outputDir);
  if ([supervisorPath, threadPath].some(path => path === output || path.startsWith(output + "/"))) fail("arguments", "Migration output must not contain either input database");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const info = await stat(output);
  if (info.uid !== process.getuid() || (info.mode & 0o077)) fail("private-output", "Output directory must be owned by the invoking user with no group/other permissions");
  if (await realpath(output) !== output) fail("private-output", "Output directory must not use symlinks");
  await mkdir(join(output, "native"), { recursive: true, mode: 0o700 });
  const nativeDir = await stat(join(output, "native"));
  if (nativeDir.uid !== process.getuid() || (nativeDir.mode & 0o077) || await realpath(join(output, "native")) !== join(output, "native")) fail("private-output", "Native preimage directory must be private and not symlinked");
  const lock = new DatabaseSync(join(output, "lock.sqlite"));
  let live, source, mapping, journal;
  try {
    try { lock.exec("BEGIN EXCLUSIVE"); } catch { fail("migration-busy", "Another migration owns this output directory"); }
    live = new DatabaseSync(supervisorPath);
    live.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
    const liveVersion = version(live);
    const manifestPath = join(output, "snapshot.json");
    let manifest, fresh = false;
    if (!await exists(manifestPath)) {
      for (const name of ["supervisor.sqlite", "threads.sqlite"]) if (await exists(join(output, name))) await unlink(join(output, name));
      const supervisorSha = await sqliteSnapshot(live, join(output, "supervisor.sqlite"));
      const threadDb = new DatabaseSync(threadPath, { readOnly: true });
      let threadSha;
      try { threadSha = await sqliteSnapshot(threadDb, join(output, "threads.sqlite")); } finally { threadDb.close(); }
      if (version(live) !== liveVersion) fail("writers-active", "Supervisor changed during snapshot; stop writers and retry");
      manifest = { version: 1, supervisorPath, threadPath, supervisorSha, threadSha,
        tables: TABLES.filter(name => tables(live).has(name)), createdAt: new Date().toISOString() };
      await immutableFile(manifestPath, file => writeAll(file, Buffer.from(JSON.stringify(manifest) + "\n")));
      fresh = true;
    } else {
      const file = await open(manifestPath, "r");
      try { manifest = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
    }
    if (manifest.version !== 1 || manifest.supervisorPath !== supervisorPath || manifest.threadPath !== threadPath
      || !Array.isArray(manifest.tables) || manifest.tables.some(name => !TABLES.includes(name))) fail("snapshot-binding", "Snapshot receipt does not belong to these inputs");
    for (const [name, expected] of [["supervisor.sqlite", manifest.supervisorSha], ["threads.sqlite", manifest.threadSha]]) {
      if (await digest(join(output, name)) !== expected) fail("snapshot-corrupt", `Immutable snapshot failed hash: ${name}`);
    }
    source = new DatabaseSync(join(output, "supervisor.sqlite"), { readOnly: true });
    mapping = new DatabaseSync(join(output, "threads.sqlite"), { readOnly: true });
    requireColumns(mapping, "thread", ["id", "session_file"]);
    journal = new DatabaseSync(join(output, "receipt.sqlite"));
    journal.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS migration(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL CHECK(state IN ('promoting','retirement-ready','complete')));
      INSERT OR IGNORE INTO migration VALUES(1,'promoting');
      CREATE TABLE IF NOT EXISTS native(session_id TEXT PRIMARY KEY,path TEXT NOT NULL,preimage TEXT NOT NULL,before_sha TEXT NOT NULL,
        after_sha TEXT,state TEXT NOT NULL CHECK(state IN ('preserved','prepared','complete')),mode INTEGER NOT NULL,
        promoted INTEGER NOT NULL DEFAULT 0,existing INTEGER NOT NULL DEFAULT 0,different INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS matched(session_id TEXT NOT NULL,finalizes_message TEXT NOT NULL,new_key TEXT NOT NULL,PRIMARY KEY(session_id,finalizes_message));
      CREATE TABLE IF NOT EXISTS fact_source(session_id TEXT NOT NULL,finalizes_message TEXT NOT NULL,thinking TEXT NOT NULL,PRIMARY KEY(session_id,finalizes_message));
      CREATE TABLE IF NOT EXISTS preserved_orphans(session_id TEXT PRIMARY KEY,facts INTEGER NOT NULL,capture_rows INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_sessions(session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS preserved_capture_only(session_id TEXT PRIMARY KEY,native_state TEXT NOT NULL CHECK(native_state IN ('present','unavailable','unmapped')));`);
    journal.prepare("ATTACH DATABASE ? AS source_snapshot").run(join(output, "supervisor.sqlite"));
    journal.prepare("ATTACH DATABASE ? AS thread_snapshot").run(join(output, "threads.sqlite"));
    journal.exec("PRAGMA temp_store=FILE; PRAGMA cache_size=-4096");
    const sourceTables = tables(source);
    const factColumns = sourceTables.has("message_facts") ? new Set([...source.prepare("PRAGMA table_info(message_facts)").iterate()].map(row => row.name)) : new Set();
    if (factColumns.has("thinking")) {
      requireColumns(source, "message_facts", ["session_id", "finalizes_message", "thinking"]);
      journal.exec(`INSERT OR IGNORE INTO fact_source SELECT session_id,finalizes_message,thinking FROM source_snapshot.message_facts WHERE thinking IS NOT NULL AND length(thinking)>0`);
    }
    if (sourceTables.has("events")) {
      requireColumns(source, "events", ["session_id", "type", "payload"]);
      journal.exec(`INSERT OR IGNORE INTO fact_source
        SELECT session_id,json_extract(payload,'$.finalizesMessage'),MAX(json_extract(payload,'$.text'))
        FROM source_snapshot.events WHERE type='thinking' AND json_extract(payload,'$.finalizesMessage') IS NOT NULL
        GROUP BY session_id,json_extract(payload,'$.finalizesMessage') HAVING length(MAX(json_extract(payload,'$.text')))>0`);
    }
    journal.exec("INSERT OR IGNORE INTO source_sessions SELECT DISTINCT session_id FROM fact_source");
    journal.exec("DELETE FROM preserved_orphans");
    journal.exec(`INSERT INTO preserved_orphans SELECT f.session_id,COUNT(*),0 FROM fact_source f
      WHERE NOT EXISTS(SELECT 1 FROM thread_snapshot.thread t WHERE t.id=f.session_id) GROUP BY f.session_id`);
    for (const name of manifest.tables) {
      const columns = new Set([...source.prepare(`PRAGMA table_info(${name})`).iterate()].map(row => row.name));
      if (columns.has("session_id")) {
        journal.exec(`INSERT OR IGNORE INTO source_sessions SELECT DISTINCT session_id FROM source_snapshot.${name} WHERE session_id IS NOT NULL`);
        journal.exec(`INSERT INTO preserved_orphans
          SELECT s.session_id,0,COUNT(*) FROM source_snapshot.${name} s WHERE s.session_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM thread_snapshot.thread t WHERE t.id=s.session_id) GROUP BY s.session_id
          ON CONFLICT(session_id) DO UPDATE SET capture_rows=preserved_orphans.capture_rows+excluded.capture_rows`);
      }
    }
    const state = journal.prepare("SELECT state FROM migration WHERE id=1").get().state;
    const liveTables = tables(live);
    const remaining = manifest.tables.filter(name => liveTables.has(name));
    if (remaining.length && remaining.length !== manifest.tables.length) fail("partial-retirement", "Only part of the snapshotted schema remains; refusing to infer retirement");
    if (!remaining.length && manifest.tables.length && state === "promoting") fail("unreceipted-retirement", "Captured tables were removed before migration reached retirement-ready");
    if (remaining.length && !fresh) {
      const checkPath = join(output, "live-check.sqlite");
      const current = await sqliteSnapshot(live, checkPath);
      await unlink(checkPath);
      if (current !== manifest.supervisorSha) fail("supervisor-changed", "Supervisor differs from immutable source snapshot; do not reuse this migration directory for different data");
    }
    for (const row of journal.prepare(`SELECT s.session_id FROM source_sessions s
      WHERE NOT EXISTS(SELECT 1 FROM fact_source f WHERE f.session_id=s.session_id) ORDER BY s.session_id`).iterate()) {
      const mapped = mapping.prepare("SELECT session_file FROM thread WHERE id=?").get(row.session_id);
      const nativeState = !mapped?.session_file ? 'unmapped' : await exists(mapped.session_file) ? 'present' : 'unavailable';
      journal.prepare("INSERT OR REPLACE INTO preserved_capture_only VALUES(?,?)").run(row.session_id, nativeState);
    }
    for (const row of journal.prepare(`SELECT DISTINCT f.session_id FROM fact_source f
      WHERE NOT EXISTS(SELECT 1 FROM preserved_orphans o WHERE o.session_id=f.session_id) ORDER BY f.session_id`).iterate()) {
      await processSession(mapping, journal, output, row.session_id);
    }
    if (state === "complete" && remaining.length) fail("schema-recreated", "Retired tables were recreated after completed migration");
    journal.prepare("UPDATE migration SET state='retirement-ready' WHERE id=1").run();
    live.exec("BEGIN IMMEDIATE");
    try {
      if (version(live) !== liveVersion) fail("writers-active", "Supervisor changed while native history was being promoted; no captured tables were retired");
      if (state !== "complete" && (remaining.length || !manifest.tables.length)) {
        live.prepare("ATTACH DATABASE ? AS migration_receipt").run(join(output, "receipt.sqlite"));
        if (tables(live).has("message_facts")) {
          const update = live.prepare("UPDATE message_facts SET finalizes_message=? WHERE session_id=? AND finalizes_message=?");
          for (const row of journal.prepare("SELECT * FROM matched WHERE new_key!=finalizes_message").iterate()) {
            const old = live.prepare("SELECT 1 FROM message_facts WHERE session_id=? AND finalizes_message=?").get(row.session_id, row.finalizes_message);
            if (!old) continue;
            if (live.prepare("SELECT 1 FROM message_facts WHERE session_id=? AND finalizes_message=?").get(row.session_id, row.new_key)) fail("fact-key-conflict", `Metric join collision for ${row.session_id}; retirement transaction rolled back`);
            update.run(row.new_key, row.session_id, row.finalizes_message);
          }
          const columns = new Set([...live.prepare("PRAGMA table_info(message_facts)").iterate()].map(row => row.name));
          if (columns.has("thinking")) live.exec("ALTER TABLE message_facts DROP COLUMN thinking");
        }
        if (tables(live).has("events")) live.exec(`UPDATE events SET payload=json_set(payload,'$.finalizesMessage',
          (SELECT new_key FROM migration_receipt.matched m WHERE m.session_id=events.session_id AND m.finalizes_message=json_extract(events.payload,'$.finalizesMessage')))
          WHERE type IN ('thinking','metrics') AND EXISTS
          (SELECT 1 FROM migration_receipt.matched m WHERE m.session_id=events.session_id AND m.finalizes_message=json_extract(events.payload,'$.finalizesMessage') AND m.new_key!=m.finalizes_message)`);
      }
      for (const name of remaining) live.exec(`DROP TABLE "${name}"`);
      live.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      live.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('native_history_contract','native-history-v1')").run();
      live.exec("COMMIT");
    } catch (error) { live.exec("ROLLBACK"); throw error; }
    journal.prepare("UPDATE migration SET state='complete' WHERE id=1").run();
    await syncDirectory(output);
    const sums = journal.prepare("SELECT COALESCE(SUM(promoted),0) AS promoted,COALESCE(SUM(existing),0) AS existing,COALESCE(SUM(different),0) AS different FROM native").get();
    const facts = journal.prepare("SELECT COUNT(*) AS n FROM fact_source").get().n;
    const matched = journal.prepare("SELECT COUNT(*) AS n FROM matched").get().n;
    const orphans = journal.prepare("SELECT COUNT(*) AS sessions,COALESCE(SUM(facts),0) AS facts,COALESCE(SUM(capture_rows),0) AS captureRows FROM preserved_orphans").get();
    const orphanNames = [...journal.prepare("SELECT session_id AS sessionId,facts,capture_rows AS captureRows FROM preserved_orphans ORDER BY session_id LIMIT 20").iterate()].map(row => ({ ...row }));
    return { state: "complete", outputDir: output, retiredTables: manifest.tables, ...sums, unmatchedFacts: facts - matched,
      preservedOrphans: { ...orphans, firstSessions: orphanNames },
      preservedCaptureOnly: [...journal.prepare("SELECT native_state AS nativeState,COUNT(*) AS sessions FROM preserved_capture_only GROUP BY native_state ORDER BY native_state").iterate()].map(row => ({ ...row })), 
      supervisorSnapshot: join(output, "supervisor.sqlite"), receipt: join(output, "receipt.sqlite") };
  } finally {
    for (const db of [journal, mapping, source, live, lock]) if (db) db.close();
  }
}

export async function migrateNativeHistory(options) {
  try { return { ok: true, value: await migrate(options) }; }
  catch (error) { return { ok: false, error: errorData(error) }; }
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--writers-stopped") { options.writersStopped = true; continue; }
    const field = { "--supervisor-db": "supervisorDb", "--thread-db": "threadDb", "--output-dir": "outputDir" }[arg];
    if (!field || !args[index + 1] || args[index + 1].startsWith("--") || Object.hasOwn(options, field)) fail("arguments", `Invalid or repeated argument: ${arg}`);
    options[field] = args[++index];
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result;
  try { result = await migrateNativeHistory(parseArguments(process.argv.slice(2))); }
  catch (error) { result = { ok: false, error: errorData(error) }; }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
