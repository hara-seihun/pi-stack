import { Database } from "bun:sqlite";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureSupervisorSchema, updateLastThreadNumber } from "./database";

const TABLES = ["sessions", "events", "session_contexts", "requests", "work_items", "uploads"] as const;
type Table = typeof TABLES[number];
type Row = Record<string, unknown>;
type FileRecord = { sessionId: string; source: string; relative: string; sha256: string };
type Bundle = {
  version: 1;
  sourceTarget: string;
  createdAt: string;
  tables: Record<Table, Row[]>;
  sessionFiles: FileRecord[];
  serviceTiers: FileRecord[];
  uploads: FileRecord[];
};

function sha256(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function copyRecord(sessionId: string, source: string, relative: string, bundleRoot: string): FileRecord {
  const destination = join(bundleRoot, relative);
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  return { sessionId, source, relative, sha256: sha256(destination) };
}

function relatedRows(db: Database, table: Exclude<Table, "sessions">, ids: string[]): Row[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.query(`SELECT * FROM ${table} WHERE session_id IN (${placeholders})`).all(...ids) as Row[];
}

function assertSettled(tables: Bundle["tables"]): void {
  const active = tables.sessions.filter((row) => !["STOPPED", "FAILED"].includes(String(row.state)));
  if (active.length > 0) throw new Error(`${active.length} sessions are still active`);
  const pending = tables.work_items.filter((row) => ["queued", "running", "dispatched"].includes(String(row.state)));
  if (pending.length > 0) throw new Error(`${pending.length} work items are not settled`);
}

function hasSessionContent(tables: Bundle["tables"], sessionId: string): boolean {
  for (const table of [tables.events, tables.session_contexts, tables.work_items, tables.uploads]) {
    if (table.some((row) => String(row.session_id) === sessionId)) return true;
  }
  return tables.requests.some((row) =>
    String(row.session_id) === sessionId && String(row.kind) !== "create");
}

export function exportSessions(options: { dbPath: string; dataRoot: string; target: string; bundleRoot: string }): Bundle {
  if (existsSync(options.bundleRoot)) throw new Error(`Bundle path already exists at ${options.bundleRoot}`);
  mkdirSync(dirname(options.bundleRoot), { recursive: true, mode: 0o700 });
  const stagingRoot = `${options.bundleRoot}.partial-${randomUUID()}`;
  mkdirSync(stagingRoot, { mode: 0o700 });
  const db = new Database(options.dbPath, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const sessions = db.query("SELECT * FROM sessions WHERE execution_target=? ORDER BY created_at,id").all(options.target) as Row[];
    if (sessions.length === 0) throw new Error(`No sessions use execution target ${options.target}`);
    const ids = sessions.map((row) => String(row.id));
    const tables = {
      sessions,
      events: relatedRows(db, "events", ids),
      session_contexts: relatedRows(db, "session_contexts", ids),
      requests: relatedRows(db, "requests", ids),
      work_items: relatedRows(db, "work_items", ids),
      uploads: relatedRows(db, "uploads", ids),
    };
    assertSettled(tables);

    const sessionFiles: FileRecord[] = [];
    const serviceTiers: FileRecord[] = [];
    const uploads: FileRecord[] = [];
    for (const row of sessions) {
      const id = String(row.id);
      const path = row.session_path == null ? "" : String(row.session_path);
      if (path) {
        if (!existsSync(path)) {
          if (hasSessionContent(tables, id)) throw new Error(`Session ${id} is missing ${path}`);
        } else {
          sessionFiles.push(copyRecord(id, path, join("sessions", basename(path)), stagingRoot));
        }
      }
      const tier = join(options.dataRoot, "service-tiers", id);
      if (existsSync(tier)) serviceTiers.push(copyRecord(id, tier, join("service-tiers", id), stagingRoot));
    }
    for (const row of tables.uploads) {
      const path = String(row.path);
      if (existsSync(path)) uploads.push(copyRecord(String(row.session_id), path,
        join("uploads", String(row.session_id), basename(path)), stagingRoot));
    }
    const bundle: Bundle = { version: 1, sourceTarget: options.target, createdAt: new Date().toISOString(), tables, sessionFiles, serviceTiers, uploads };
    writeFileSync(join(stagingRoot, "manifest.json"), JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
    renameSync(stagingRoot, options.bundleRoot);
    return bundle;
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    db.close();
  }
}

function loadBundle(bundleRoot: string): Bundle {
  const bundle = JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as Bundle;
  if (bundle.version !== 1) throw new Error("Unknown session bundle version");
  assertSettled(bundle.tables);
  for (const group of [bundle.sessionFiles, bundle.serviceTiers, bundle.uploads]) {
    for (const file of group) {
      const path = join(bundleRoot, file.relative);
      if (!existsSync(path) || sha256(path) !== file.sha256) throw new Error(`Bundle file failed verification: ${file.relative}`);
    }
  }
  return bundle;
}

function insertRows(db: Database, table: Table, rows: Row[]): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    const placeholders = columns.map(() => "?").join(",");
    db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`).run(...values as any[]);
  }
}

export function importSessions(options: { dbPath: string; dataRoot: string; bundleRoot: string }): Bundle {
  const bundle = loadBundle(options.bundleRoot);
  mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 });
  const db = new Database(options.dbPath, { create: true, strict: true });
  ensureSupervisorSchema(db);
  const existing = Number((db.query("SELECT COUNT(*) count FROM sessions").get() as any).count);
  if (existing !== 0) {
    db.close();
    throw new Error(`Destination already has ${existing} sessions`);
  }

  const fileBySession = new Map(bundle.sessionFiles.map((file) => [file.sessionId, file]));
  const sessions = bundle.tables.sessions.map((row) => {
    const file = fileBySession.get(String(row.id));
    return {
      ...row,
      session_path: file ? join(options.dataRoot, file.relative) : null,
      execution_target: "local",
      remote_cwd: null,
    };
  });
  const copiedUpload = new Map(bundle.uploads.map((file) => [`${file.sessionId}\u0000${file.source}`, file]));
  const uploads = bundle.tables.uploads.map((row) => {
    const file = copiedUpload.get(`${row.session_id}\u0000${row.path}`);
    return { ...row, path: file ? join(options.dataRoot, file.relative) : row.path, environment: "local" };
  });

  const copied: string[] = [];
  try {
    for (const file of [...bundle.sessionFiles, ...bundle.serviceTiers, ...bundle.uploads]) {
      const destination = join(options.dataRoot, file.relative);
      mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      copyFileSync(join(options.bundleRoot, file.relative), destination, constants.COPYFILE_EXCL);
      copied.push(destination);
      if (sha256(destination) !== file.sha256) throw new Error(`Imported file failed verification: ${file.relative}`);
    }
    const transaction = db.transaction(() => {
      insertRows(db, "sessions", sessions);
      insertRows(db, "events", bundle.tables.events);
      insertRows(db, "session_contexts", bundle.tables.session_contexts);
      insertRows(db, "requests", bundle.tables.requests);
      insertRows(db, "work_items", bundle.tables.work_items);
      insertRows(db, "uploads", uploads);
      updateLastThreadNumber(db);
      db.query("INSERT INTO metadata(key,value) VALUES(?,?)").run(`session-migration:${bundle.sourceTarget}`, bundle.createdAt);
    });
    transaction();
    return bundle;
  } catch (error) {
    for (const path of copied.reverse()) {
      try { unlinkSync(path); } catch {}
    }
    throw error;
  } finally {
    db.close();
  }
}

export function removeExportedSessions(options: { dbPath: string; bundleRoot: string }): number {
  const bundle = loadBundle(options.bundleRoot);
  const ids = bundle.tables.sessions.map((row) => String(row.id));
  const db = new Database(options.dbPath, { strict: true });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const placeholders = ids.map(() => "?").join(",");
  const current = db.query(`SELECT id,state,execution_target,session_path FROM sessions WHERE id IN (${placeholders})`).all(...ids) as any[];
  if (current.length !== ids.length) throw new Error(`Source has ${current.length} of ${ids.length} bundled sessions`);
  const files = new Map(bundle.sessionFiles.map((file) => [file.sessionId, file]));
  for (const session of current) {
    if (session.execution_target !== bundle.sourceTarget || !["STOPPED", "FAILED"].includes(session.state))
      throw new Error(`Source session ${session.id} changed after export`);
    const file = files.get(String(session.id));
    if (file && (!existsSync(session.session_path) || sha256(session.session_path) !== file.sha256))
      throw new Error(`Source session file ${session.id} changed after export`);
  }
  const transaction = db.transaction(() => {
    for (const table of ["uploads", "work_items", "requests", "session_contexts", "events"])
      db.query(`DELETE FROM ${table} WHERE session_id IN (${placeholders})`).run(...ids);
    db.query(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  });
  transaction();
  db.close();
  return ids.length;
}

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`Invalid argument ${key ?? ""}`);
    result[key.slice(2)] = value;
  }
  return result;
}

if (import.meta.main) {
  const command = process.argv[2];
  const values = options(process.argv.slice(3));
  if (command === "export") {
    const bundle = exportSessions({ dbPath: values.db, dataRoot: values.data, target: values.target, bundleRoot: values.bundle });
    console.log(`exported ${bundle.tables.sessions.length} ${bundle.sourceTarget} sessions to ${values.bundle}`);
  } else if (command === "import") {
    const bundle = importSessions({ dbPath: values.db, dataRoot: values.data, bundleRoot: values.bundle });
    console.log(`imported ${bundle.tables.sessions.length} sessions into ${values.data}`);
  } else if (command === "remove-source") {
    console.log(`removed ${removeExportedSessions({ dbPath: values.db, bundleRoot: values.bundle })} exported sessions`);
  } else {
    console.error("usage: bun server/session-migration.ts export --db DB --data DATA --target TARGET --bundle DIR");
    console.error("       bun server/session-migration.ts import --db DB --data DATA --bundle DIR");
    console.error("       bun server/session-migration.ts remove-source --db DB --bundle DIR");
    process.exit(2);
  }
}
