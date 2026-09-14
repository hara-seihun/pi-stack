import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSupervisorSchema, recordIdleNotification } from "./database";
import { idleNotifications } from "./notifications";

test("notification projection is atomic and replayable across reconnects", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const thread = { id: "thread", title: "A thread" };
  const initial = idleNotifications(db, null);
  recordIdleNotification(db, "execution-1", thread, 1000);
  recordIdleNotification(db, "execution-1", thread, 1000);
  const first = idleNotifications(db, initial.cursor);
  expect(first.notifications).toHaveLength(1);
  expect(first.notifications[0].sessionId).toBe(thread.id);
  expect(() => db.transaction(() => {
    recordIdleNotification(db, "execution-2", thread, 2000);
    throw new Error("rollback");
  })()).toThrow();
  expect(idleNotifications(db, first.cursor).notifications).toEqual([]);
  recordIdleNotification(db, "execution-2", thread, 2000);
  ensureSupervisorSchema(db);
  expect(idleNotifications(db, first.cursor).notifications).toHaveLength(1);
  expect(idleNotifications(db, null).notifications).toEqual([]);
  db.close();
});

test("notification replay pages without skipping completions", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const insert = db.query("INSERT INTO idle_notifications(session_id,name,time) VALUES('thread','Name','now')");
  db.transaction(() => { for (let index = 0; index < 105; index++) insert.run(); })();
  const first = idleNotifications(db, 0);
  expect(first.notifications).toHaveLength(100);
  expect(idleNotifications(db, first.cursor).notifications).toHaveLength(5);
  db.close();
});
