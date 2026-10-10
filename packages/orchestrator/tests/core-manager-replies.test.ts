import { expect, test } from "bun:test";
import { openSqlite } from "../src/sqlite.js";
import { readManagerReplies } from "../src/core/manager-replies.js";

function fixture() {
  const db = openSqlite(":memory:");
  db.exec("CREATE TABLE thread_execution(id TEXT,thread_id TEXT,settlement_seq INTEGER,ended_at INTEGER,final_message TEXT,outcome TEXT)");
  const insert = (id: string, thread: string, seq: number, text: string | null, outcome = "complete") => db.prepare("INSERT INTO thread_execution VALUES(?,?,?,?,?,?)").run(id, thread, seq, seq * 1000, text === null ? null : JSON.stringify({ role: "assistant", content: [{ type: "text", text }] }), outcome);
  insert("a", "manager", 1, "First reply");
  insert("private", "other-person-thread", 2, "Must not leave its scope");
  insert("silent", "manager", 3, "<silent/>");
  insert("media", "manager", 4, 'Reply <pi-remote-image id="image" />');
  insert("failed", "manager", 5, null, "failed");
  return { db, insert };
}

test("canonical manager receipt pull exposes only configured manager's visible bounded replies with immutable IDs", () => {
  const f = fixture();
  expect(readManagerReplies(f.db, "manager", { after: null, limit: 100 })).toEqual({ ok: true, value: { managerThreadId: "manager", cursor: 5, replies: [] } });
  const result = readManagerReplies(f.db, "manager", { after: 0, limit: 100 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.cursor).toBe(5);
  expect(result.value.replies.map(item => item.id)).toEqual(["manager-reply:manager:a", "manager-reply:manager:media", "manager-reply:manager:failed"]);
  expect(result.value.replies.map(item => item.text)).toEqual(["First reply", "Reply", "That didn't work; the details are in the managing conversation."]);
  expect(JSON.stringify(result)).not.toContain("other-person-thread");
  f.insert("bounded", "manager", 6, "x".repeat(5000));
  const bounded = readManagerReplies(f.db, "manager", { after: 5, limit: 1 });
  expect(bounded.ok && bounded.value.replies[0]?.text.length).toBe(2000);
  f.db.close();
});

test("reply pull cannot choose another scope, regress its cursor, or replay historical output on initial subscription", () => {
  const f = fixture();
  expect(readManagerReplies(f.db, "manager", { after: 6, limit: 100 })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(readManagerReplies(f.db, "manager", { after: 0, limit: 101 })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(readManagerReplies(f.db, "manager", { after: 0, limit: 100, threadId: "other-person-thread" } as any)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  const page = readManagerReplies(f.db, "manager", { after: 1, limit: 1 });
  expect(page).toEqual({ ok: true, value: { managerThreadId: "manager", cursor: 3, replies: [] } });
  f.db.close();
});
