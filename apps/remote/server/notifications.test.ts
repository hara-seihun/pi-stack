import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSupervisorSchema } from "./database";
import { idleNotifications } from "./notifications";

test("idle notifications record transitions atomically and replay across reconnects", () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  db.query("INSERT INTO sessions(id,name,workspace_id,state,created_at,updated_at,profile_id) VALUES('thread','A thread','home','STOPPED','now','now','home')").run();
  const state = db.query("UPDATE sessions SET state=? WHERE id='thread'");
  const unread = () => Number((db.query("SELECT idle_unread FROM sessions WHERE id='thread'").get() as any).idle_unread);
  const initial = idleNotifications(db, null);
  for (const value of ["STARTING", "IDLE", "IDLE"]) state.run(value);
  expect(idleNotifications(db, initial.cursor).notifications).toEqual([]);
  state.run("RUNNING");
  state.run("IDLE");
  state.run("IDLE");
  const first = idleNotifications(db, initial.cursor);
  expect(first.notifications).toHaveLength(1);
  expect(unread()).toBe(1);
  db.query("UPDATE sessions SET idle_unread=0 WHERE id='thread'").run();
  expect(unread()).toBe(0);
  expect(first.notifications[0].sessionId).toBe("thread");
  expect(idleNotifications(db, first.cursor).notifications).toEqual([]);
  expect(() => db.transaction(() => { state.run("RUNNING"); state.run("IDLE"); throw new Error("rollback"); })()).toThrow();
  expect(idleNotifications(db, first.cursor).notifications).toEqual([]);
  state.run("RUNNING"); state.run("ABORTING"); state.run("IDLE");
  ensureSupervisorSchema(db);
  expect(unread()).toBe(1);
  expect(idleNotifications(db, first.cursor).notifications).toHaveLength(1);
  expect(idleNotifications(db, null).notifications).toEqual([]);
  expect(idleNotifications(db, initial.cursor).notifications).toHaveLength(2);
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
