import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureSupervisorSchema, removeEventJournal } from "./database";
import { SessionActivity } from "./session-activity";

test("the activity window opens on the tail, follows a cursor and forgets a thread", () => {
  const activity = new SessionActivity(() => "now");
  expect(activity.add("a", "tool_start", { name: "bash" })).toBe(1);
  expect(activity.add("a", "tool_end", { name: "bash" }, "end:1")).toBe(2);
  expect(activity.add("a", "tool_end", { name: "bash" }, "end:1")).toBe(0); // the same receipt twice
  expect(activity.add("b", "notice", { text: "other thread" })).toBe(3);

  expect(activity.since("a", 0).map(event => event.type)).toEqual(["tool_start", "tool_end"]);
  expect(activity.since("a", 1).map(event => event.seq)).toEqual([2]);
  expect(activity.since("a", 2)).toEqual([]);
  // A cursor from a supervisor that has been replaced is ahead of this window.
  expect(activity.since("a", 9_999).map(event => event.seq)).toEqual([1, 2]);
  expect(activity.recent("a", ["tool_end"], 8).map(event => event.name)).toEqual(["bash"]);

  for (let count = 0; count < 300; count++) activity.add("a", "notice", { text: String(count) });
  expect(activity.since("a", 0)).toHaveLength(50);
  expect(activity.recent("a", ["notice"], 8).at(-1)?.text).toBe("299");
  expect(activity.recent("a", ["tool_start"], 8)).toEqual([]); // pushed out of the window

  activity.forget("a");
  expect(activity.since("a", 0)).toEqual([]);
  expect(activity.since("b", 0)).toHaveLength(1);
});

test("retiring the event journal keeps the thinking, measurements and message count it held", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE thread_views (id TEXT PRIMARY KEY, idle_unread INTEGER NOT NULL DEFAULT 0, named_at_message_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, receipt_id TEXT);
      CREATE TABLE message_annotations (work_id TEXT PRIMARY KEY, meeting_transcript TEXT NOT NULL);`);
    db.query("INSERT INTO thread_views(id) VALUES('a')").run();
    const event = db.query("INSERT INTO events(session_id,time,type,payload) VALUES('a',?,?,?)");
    event.run("t", "thinking", JSON.stringify({ text: "weighing it", finalizesMessage: "m1" }));
    event.run("t", "metrics", JSON.stringify({ metrics: { ttftMs: 10, generationMs: 1_000, outputTokens: 50, tokensPerSecond: 50 }, finalizesMessage: "m1" }));
    event.run("t", "user", JSON.stringify({ text: "do it", workId: "work" }));
    event.run("t", "assistant", JSON.stringify({ text: "done" }));
    db.query("INSERT INTO message_annotations(work_id,meeting_transcript) VALUES('work','[]')").run();

    ensureSupervisorSchema(db);

    // Startup moves the facts; the rows go in slices once the supervisor serves.
    expect(db.query("SELECT name FROM sqlite_master WHERE name='events'").get()).not.toBeNull();
    expect(removeEventJournal(db, 2)).toBe("removing");
    expect((db.query("SELECT count(*) AS left FROM events").get() as { left: number }).left).toBe(2);
    expect(removeEventJournal(db, 2)).toBe("removing");
    expect(removeEventJournal(db, 2)).toBe("removed"); // the emptied table goes
    expect(db.query("SELECT name FROM sqlite_master WHERE name='events'").get()).toBeNull();
    expect(removeEventJournal(db)).toBe("removed");
    const fact = db.query("SELECT thinking,metrics FROM message_facts WHERE session_id='a' AND finalizes_message='m1'").get() as { thinking: string; metrics: string };
    expect(fact.thinking).toBe("weighing it");
    expect(JSON.parse(fact.metrics).tokensPerSecond).toBe(50);
    expect((db.query("SELECT message_count FROM thread_views WHERE id='a'").get() as { message_count: number }).message_count).toBe(2);
    expect((db.query("SELECT session_id FROM message_annotations WHERE work_id='work'").get() as { session_id: string }).session_id).toBe("a");

    ensureSupervisorSchema(db); // opening again changes nothing
    expect((db.query("SELECT message_count FROM thread_views WHERE id='a'").get() as { message_count: number }).message_count).toBe(2);
  } finally { db.close(); }
});
