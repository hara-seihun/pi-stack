import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { beginSupervisorGeneration, ensureSupervisorSchema, ensureThreadView, recordIdleNotification } from "./database";

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
