import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/sqlite.js";
import { ThreadService } from "../src/threads/service.js";
import { importRemoteThreads } from "../src/threads/import.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "thread-import-")); roots.push(root);
  const db = openSqlite(join(root, "presentation.sqlite3"));
  const native = join(root, "native.jsonl");
  writeFileSync(native, JSON.stringify({ type: "session", id: "native", version: 3, cwd: root }) + "\n");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,name,workspace_id,session_path,state,created_at,updated_at,initial_model,initial_thinking,service_tier,profile_id,display_order,idle_unread,named_at_message_count);
    CREATE TABLE events(seq INTEGER PRIMARY KEY,session_id REFERENCES sessions(id) ON DELETE CASCADE,payload);
    CREATE INDEX events_session ON events(session_id);
    CREATE TABLE work_items(id TEXT PRIMARY KEY,session_id REFERENCES sessions(id),request_id,text,images,delivery,state,created_at,inserted_at,last_error,meeting_transcript);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TRIGGER delegation_completed AFTER UPDATE OF state ON work_items BEGIN SELECT payload FROM events WHERE session_id=NEW.session_id; END;`);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("thread", "Research", root, native, "STOPPED", "2026-09-01", "2026-09-01", "astra", "high", "default", "personal", 8, 1, 20);
  db.prepare("INSERT INTO events VALUES(1,'thread',?)").run("retained presentation");
  const insert = db.prepare("INSERT INTO work_items VALUES(?,'thread',?,?,'[]','followUp',?,'2026-09-01',NULL,NULL,?)");
  insert.run("complete", "req-complete", "Already answered", "complete", '[{"id":"meet-1"}]');
  insert.run("queued", "req-queued", "Next assignment", "queued", "[]");
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("Import must not open Pi"); } });
  return { root, db, native, service };
}

describe("Remote thread custody transfer", () => {
  it("preserves native bytes, held inputs, presentation references and meeting receipts before deleting source owners", async () => {
    const { root, db, native, service } = fixture();
    const before = readFileSync(native, "utf8");
    try {
      expect(importRemoteThreads(service, db, { sessionsDir: root })).toEqual({ ok: true, value: { threads: 1, messages: 2 } });
      expect(service.get("thread")).toMatchObject({ state: "idle", held: true });
      expect(service.pending("thread").map(message => [message.id, message.state])).toEqual([["queued", "queued"]]);
      expect(db.prepare("SELECT * FROM events").all()).toHaveLength(1);
      expect(db.prepare("PRAGMA foreign_key_list(events)").get()).toMatchObject({ table: "thread_views" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeUndefined();
      expect(db.prepare("SELECT meeting_transcript FROM message_annotations WHERE work_id='complete'").get()).toMatchObject({ meeting_transcript: '[{"id":"meet-1"}]' });
      expect(importRemoteThreads(service, db, { sessionsDir: root })).toEqual({ ok: true, value: { threads: 0, messages: 0 } });
      expect(readFileSync(native, "utf8")).toBe(before);
    } finally { db.close(); await service.close(); }
  });
  it("refuses an active owner before moving any custody", async () => {
    const { root, db, service } = fixture();
    try {
      db.exec("UPDATE work_items SET state='dispatched' WHERE id='queued'");
      expect(importRemoteThreads(service, db, { sessionsDir: root }).ok).toBe(false);
      expect(service.snapshot()).toEqual([]);
      expect(db.prepare("SELECT count(*) n FROM sessions").get()).toMatchObject({ n: 1 });
    } finally { db.close(); await service.close(); }
  });
});
