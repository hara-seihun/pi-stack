import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_BASH_TIMEOUT_SECONDS } from "./protocol";

export function ensureSupervisorSchema(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
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
  meeting_id TEXT,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  service_tier TEXT NOT NULL DEFAULT 'default',
  bash_timeout_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_BASH_TIMEOUT_SECONDS},
  archived_at TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  named_at_message_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS idle_notifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  time TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS session_became_idle AFTER UPDATE OF state ON sessions
WHEN NEW.state = 'IDLE' AND OLD.state IN ('RUNNING', 'ABORTING')
BEGIN
  INSERT INTO idle_notifications(session_id,name,time) VALUES(NEW.id,NEW.name,NEW.updated_at);
END;
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
  images TEXT NOT NULL DEFAULT '[]',
  meeting_transcript TEXT NOT NULL DEFAULT '[]',
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
CREATE TABLE IF NOT EXISTS thread_delegations (
  work_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  reply_work_id TEXT REFERENCES work_items(id)
);
CREATE TABLE IF NOT EXISTS subagents (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subagents_parent ON subagents(parent_session_id);
CREATE TRIGGER IF NOT EXISTS subagent_identity_immutable BEFORE UPDATE ON subagents
BEGIN
  SELECT RAISE(ABORT, 'Subagent identity is immutable');
END;
CREATE TABLE IF NOT EXISTS delegation_results (
  work_id TEXT PRIMARY KEY REFERENCES thread_delegations(work_id) ON DELETE CASCADE,
  result TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE TRIGGER IF NOT EXISTS delegation_completed AFTER UPDATE OF state ON work_items
WHEN NEW.state IN ('complete','cancelled') AND OLD.state NOT IN ('complete','cancelled')
  AND EXISTS (SELECT 1 FROM thread_delegations WHERE work_id=NEW.id)
BEGIN
  INSERT OR IGNORE INTO delegation_results(work_id,result,status,error)
  VALUES(NEW.id, COALESCE((SELECT json_extract(payload,'$.text') FROM events
    WHERE session_id=NEW.session_id AND seq>NEW.event_seq AND type='assistant' AND NEW.event_seq>0
    ORDER BY seq DESC LIMIT 1), ''),
    CASE WHEN NEW.state='cancelled' THEN 'cancelled' WHEN NEW.last_error IS NOT NULL THEN 'failed' ELSE 'complete' END,
    NEW.last_error);
END;
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
  for (const [name, type] of [["initial_provider", "TEXT"], ["current_provider", "TEXT"], ["initial_model", "TEXT"], ["initial_thinking", "TEXT"], ["meeting_id", "TEXT"], ["revision", "INTEGER NOT NULL DEFAULT 0"], ["service_tier", "TEXT NOT NULL DEFAULT 'default'"], ["bash_timeout_seconds", `INTEGER NOT NULL DEFAULT ${DEFAULT_BASH_TIMEOUT_SECONDS}`], ["archived_at", "TEXT"], ["display_order", "INTEGER NOT NULL DEFAULT 0"], ["admission_priority", "INTEGER NOT NULL DEFAULT 0"]]) {
    if (!sessionColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
  if (!sessionColumns.has("named_at_message_count")) {
    db.exec("ALTER TABLE sessions ADD COLUMN named_at_message_count INTEGER NOT NULL DEFAULT 0");
    db.exec(`UPDATE sessions SET named_at_message_count=(
      SELECT COUNT(*) FROM events WHERE events.session_id=sessions.id AND events.type IN ('user','assistant')
    )`);
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
  if (!workColumns.has("images")) db.exec("ALTER TABLE work_items ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
  if (!workColumns.has("meeting_transcript")) db.exec("ALTER TABLE work_items ADD COLUMN meeting_transcript TEXT NOT NULL DEFAULT '[]'");
  if (!workColumns.has("inserted_at")) {
    db.exec("ALTER TABLE work_items ADD COLUMN inserted_at TEXT");
    db.exec("UPDATE work_items SET inserted_at=created_at WHERE event_seq>0");
  }
  db.exec(`INSERT OR IGNORE INTO subagents(session_id,parent_session_id,provider,model)
    SELECT w.session_id,d.parent_session_id,s.initial_provider,s.initial_model
    FROM thread_delegations d JOIN work_items w ON w.id=d.work_id JOIN sessions s ON s.id=w.session_id
    WHERE s.initial_provider IS NOT NULL AND s.initial_model IS NOT NULL ORDER BY w.rowid;
    INSERT OR IGNORE INTO delegation_results(work_id,result,status,error)
    SELECT w.id,COALESCE((SELECT json_extract(e.payload,'$.text') FROM events e
      WHERE e.session_id=w.session_id AND e.seq>w.event_seq AND e.type='assistant' AND w.event_seq>0
      AND e.seq<COALESCE((SELECT MIN(boundary.seq) FROM events boundary
        WHERE boundary.session_id=w.session_id AND boundary.seq>w.event_seq AND boundary.type='settled'),9223372036854775807)
      ORDER BY e.seq DESC LIMIT 1),''),
      CASE WHEN w.state='cancelled' THEN 'cancelled' WHEN w.last_error IS NOT NULL THEN 'failed' ELSE 'complete' END,w.last_error
    FROM thread_delegations d JOIN work_items w ON w.id=d.work_id WHERE w.state IN ('complete','cancelled');
    UPDATE work_items SET delivery='steer' WHERE state IN ('queued','running') AND delivery='followUp'
      AND id IN (SELECT reply_work_id FROM thread_delegations WHERE reply_work_id IS NOT NULL);`);
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
