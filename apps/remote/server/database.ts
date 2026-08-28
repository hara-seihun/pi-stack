import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";

export function ensureSupervisorSchema(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
  db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_path TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  initial_provider TEXT,
  current_provider TEXT,
  initial_model TEXT,
  initial_thinking TEXT,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  service_tier TEXT NOT NULL DEFAULT 'default',
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  time TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS session_contexts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  context TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_context_patches (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  base_hash TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  prefix_bytes INTEGER NOT NULL,
  delete_bytes INTEGER NOT NULL,
  insert_base64 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_context_patches_session_seq ON session_context_patches(session_id, seq);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  event_seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'followUp',
  resume INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  inserted_at TEXT
);
CREATE INDEX IF NOT EXISTS work_items_session_state ON work_items(session_id, state, available_at);
CREATE TABLE IF NOT EXISTS uploads (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_session ON uploads(session_id);
CREATE TABLE IF NOT EXISTS upload_transfers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  received_size INTEGER NOT NULL DEFAULT 0,
  temp_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
  const sessionColumns = new Set((db.query("PRAGMA table_info(sessions)").all() as any[]).map((column) => String(column.name)));
  for (const [name, type] of [["initial_provider", "TEXT"], ["current_provider", "TEXT"], ["initial_model", "TEXT"], ["initial_thinking", "TEXT"], ["revision", "INTEGER NOT NULL DEFAULT 0"], ["service_tier", "TEXT NOT NULL DEFAULT 'default'"], ["archived_at", "TEXT"]]) {
    if (!sessionColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
  if (!sessionColumns.has("profile_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN profile_id TEXT");
    if (sessionColumns.has("execution_target")) {
      db.exec(`UPDATE sessions SET profile_id = CASE
        WHEN execution_target <> 'local' THEN execution_target
        WHEN workspace_id = 'home' THEN 'home'
        WHEN workspace_id IN ('hara', 'sibyl', 'private') THEN 'personal'
        ELSE workspace_id END`);
    } else {
      db.exec("UPDATE sessions SET profile_id = workspace_id");
    }
  }
  if (sessionColumns.has("remote_cwd")) db.exec("ALTER TABLE sessions DROP COLUMN remote_cwd");
  if (sessionColumns.has("execution_target")) db.exec("ALTER TABLE sessions DROP COLUMN execution_target");
  const uploadColumns = new Set((db.query("PRAGMA table_info(uploads)").all() as any[]).map((column) => String(column.name)));
  if (uploadColumns.has("environment")) db.exec("ALTER TABLE uploads DROP COLUMN environment");
  const workColumns = new Set((db.query("PRAGMA table_info(work_items)").all() as any[]).map((column) => String(column.name)));
  if (!workColumns.has("delivery")) db.exec("ALTER TABLE work_items ADD COLUMN delivery TEXT NOT NULL DEFAULT 'followUp'");
  if (!workColumns.has("resume")) db.exec("ALTER TABLE work_items ADD COLUMN resume INTEGER NOT NULL DEFAULT 0");
  if (!workColumns.has("inserted_at")) {
    db.exec("ALTER TABLE work_items ADD COLUMN inserted_at TEXT");
    db.exec("UPDATE work_items SET inserted_at=created_at WHERE event_seq>0");
  }
}

export function beginSupervisorGeneration(db: Database, epoch: string, retainedSessions: ReadonlySet<string> = new Set()): void {
  db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES('supervisor_epoch',?)").run(epoch);
  db.query("UPDATE sessions SET initial_provider='openai-codex' WHERE initial_provider IS NULL OR initial_provider=''").run();
  for (const row of db.query("SELECT id,session_path,initial_provider FROM sessions WHERE current_provider IS NULL OR current_provider='' ").all() as any[]) {
    let provider = String(row.initial_provider || "openai-codex");
    if (row.session_path && existsSync(row.session_path)) {
      try {
        const lines = readFileSync(row.session_path, "utf8").trimEnd().split("\n");
        for (let index = lines.length - 1; index >= 0; index--) {
          const recorded = JSON.parse(lines[index])?.message?.provider;
          if (recorded) { provider = String(recorded); break; }
        }
      } catch {}
    }
    db.query("UPDATE sessions SET current_provider=? WHERE id=?").run(provider, row.id);
  }
  updateLastThreadNumber(db);
  const time = new Date().toISOString();
  const retained = [...retainedSessions];
  const placeholders = retained.map(() => "?").join(",");
  const sessionFilter = retained.length ? ` AND id NOT IN (${placeholders})` : "";
  const workFilter = retained.length ? ` AND session_id NOT IN (${placeholders})` : "";
  db.query(`UPDATE sessions SET state='STOPPED', updated_at=?, last_error=NULL, revision=revision+1 WHERE (state NOT IN ('STOPPED','FAILED') OR (state='FAILED' AND last_error='Agent exited 143'))${sessionFilter}`)
    .run(time, ...retained);
  db.query(`UPDATE work_items SET state='queued', resume=CASE WHEN state='dispatched' THEN 1 ELSE resume END, available_at=?, updated_at=? WHERE state IN ('running','dispatched')${workFilter}`)
    .run(Date.now(), time, ...retained);
  if (retained.length) {
    db.query(`UPDATE work_items SET state='queued',available_at=?,updated_at=? WHERE state='running' AND session_id IN (${placeholders})`)
      .run(Date.now(), time, ...retained);
  }

}

export function updateLastThreadNumber(db: Database): void {
  const highest = Math.max(0, ...(db.query("SELECT name FROM sessions").all() as any[])
    .map((session) => /^\d+$/.test(session.name) ? Number(session.name) : 0));
  const stored = Number((db.query("SELECT value FROM metadata WHERE key='last_thread_number'").get() as any)?.value ?? 0);
  db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES('last_thread_number',?)").run(String(Math.max(highest, stored)));
}
