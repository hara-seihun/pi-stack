import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/sqlite.js";
import { ThreadCapacityLedger } from "../src/threads/capacity-ledger.js";
import { ThreadService } from "../src/threads/service.js";
import { AgentCapacityAuthority } from "../src/agent-capacity-authority.js";
import type { AgentCapacity } from "../src/agent-capacity.js";
import type { Result } from "../src/threads/contracts.js";

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
function fixture() {
  const db = openSqlite(":memory:"), authority = new AgentCapacityAuthority(":memory:");
  cleanups.push(() => db.close(), () => authority.close());
  unwrap(authority.initialize([]));
  const capacity: AgentCapacity = {
    async acquire(execution) { const result = authority.acquire("adopted", execution); return result.ok ? { ok: true, value: { ...result.value, release: () => this.release(result.value) } } : result; },
    async inspect(execution) { return authority.inspect("adopted", execution); },
    async release(custody) { return authority.release("adopted", custody); },
    async withdraw(execution) { return authority.withdraw("adopted", execution); },
  };
  return { db, authority, capacity, ledger: new ThreadCapacityLedger(db, capacity) };
}

test("requested retries keep their identity; released custody never becomes a new work candidate", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO thread_capacity VALUES('retry','retry','agent','work','work','requested',NULL,0,NULL,NULL)");
  expect(f.ledger.candidate("agent", "work")).toBe("retry");
  unwrap(await f.ledger.acquire("agent", "retry", "work", "work"));
  expect(f.ledger.candidate("agent", "work")).toBe("retry");
  unwrap(await f.ledger.releaseUnentered("agent", "retry"));
  expect(f.ledger.candidate("agent", "work")).toBeUndefined();
});

test("old-owner release errors preserve custody without poisoning other rows or threads", async () => {
  const f = fixture();
  const old = unwrap(f.authority.acquire("previous", { agentId: "old", executionId: "old" }));
  f.db.prepare("INSERT INTO thread_capacity VALUES('old','old','old','old','work','held',?,1,NULL,NULL)").run(old.leaseId);
  const healthy = unwrap(await f.ledger.acquire("healthy", "healthy", "healthy", "work"));
  f.ledger.requestRelease("old"); f.ledger.requestRelease("healthy");
  expect((await f.ledger.flush()).ok).toBe(false);
  expect(f.ledger.current("old")).toMatchObject([{ state: "releasing", entered_native: 1 }]);
  expect(unwrap(f.authority.inspect("previous", old)).state).toBe("active");
  expect(unwrap(f.authority.inspect("adopted", healthy)).state).toBe("released");
  unwrap(await f.ledger.release("healthy"));
  expect(f.ledger.current("old")).toHaveLength(1);
});

test("release reconciliation wakes pending work even when old-owner acknowledgement fails", async () => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), "capacity-wake-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const service = new ThreadService({ capacity: f.capacity, databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("This test must not open native"); } });
  cleanups.push(() => service.detach());
  unwrap(await service.spawn({ id: "agent", requestId: "work", cwd: root, message: "work" }));
  const old = unwrap(f.authority.acquire("previous", { agentId: "agent", executionId: "previous" }));
  (service as any).db.prepare("INSERT INTO thread_capacity VALUES('previous','previous','agent','previous','work','releasing',?,1,NULL,NULL)").run(old.leaseId);
  let drains = 0;
  (service as any).drain = async () => { drains++; };
  (service as any).started = true;
  service.reconcile();
  for (let i = 0; i < 20 && !drains; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(drains).toBe(1);
  expect(service.get("agent")?.metadata?.capacityRelease).toBeDefined();
  expect(unwrap(f.authority.inspect("previous", old)).state).toBe("active");
});

test("startup rejection never reinserts a settled identity, even with an unreleased capacity row", async () => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), "capacity-lifecycle-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const service = new ThreadService({ capacity: f.capacity, databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("This test must not open native"); } });
  cleanups.push(() => service.detach());
  unwrap(service.importThread({ id: "agent", title: "Agent", cwd: root, sessionFile: join(root, "agent.jsonl"), held: true,
    settings: { model: "sol", thinkingLevel: "high", speed: "standard" } }));
  unwrap(service.importMessage({ id: "work", threadId: "agent", text: "work", state: "done", outcome: "failed", executionId: "settled" }));
  const db = (service as any).db;
  db.exec("UPDATE thread_work SET status='queued',execution_id=NULL WHERE id='work'; INSERT INTO thread_capacity VALUES('settled','settled','agent','work','work','requested',NULL,0,NULL,NULL)");
  await (service as any).rejectStartup("agent", "Invalid recorded runner");
  const executions = db.prepare("SELECT id FROM thread_execution WHERE thread_id='agent'").all();
  expect(executions).toHaveLength(2);
  expect(new Set(executions.map((row: { id: string }) => row.id)).size).toBe(2);
  expect(service.latestSettlement("agent")?.executionId).not.toBe("settled");
  expect(service.latestSettlement("agent")?.outcome).toBe("failed");
});
