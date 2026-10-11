import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThreadService } from "../src/threads/service.js";

const roots: string[] = [], services: ThreadService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.detach();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "thread-adoption-idempotence-")); roots.push(root);
  const path = join(root, "threads.sqlite");
  const open = () => {
    const service = new ThreadService({ databasePath: path, sessionsDir: root, capacity: { mode: "unmanaged" },
      openSession: async () => { throw new Error("Synthetic adoption never launches a session"); } });
    services.push(service); return service;
  };
  const dbOf = (service: ThreadService) => (service as unknown as { db: DatabaseSync }).db;
  return { root, path, open, dbOf };
}
const value = (db: DatabaseSync, sql: string) => db.prepare(sql).get() as Record<string, unknown>;

test("second open preserves exact schema, metadata, queue and question sequence with zero database writes", async () => {
  const f = fixture(), first = f.open();
  const manager = await first.spawn({ requestId: "manager", cwd: f.root, title: "Manager", metadata: { manager: true } });
  if (!manager.ok) throw new Error(manager.error.message);
  const child = await first.spawn({ requestId: "original-work", parentId: manager.value.id, cwd: f.root, title: "Original child", message: "Original pending payload" });
  if (!child.ok) throw new Error(child.error.message);
  const db = f.dbOf(first);
  db.prepare("INSERT INTO thread_question(id,thread_id,question,suggestions,created_at) VALUES(?,?,?,?,?)").run("original-question", child.value.id, "Synthetic question", "[]", 1);
  await first.detach(); services.splice(services.indexOf(first), 1);
  const migrated = f.open(), current = f.dbOf(migrated);
  const baseline = { schema: value(current, "PRAGMA schema_version"), threads: current.prepare("SELECT id,metadata FROM thread ORDER BY id").all(),
    work: current.prepare("SELECT * FROM thread_work ORDER BY ordinal").all(), events: current.prepare("SELECT * FROM thread_question_event").all(),
    sequence: current.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(), identity: statSync(f.path, { bigint: true }).ino };
  await migrated.detach(); services.splice(services.indexOf(migrated), 1);
  const reopened = f.open(), adopted = f.dbOf(reopened);
  expect(value(adopted, "SELECT total_changes() n").n).toBe(0);
  expect(value(adopted, "PRAGMA schema_version")).toEqual(baseline.schema);
  expect(adopted.prepare("SELECT id,metadata FROM thread ORDER BY id").all()).toEqual(baseline.threads);
  expect(adopted.prepare("SELECT * FROM thread_work ORDER BY ordinal").all()).toEqual(baseline.work);
  expect(adopted.prepare("SELECT * FROM thread_question_event").all()).toEqual(baseline.events);
  expect(adopted.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all()).toEqual(baseline.sequence);
  expect(statSync(f.path, { bigint: true }).ino).toBe(baseline.identity);
  expect(reopened.get(child.value.id)?.role).toBe("kena");
  expect(reopened.pending(child.value.id).map(work => work.id)).toEqual(["original-work"]);
});

test("genuine legacy role, pending delivery and index migrations conserve identities then become idempotent", async () => {
  const f = fixture(), first = f.open();
  const parent = await first.spawn({ requestId: "original-parent", cwd: f.root, title: "Parent" });
  if (!parent.ok) throw new Error(parent.error.message);
  const child = await first.spawn({ requestId: "original-child", parentId: parent.value.id, cwd: f.root, title: "Child", message: "Original input" });
  if (!child.ok) throw new Error(child.error.message);
  await first.detach(); services.splice(services.indexOf(first), 1);
  const old = new DatabaseSync(f.path);
  old.prepare("UPDATE thread SET metadata=? WHERE id=?").run(JSON.stringify({ agentName: "retired-name", peerDependencies: ["before"], dependencyUpdate: { desired: ["original-peer"] } }), child.value.id);
  old.exec("UPDATE thread_work SET delivery='queue',front=1 WHERE status!='done'; DROP INDEX thread_work_queue; CREATE INDEX thread_work_queue ON thread_work(thread_id,status,front DESC,ordinal); DROP INDEX thread_execution_active; ALTER TABLE thread_execution ADD COLUMN state TEXT; CREATE INDEX thread_execution_active ON thread_execution(thread_id) WHERE state='running'");
  old.close();
  const adopted = f.open(), db = f.dbOf(adopted);
  expect(adopted.get(child.value.id)?.role).toBe("kenatia");
  expect(adopted.get(child.value.id)?.metadata?.agentName).toBeUndefined();
  expect(adopted.get(child.value.id)?.dependencies).toEqual(["original-peer"]);
  expect(adopted.pending(child.value.id).map(work => ({ id: work.id, delivery: work.delivery }))).toEqual([{ id: "original-child", delivery: "pending" }]);
  expect(value(db, "SELECT sql FROM sqlite_master WHERE name='thread_work_queue'").sql).toBe("CREATE INDEX thread_work_queue ON thread_work(thread_id,status,ordinal)");
  expect(value(db, "SELECT sql FROM sqlite_master WHERE name='thread_execution_active'").sql).toBe("CREATE UNIQUE INDEX thread_execution_active ON thread_execution(thread_id) WHERE ended_at IS NULL");
  expect(db.prepare("PRAGMA table_info(thread_execution)").all().some(column => (column as { name: string }).name === "state")).toBe(false);
  await adopted.detach(); services.splice(services.indexOf(adopted), 1);
  const again = f.open();
  expect(value(f.dbOf(again), "SELECT total_changes() n").n).toBe(0);
});

test("invalid cyclic parent custody still refuses adoption", async () => {
  const f = fixture(), first = f.open();
  const thread = await first.spawn({ requestId: "original-cyclic", cwd: f.root, title: "Cycle" });
  if (!thread.ok) throw new Error(thread.error.message);
  await first.detach(); services.splice(services.indexOf(first), 1);
  const old = new DatabaseSync(f.path); old.prepare("UPDATE thread SET parent_id=id WHERE id=?").run(thread.value.id); old.close();
  expect(() => f.open()).toThrow("Cyclic thread parent custody");
});

test("failed active-index migration retains the original index and refuses conflicting custody", async () => {
  const f = fixture(), first = f.open();
  const thread = await first.spawn({ requestId: "original-execution-work", cwd: f.root, title: "Conflict", message: "Original work" });
  if (!thread.ok) throw new Error(thread.error.message);
  await first.detach(); services.splice(services.indexOf(first), 1);
  const old = new DatabaseSync(f.path);
  old.exec("DROP INDEX thread_execution_active; CREATE INDEX thread_execution_active ON thread_execution(thread_id)");
  const insert = old.prepare("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES(?,?,?,?,?)");
  for (const id of ["first-original-execution", "second-original-execution"]) insert.run(id, thread.value.id, "original-execution-work", "{}", 1);
  old.close();
  expect(() => f.open()).toThrow();
  const retained = new DatabaseSync(f.path);
  try {
    expect(value(retained, "SELECT sql FROM sqlite_master WHERE name='thread_execution_active'").sql).toBe("CREATE INDEX thread_execution_active ON thread_execution(thread_id)");
    expect(value(retained, "SELECT count(*) n FROM thread_execution").n).toBe(2);
  } finally { retained.close(); }
});
