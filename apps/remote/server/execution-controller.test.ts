import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ExecutionController, SessionCommands } from "./execution-controller";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,revision INTEGER DEFAULT 0,updated_at TEXT);
    CREATE TABLE session_cores(session_id TEXT,state_dir TEXT);
    CREATE TABLE work_items(id TEXT PRIMARY KEY,session_id TEXT,state TEXT,inserted_at TEXT,updated_at TEXT,last_error TEXT);
    CREATE TABLE core_dispatches(work_id TEXT,session_id TEXT,state_dir TEXT,payload TEXT);
    INSERT INTO sessions(id) VALUES('thread');
    INSERT INTO session_cores VALUES('thread','generation-a');
    INSERT INTO work_items VALUES('a','thread','dispatched',NULL,NULL,NULL),('b','thread','dispatched',NULL,NULL,NULL);
    INSERT INTO core_dispatches VALUES('a','thread','generation-a','{}'),('b','thread','generation-a','{}');`);
  const controller = new ExecutionController(db, (_id, workId) => { db.query("UPDATE work_items SET inserted_at='accepted' WHERE id=?").run(workId); });
  const owner = { sessionId: "thread", generation: "a", instance: "one" };
  controller.attach(owner);
  const work = (id: string) => db.query("SELECT state,last_error,inserted_at FROM work_items WHERE id=?").get(id);
  return { db, controller, owner, work };
}

test("terminal receipts complete only their identified work, not everything in an idle runtime", () => {
  const f = fixture();
  try {
    f.controller.observe(f.owner, { revision: 1, status: "running", operations: [{ workId: "a", state: "succeeded" }, { workId: "b", state: "running" }] });
    expect(f.work("a")).toMatchObject({ state: "complete", last_error: null, inserted_at: "accepted" });
    expect(f.work("b")).toMatchObject({ state: "dispatched" });
    f.controller.observe(f.owner, { revision: 2, status: "idle", operations: [{ workId: "b", state: "failed", error: "Provider rejected input" }] });
    expect(f.work("b")).toMatchObject({ state: "complete", last_error: "Provider rejected input" });
  } finally { f.db.close(); }
});

test("unknown outcomes retain custody, cancelled work cannot resurrect, and observations are ordered", () => {
  const f = fixture();
  try {
    f.controller.observe(f.owner, { revision: 2, status: "blocked", operations: [{ workId: "a", state: "unknown", error: "Acknowledgement lost" }] });
    expect(f.work("a")).toMatchObject({ state: "dispatched", last_error: "Acknowledgement lost" });
    expect(f.controller.observe(f.owner, { revision: 1, status: "idle", operations: [{ workId: "a", state: "succeeded" }] })).toEqual({ ok: false, error: "stale-observation" });
    f.db.query("UPDATE work_items SET state='cancelled' WHERE id='b'").run();
    f.controller.observe(f.owner, { revision: 3, status: "idle", operations: [{ workId: "b", state: "succeeded" }] });
    expect(f.work("b")).toMatchObject({ state: "cancelled" });
  } finally { f.db.close(); }
});

test("replaced runtime instances and core generations cannot finish current work", () => {
  const f = fixture();
  try {
    const next = { ...f.owner, instance: "two", generation: "b" };
    f.controller.attach(next);
    expect(f.controller.observe(f.owner, { revision: 20, status: "idle", operations: [{ workId: "a", state: "succeeded" }] })).toEqual({ ok: false, error: "stale-owner" });
    f.db.exec("UPDATE session_cores SET state_dir='generation-b'");
    f.controller.observe(next, { revision: 1, status: "idle", operations: [{ workId: "a", state: "succeeded" }] });
    expect(f.work("a")).toMatchObject({ state: "dispatched" });
  } finally { f.db.close(); }
});

test("receipt reconciliation completes a recovered dispatch even when the core revision is unchanged", () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE work_items SET state='queued' WHERE id='a'");
    const snapshot = { revision: 1, status: "idle" as const, operations: [{ workId: "a", state: "succeeded" as const }] };
    f.controller.observe(f.owner, snapshot);
    expect(f.work("a")).toMatchObject({ state: "queued" });
    f.db.exec("UPDATE work_items SET state='dispatched' WHERE id='a'");
    expect(f.controller.observe(f.owner, snapshot)).toMatchObject({ ok: true, completed: ["a"] });
    expect(f.work("a")).toMatchObject({ state: "complete" });
  } finally { f.db.close(); }
});

test("one transition commits acceptance and terminal state together", () => {
  const f = fixture();
  try {
    const controller = new ExecutionController(f.db, () => { throw new Error("Storage failure"); });
    expect(() => controller.observe(f.owner, { revision: 1, status: "idle", operations: [{ workId: "a", state: "succeeded" }] })).toThrow("Storage failure");
    expect(f.work("a")).toMatchObject({ state: "dispatched", inserted_at: null });
    expect(f.db.query("SELECT revision FROM execution_observations").get()).toMatchObject({ revision: -1 });
  } finally { f.db.close(); }
});

test("session commands serialize across awaits without blocking other threads or poisoning the queue", async () => {
  const commands = new SessionCommands();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = commands.run("thread", async () => { order.push("first"); await barrier; throw new Error("rejected"); });
  const failed = first.catch(() => { order.push("failed"); });
  const second = commands.run("thread", async () => { order.push("second"); });
  await commands.run("another", async () => { order.push("independent"); });
  expect(order).toEqual(["first", "independent"]);
  release();
  await Promise.all([failed, second]);
  expect(order.indexOf("second")).toBeGreaterThan(order.indexOf("first"));
  expect(commands.busy("thread")).toBe(false);
});
