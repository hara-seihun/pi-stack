import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSupervisorSchema, recordIdleNotification } from "./database";
import { notificationHistory, resolveNotificationQuestions } from "./notifications";

test("question status comes from its original owner, preserving history on owner failure", async () => {
  const db = new Database(":memory:");
  try {
    ensureSupervisorSchema(db);
    recordIdleNotification(db, "person:question:pending", { id: "agent", title: "Task" }, 1, { kind: "question", body: "Pending?" });
    recordIdleNotification(db, "person:question:answered", { id: "agent", title: "Task" }, 2, { kind: "question", body: "Answered?" });
    const history = notificationHistory(db, null, () => true);
    let reads = 0;
    const resolved = await resolveNotificationQuestions(history, async () => { reads++; return { ok: true, value: [{ id: "pending", threadId: "agent", question: "Pending?", suggestions: [], createdAt: 1 }] }; });
    expect(reads).toBe(1);
    expect(resolved.notifications.map(item => item.status)).toEqual(["history", "needs-you"]);
    expect(resolved.notifications.every(item => !("error" in item))).toBe(true);
    const failed = await resolveNotificationQuestions(history, async () => ({ ok: false, error: { code: "unavailable", message: "Owner unavailable" } }));
    expect(failed.notifications).toMatchObject([{ status: "unavailable", error: "Owner unavailable", sessionId: "agent" }, { status: "unavailable", error: "Owner unavailable", sessionId: "agent" }]);
  } finally { db.close(); }
});

test("attention and question history survives acknowledgement, restart and pagination", () => {
  const root = mkdtempSync(join(tmpdir(), "notification-history-"));
  const path = join(root, "history.sqlite");
  let db = new Database(path);
  try {
    ensureSupervisorSchema(db);
    recordIdleNotification(db, "idle", { id: "agent", title: "Task" }, 1);
    for (let i = 0; i < 5; i++) recordIdleNotification(db, `notice:${i}`, { id: i === 3 ? "inaccessible" : "agent", title: "Task" }, i + 2, { kind: i % 2 ? "question" : "attention", body: `notice ${i}` });
    db.query("UPDATE thread_views SET idle_unread=0").run();
    db.close(); db = new Database(path); ensureSupervisorSchema(db);
    const accessible = (id: string) => id === "agent" ? { archived: true } : null;
    const recent = notificationHistory(db, null, accessible, 2);
    expect(recent.notifications.map(item => item.body)).toEqual(["notice 4"]);
    expect(recent.before).not.toBeNull();
    const earlier = notificationHistory(db, recent.before, accessible, 2);
    expect(earlier.notifications.map(item => item.body)).toEqual(["notice 2", "notice 1"]);
    const first = notificationHistory(db, earlier.before, accessible, 2);
    expect(first.notifications.map(item => item.body)).toEqual(["notice 0"]);
    expect(first.before).toBeNull();
    expect([...recent.notifications, ...earlier.notifications, ...first.notifications].every(item => item.kind !== "idle")).toBe(true);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
