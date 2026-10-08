import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginSupervisorGeneration, ensureSupervisorSchema, ensureThreadView, nativeHistorySchemaReady, recordIdleNotification, setThreadColor } from "./database";
import { API } from "./api";
import { isThreadColor } from "./protocol";

test("Remote has no execution tables and a new supervisor preserves its presentation", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  ensureThreadView(db, "parent");
  setThreadColor(db, "parent", "purple");
  beginSupervisorGeneration(db, "next");
  expect(db.query("SELECT color FROM thread_views WHERE id='parent'").get()).toEqual({ color: 'purple' });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%context%'").all()).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','work_items','subagents','thread_delegations','delegation_results','core_agents','core_dispatches')").all()).toEqual([]);
  db.close();
});

test("unmigrated personal history requires maintenance before startup can mutate it", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE session_contexts(session_id TEXT PRIMARY KEY,context TEXT NOT NULL)");
  db.query("INSERT INTO session_contexts VALUES('person','irreplaceable')").run();
  expect(nativeHistorySchemaReady(db)).toMatchObject({ ok: false, error: { code: 'migration_required' } });
  expect(() => ensureSupervisorSchema(db)).toThrow('Native history maintenance is required');
  expect(db.query("SELECT context FROM session_contexts").get()).toEqual({ context: 'irreplaceable' });
  expect(db.query("SELECT name FROM sqlite_master WHERE name='thread_views'").get()).toBeNull();
  db.close();
});

test("thread colors migrate old views and persist independently of thread lifecycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "remote-colors-"));
  const path = join(directory, "supervisor.sqlite3");
  const db = new Database(path);
  db.exec("CREATE TABLE thread_views (id TEXT PRIMARY KEY, idle_unread INTEGER NOT NULL DEFAULT 0, named_at_message_count INTEGER NOT NULL DEFAULT 0)");
  db.query("INSERT INTO thread_views(id) VALUES(?)").run("fleet-thread");
  ensureSupervisorSchema(db);
  setThreadColor(db, "fleet-thread", "purple");
  setThreadColor(db, "person-thread", "green");
  db.close();
  const restarted = new Database(path);
  ensureSupervisorSchema(restarted);
  expect(restarted.query("SELECT id,color FROM thread_views ORDER BY id").all()).toEqual([
    { id: "fleet-thread", color: "purple" }, { id: "person-thread", color: "green" },
  ]);
  expect(() => restarted.query("UPDATE thread_views SET color='pink' WHERE id='fleet-thread'").run()).toThrow();
  setThreadColor(restarted, "fleet-thread", null);
  expect(restarted.query("SELECT color FROM thread_views WHERE id='fleet-thread'").get()).toEqual({ color: null });
  restarted.close();
  rmSync(directory, { recursive: true, force: true });
});

test("color route and palette reject unknown values", () => {
  expect(API.sessionColor.match("PUT", "/v1/sessions/fleet%2Fone/color")).toEqual({ sessionId: "fleet/one" });
  expect(isThreadColor("red")).toBe(true);
  expect(isThreadColor("purple")).toBe(true);
  for (const invalid of ["pink", "RED", "", 1, undefined, null]) expect(isThreadColor(invalid)).toBe(false);
});

test("replayed settlement notifications do not mark a viewed thread unread again", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const thread = { id: "child", title: "Child" };
  recordIdleNotification(db, "work-1", thread, 1000);
  db.query("UPDATE thread_views SET idle_unread=0 WHERE id=?").run(thread.id);
  recordIdleNotification(db, "work-1", thread, 1000);
  expect(db.query("SELECT idle_unread FROM thread_views").get()).toEqual({ idle_unread: 0 });
  recordIdleNotification(db, "work-2", thread, 2000);
  expect(db.query("SELECT idle_unread FROM thread_views").get()).toEqual({ idle_unread: 1 });
  expect(db.query("SELECT count(*) count FROM idle_notifications").get()).toEqual({ count: 2 });
  db.close();
});

test("an older supervisor database loses Remote's retired naming state and keeps its views", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE thread_views (id TEXT PRIMARY KEY, idle_unread INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
      named_at_message_count INTEGER NOT NULL DEFAULT 0, naming_request TEXT, naming_attempted_count INTEGER NOT NULL DEFAULT 0, naming_error TEXT,
      color TEXT CHECK(color IN ('red','orange','yellow','green','blue','purple') OR color IS NULL));
    CREATE TABLE thread_naming_recovery (id TEXT PRIMARY KEY, model TEXT NOT NULL, message_count INTEGER NOT NULL, failures INTEGER NOT NULL, retry_at INTEGER);
    CREATE TABLE error_feedback (source TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, message TEXT NOT NULL, occurrence TEXT NOT NULL, dismissed_at INTEGER);`);
  db.query("INSERT INTO thread_views(id,idle_unread,message_count,naming_error,color) VALUES('a',1,40,'Rate limited','blue')").run();
  db.query("INSERT INTO thread_naming_recovery VALUES('a','luna',40,2,NULL)").run();
  for (const source of ["naming", "naming:a", "fleet"]) db.query("INSERT INTO error_feedback(source,id,message,occurrence) VALUES(?,?,?,?)").run(source, source, "m", "1");

  ensureSupervisorSchema(db);
  ensureSupervisorSchema(db); // a migrated database is left as it is

  const columns = (db.query("PRAGMA table_info(thread_views)").all() as { name: string }[]).map(column => column.name);
  expect(columns).toEqual(["id", "idle_unread", "color"]);
  expect(db.query("SELECT * FROM thread_views").all()).toEqual([{ id: "a", idle_unread: 1, color: "blue" }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='thread_naming_recovery'").get()).toBeNull();
  expect(db.query("SELECT source FROM error_feedback").all()).toEqual([{ source: "fleet" }]);
  db.close();
});
