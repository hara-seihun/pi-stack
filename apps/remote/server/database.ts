import type { Database } from "bun:sqlite";

/** Remote stores presentation and attachments. ThreadService owns identity and execution. */
export function ensureSupervisorSchema(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
  db.exec(`
CREATE TABLE IF NOT EXISTS thread_views (
  id TEXT PRIMARY KEY,
  display_order INTEGER NOT NULL DEFAULT 0,
  idle_unread INTEGER NOT NULL DEFAULT 0,
  named_at_message_count INTEGER NOT NULL DEFAULT 0,
  naming_request TEXT,
  naming_attempted_count INTEGER NOT NULL DEFAULT 0,
  naming_error TEXT
);
CREATE TABLE IF NOT EXISTS error_feedback (
  source TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  occurrence TEXT NOT NULL,
  dismissed_at INTEGER
);
CREATE TABLE IF NOT EXISTS idle_notifications (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  time TEXT NOT NULL,
  receipt_id TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES thread_views(id) ON DELETE CASCADE,
  time TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  receipt_id TEXT
);
CREATE TABLE IF NOT EXISTS message_annotations (
  work_id TEXT PRIMARY KEY,
  meeting_transcript TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS session_contexts (
  session_id TEXT PRIMARY KEY REFERENCES thread_views(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  context TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_context_patches (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES thread_views(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  base_hash TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  prefix_bytes INTEGER NOT NULL,
  delete_bytes INTEGER NOT NULL,
  insert_base64 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_context_patches_session_seq ON session_context_patches(session_id, seq);
CREATE TABLE IF NOT EXISTS thread_creation_names (
  request_id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES thread_views(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_session ON uploads(session_id);
CREATE TABLE IF NOT EXISTS upload_transfers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES thread_views(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  received_size INTEGER NOT NULL DEFAULT 0,
  temp_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
  const viewColumns = new Set((db.query("PRAGMA table_info(thread_views)").all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, type] of [["naming_request", "TEXT"], ["naming_attempted_count", "INTEGER NOT NULL DEFAULT 0"], ["naming_error", "TEXT"]]) {
    if (!viewColumns.has(name)) db.exec(`ALTER TABLE thread_views ADD COLUMN ${name} ${type}`);
  }
  for (const table of ["events", "idle_notifications"]) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "receipt_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN receipt_id TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_receipt ON ${table}(receipt_id)`);
  }
}

export function beginSupervisorGeneration(db: Database, epoch: string): void {
  db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES('supervisor_epoch',?)").run(epoch);
}

export function ensureThreadView(db: Database, id: string): void {
  db.query("INSERT OR IGNORE INTO thread_views(id) VALUES(?)").run(id);
}

export function recordIdleNotification(db: Database, receiptId: string, thread: { id: string; title: string }, time: number): void {
  db.transaction(() => {
    ensureThreadView(db, thread.id);
    const inserted = db.query("INSERT OR IGNORE INTO idle_notifications(session_id,name,time,receipt_id) VALUES(?,?,?,?)")
      .run(thread.id, thread.title, new Date(time).toISOString(), receiptId);
    if (inserted.changes) db.query("UPDATE thread_views SET idle_unread=1 WHERE id=?").run(thread.id);
  })();
}
