import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSupervisorSchema, recordIdleNotification } from "./database";
import { idleNotifications } from "./notifications";

const localThread = (id: string) => id === "thread" ? { parentId: null } : null;

test("notification projection is atomic and replayable across reconnects", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const thread = { id: "thread", title: "A thread" };
  const initial = idleNotifications(db, null, localThread);
  recordIdleNotification(db, "execution-1", thread, 1000);
  recordIdleNotification(db, "execution-1", thread, 1000);
  const first = idleNotifications(db, initial.cursor, localThread);
  expect(first.notifications).toHaveLength(1);
  expect(first.notifications[0].sessionId).toBe(thread.id);
  expect(() => db.transaction(() => {
    recordIdleNotification(db, "execution-2", thread, 2000);
    throw new Error("rollback");
  })()).toThrow();
  expect(idleNotifications(db, first.cursor, localThread).notifications).toEqual([]);
  recordIdleNotification(db, "execution-2", thread, 2000);
  ensureSupervisorSchema(db);
  expect(idleNotifications(db, first.cursor, localThread).notifications).toHaveLength(1);
  expect(idleNotifications(db, null, localThread).notifications).toEqual([]);
  db.close();
});

test("notification replay pages without skipping completions", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const insert = db.query("INSERT INTO idle_notifications(session_id,name,time) VALUES('thread','Name','now')");
  db.transaction(() => { for (let index = 0; index < 105; index++) insert.run(); })();
  const first = idleNotifications(db, 0, localThread);
  expect(first.notifications).toHaveLength(100);
  expect(idleNotifications(db, first.cursor, localThread).notifications).toHaveLength(5);
  db.close();
});

test("only local conversation roots notify, including when replaying stored worker completions", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const threads = new Map([
    ["conversation", { parentId: null }],
    ["child", { parentId: "conversation" }],
    ["grandchild", { parentId: "child" }],
  ]);
  for (const id of ["conversation", "child", "grandchild", "fleet-root", "fleet-child", "missing"]) {
    recordIdleNotification(db, `execution-${id}`, { id, title: id }, 1000);
  }
  const feed = idleNotifications(db, 0, id => threads.get(id) ?? null);
  expect(feed.notifications.map(event => event.sessionId)).toEqual(["conversation"]);
  expect(feed.cursor).toBe(6);
  expect(idleNotifications(db, feed.cursor, id => threads.get(id) ?? null).notifications).toEqual([]);
  expect(db.query("SELECT sum(idle_unread) count FROM thread_views").get()).toEqual({ count: 6 });
  db.close();
});

test("a full page of suppressed completions advances to the next conversation", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  db.transaction(() => {
    for (let index = 0; index < 100; index++) {
      recordIdleNotification(db, `worker-${index}`, { id: "fleet", title: "Worker" }, 1000);
    }
    recordIdleNotification(db, "conversation", { id: "thread", title: "Conversation" }, 2000);
  })();
  const first = idleNotifications(db, 0, localThread);
  expect(first.notifications).toEqual([]);
  expect(first.cursor).toBe(100);
  const second = idleNotifications(db, first.cursor, localThread);
  expect(second.notifications.map(event => event.sessionId)).toEqual(["thread"]);
  expect(second.cursor).toBe(101);
  db.close();
});
