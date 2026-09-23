import type { Database } from "bun:sqlite";
import type { ThreadColor } from "./protocol";

/** Remote stores presentation and attachments. ThreadService owns identity and execution. */
export function ensureSupervisorSchema(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
  db.exec(`
CREATE TABLE IF NOT EXISTS thread_views (
  id TEXT PRIMARY KEY,
  idle_unread INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  named_at_message_count INTEGER NOT NULL DEFAULT 0,
  naming_request TEXT,
  naming_attempted_count INTEGER NOT NULL DEFAULT 0,
  naming_error TEXT,
  color TEXT CHECK(color IN ('red','orange','yellow','green','blue','purple') OR color IS NULL)
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
CREATE TABLE IF NOT EXISTS message_annotations (
  work_id TEXT PRIMARY KEY,
  session_id TEXT,
  created_at TEXT,
  meeting_transcript TEXT NOT NULL
);
-- What the supervisor measured about one finished assistant message: the
-- thinking it streamed and how fast the response arrived. Both join to the
-- message they finalize, which is how the transcript puts them back.
CREATE TABLE IF NOT EXISTS message_facts (
  session_id TEXT NOT NULL REFERENCES thread_views(id) ON DELETE CASCADE,
  finalizes_message TEXT NOT NULL,
  thinking TEXT,
  metrics TEXT,
  PRIMARY KEY (session_id, finalizes_message)
);
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
  if (viewColumns.has("display_order")) db.exec("ALTER TABLE thread_views DROP COLUMN display_order");
  db.query("DELETE FROM metadata WHERE key='current_chat_order'").run();
  for (const [name, type] of [["naming_request", "TEXT"], ["naming_attempted_count", "INTEGER NOT NULL DEFAULT 0"], ["naming_error", "TEXT"], ["message_count", "INTEGER NOT NULL DEFAULT 0"], ["color", "TEXT CHECK(color IN ('red','orange','yellow','green','blue','purple') OR color IS NULL)"]]) {
    if (!viewColumns.has(name)) db.exec(`ALTER TABLE thread_views ADD COLUMN ${name} ${type}`);
  }
  const annotationColumns = new Set((db.query("PRAGMA table_info(message_annotations)").all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, type] of [["session_id", "TEXT"], ["created_at", "TEXT"]]) {
    if (!annotationColumns.has(name)) db.exec(`ALTER TABLE message_annotations ADD COLUMN ${name} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS message_annotations_session ON message_annotations(session_id, created_at)");
  const notifications = db.query("PRAGMA table_info(idle_notifications)").all() as Array<{ name: string }>;
  if (!notifications.some(column => column.name === "receipt_id")) db.exec("ALTER TABLE idle_notifications ADD COLUMN receipt_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idle_notifications_receipt ON idle_notifications(receipt_id)");
  retireEventJournal(db);
}

/** The `events` table was a general journal: presentation, voice projection and
 * two durable joins in one place, growing without bound. Its durable facts move
 * to `message_facts`, `thread_views.message_count` and `message_annotations`;
 * the live projection owns what is left.
 *
 * A supervisor has to answer its health check within seconds of starting, so
 * this reads the journal in one pass per fact rather than once per row it
 * writes. On this host's million-row journal the first shape took 25 seconds
 * for a single correlated update and cost a release its activation; the pass
 * below takes under two. Dropping the table is slower than reading it, so
 * `dropEventJournal` does that once the supervisor is already serving.
 */
function retireEventJournal(db: Database): void {
  const present = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
  const done = db.query("SELECT value FROM metadata WHERE key='events_retired'").get() as { value: string } | null;
  if (!present || done) return;
  db.transaction(() => {
    db.exec(`INSERT OR REPLACE INTO message_facts(session_id,finalizes_message,thinking,metrics)
      SELECT session_id, json_extract(payload,'$.finalizesMessage') AS finalized,
        MAX(CASE WHEN type='thinking' THEN json_extract(payload,'$.text') END),
        MAX(CASE WHEN type='metrics' THEN json_extract(payload,'$.metrics') END)
      FROM events
      WHERE type IN ('thinking','metrics') AND json_extract(payload,'$.finalizesMessage') IS NOT NULL
      GROUP BY session_id, finalized`);
    db.exec("DELETE FROM message_facts WHERE thinking IS NULL AND metrics IS NULL");
    db.exec(`CREATE TEMP TABLE counted AS
      SELECT session_id, COUNT(*) AS total FROM events WHERE type IN ('user','assistant') GROUP BY session_id`);
    db.exec("CREATE INDEX temp.counted_session ON counted(session_id)");
    db.exec(`UPDATE thread_views SET message_count=MAX(message_count,
      (SELECT total FROM counted WHERE counted.session_id=thread_views.id))
      WHERE id IN (SELECT session_id FROM counted)`);
    db.exec(`CREATE TEMP TABLE work_origin AS
      SELECT json_extract(payload,'$.workId') AS work_id, session_id, MIN(time) AS time FROM events
      WHERE type='user' AND json_extract(payload,'$.workId') IS NOT NULL GROUP BY work_id`);
    db.exec("CREATE INDEX temp.work_origin_id ON work_origin(work_id)");
    db.exec(`UPDATE message_annotations SET
      session_id=(SELECT session_id FROM work_origin WHERE work_origin.work_id=message_annotations.work_id),
      created_at=(SELECT time FROM work_origin WHERE work_origin.work_id=message_annotations.work_id)
      WHERE session_id IS NULL AND work_id IN (SELECT work_id FROM work_origin)`);
    db.exec("DROP TABLE temp.counted");
    db.exec("DROP TABLE temp.work_origin");
    db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES('events_retired',?)").run(new Date().toISOString());
  })();
}

/** Removes the migrated journal a slice at a time, answering whether any is
 * left. The supervisor serves requests on one thread, and secure delete makes
 * removing a million rows a multi-second operation: doing it in one statement
 * stalled the health and report checks of publication PUB-3ce515df long enough
 * to fail it. A slice is a few milliseconds, the table drops once it is empty,
 * and an interrupted supervisor simply continues where it stopped. */
export function removeEventJournal(db: Database, slice = 2_000): "removing" | "removed" {
  const present = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
  if (!present) return "removed";
  const deleted = db.query("DELETE FROM events WHERE seq IN (SELECT seq FROM events LIMIT ?)").run(slice).changes;
  if (deleted) return "removing";
  db.exec("DROP TABLE events");
  return "removed";
}

export function beginSupervisorGeneration(db: Database, epoch: string): void {
  db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES('supervisor_epoch',?)").run(epoch);
}

export function ensureThreadView(db: Database, id: string): void {
  db.query("INSERT OR IGNORE INTO thread_views(id) VALUES(?)").run(id);
}

export function setThreadColor(db: Database, id: string, color: ThreadColor | null): void {
  db.transaction(() => {
    ensureThreadView(db, id);
    db.query("UPDATE thread_views SET color=? WHERE id=?").run(color, id);
  })();
}

export function recordIdleNotification(db: Database, receiptId: string, thread: { id: string; title: string }, time: number): void {
  db.transaction(() => {
    ensureThreadView(db, thread.id);
    const inserted = db.query("INSERT OR IGNORE INTO idle_notifications(session_id,name,time,receipt_id) VALUES(?,?,?,?)")
      .run(thread.id, thread.title, new Date(time).toISOString(), receiptId);
    if (inserted.changes) db.query("UPDATE thread_views SET idle_unread=1 WHERE id=?").run(thread.id);
  })();
}
