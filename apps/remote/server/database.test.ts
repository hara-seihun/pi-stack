import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginSupervisorGeneration, ensureSupervisorSchema, ensureThreadView, recordIdleNotification, setThreadColor } from "./database";
import { API } from "./api";
import { isThreadColor } from "./protocol";

test("Remote has no execution tables and a new supervisor preserves its presentation", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  ensureThreadView(db, "parent");
  db.query("INSERT INTO session_contexts VALUES(?,?,?)").run("parent", 1, '{"messages":[]}');
  beginSupervisorGeneration(db, "next");
  expect(db.query("SELECT context FROM session_contexts").get()).toEqual({ context: '{"messages":[]}' });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','work_items','subagents','thread_delegations','delegation_results','core_agents','core_dispatches')").all()).toEqual([]);
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
