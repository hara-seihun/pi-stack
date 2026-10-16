import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCapacityAuthority, createAgentCapacityServer, readAgentCapacityAuthorityConfig } from "../src/agent-capacity-authority.js";
import { createAgentCapacityClient, type AgentCapacity, type CapacityRecovery } from "../src/agent-capacity.js";
import { ThreadService } from "../src/threads/service.js";
import { migrationConfiguration } from "../../../deploy/capacity-migration-config.mjs";
import type { PiSession, Result } from "../src/threads/contracts.js";

const closes: (() => void | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const unwrap = <T>(r: Result<T>) => { if (!r.ok) throw new Error(r.error.message); return r.value; };
function client(authority: AgentCapacityAuthority, ownerId: string): AgentCapacity {
  return { ownerId,
    async acquire(execution) { const r = authority.acquire(ownerId, execution); return r.ok ? { ok: true, value: { ...r.value, release: () => this.release(r.value) } } : r; },
    async inspect(execution) { return authority.inspect(ownerId, execution); },
    async release(custody) { return authority.release(ownerId, custody); },
    async withdraw(execution) { return authority.withdraw(ownerId, execution); },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "capacity-handoff-")), authority = new AgentCapacityAuthority(":memory:");
  closes.push(() => rmSync(root, { recursive: true, force: true }), () => authority.close());
  const states = new Map<string, Record<string, unknown>>(), sessions = new Map<string, PiSession>();
  const recovery: CapacityRecovery = {
    async recordedOwner(execution) { const r = authority.recordedOwner(execution, ["old-root", "scope"]); return r.ok ? { ok: true, value: r.value.kind === "absent" ? null : r.value.ownerId } : r; },
    originalOwner(ownerId) { return { ok: true, value: client(authority, ownerId) }; },
  };
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite3"), sessionsDir: root, capacity: client(authority, "scope"), capacityRecovery: recovery,
    openSession: async () => { throw new Error("No fresh native may open in this handoff proof"); },
    recoverSession: async () => { throw new Error("Missing native remains uncertain"); },
    attachSession: async (reference, output) => {
      const id = reference?.socketPath; if (!id || !states.has(id)) throw new Error("Native ownership unconfirmed");
      const session: PiSession = { async command(command) { output({ type: "response", id: command.id, command: command.type, success: true, data: states.get(id) }); }, async close() {} };
      sessions.set(id, session); return session;
    },
  });
  closes.push(() => service.detach());
  const db = (service as any).db;
  function thread(id: string, entered: boolean, state: Record<string, unknown> = {}) {
    unwrap(service.importThread({ id, title: id, cwd: root, sessionFile: join(root, `${id}.jsonl`), held: false,
      settings: { model: "sol", speed: "standard", thinkingLevel: "high" }, metadata: entered ? { runnerReference: { control: "proof", socketPath: id } } : {} }));
    if (entered) states.set(id, { nativeProtocolVersion: "batch-operations-v1", isStreaming: false, isCompacting: false, isBashRunning: false,
      localTools: 0, pendingCommandCount: 0, pendingMessageCount: 0, backgroundOperationCount: 0, acceptedWorkIds: [], completedWorkIds: [], ...state });
    const acquired = authority.acquire("old-root", { agentId: id, executionId: id });
    db.prepare("INSERT INTO thread_capacity(execution_id,logical_execution_id,thread_id,source_id,kind,state,lease_id,entered_native) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, id, id, id, "work", acquired.ok ? "held" : "requested", acquired.ok ? acquired.value.leaseId : null, entered ? 1 : 0);
  }
  return { authority, service, db, thread, states, sessions, root, recovery };
}

test("adopted lifecycle releases original idle custody, retains active/unknown owners and advances independent rows", async () => {
  const f = fixture(); unwrap(f.authority.initialize([]));
  f.thread("active", true, { isStreaming: true }); f.thread("idle", true); f.thread("uncertain", true);
  f.states.delete("uncertain");
  let drains = 0;
  const originalDrain = (f.service as any).drain.bind(f.service);
  (f.service as any).drain = async (id: string) => { await (f.service as any).reconcileCapacityHandoff(id); drains++; };
  (f.service as any).started = true; f.service.reconcile();
  for (let n = 0; n < 50 && drains < 3; n++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(drains).toBe(3);
  expect(unwrap(f.authority.inspect("old-root", { agentId: "idle", executionId: "idle" })).state).toBe("released");
  for (const id of ["active", "uncertain"]) expect(unwrap(f.authority.inspect("old-root", { agentId: id, executionId: id })).state).toBe("active");
  const receipt = f.db.prepare("SELECT * FROM thread_capacity_handoff WHERE execution_id='idle'").get();
  expect(receipt).toMatchObject({ owner_id: "old-root", acknowledged_at: expect.any(Number) });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM thread_capacity_handoff").get().n).toBe(1);
  f.states.get("active")!.isStreaming = false;
  expect(await (f.service as any).reconcileCapacityHandoff("active")).toBe(true);
  await (f.service as any).reconcileCapacityHandoff("idle");
  expect(f.db.prepare("SELECT * FROM thread_capacity_handoff WHERE execution_id='idle'").get()).toEqual(receipt);
  expect((await (f.service as any).acquireCapacity("idle", "next", "next", "work")).ok).toBe(true);
  expect(f.authority.entries().find(entry => entry.executionId === "next")?.ownerId).toBe("scope");
  (f.service as any).drain = originalDrain;
});

test("lost original-owner release acknowledgement replays the same durable proof independently", async () => {
  const f = fixture(); unwrap(f.authority.initialize([])); f.thread("lost", true); f.thread("other", true);
  const original = f.recovery.originalOwner.bind(f.recovery);
  let lose = true;
  f.recovery.originalOwner = (ownerId, execution) => {
    const registered = original(ownerId, execution); if (!registered.ok) return registered;
    const release = registered.value.release.bind(registered.value);
    return { ok: true, value: { ...registered.value, async release(custody) {
      const r = await release(custody);
      return lose && custody.executionId === "lost" ? { ok: false, error: { code: "unavailable", message: "Lost release receipt" } } : r;
    } } };
  };
  expect(await (f.service as any).reconcileCapacityHandoff("lost")).toBe(false);
  expect(await (f.service as any).reconcileCapacityHandoff("other")).toBe(true);
  const proof = f.db.prepare("SELECT proof,acknowledged_at FROM thread_capacity_handoff WHERE execution_id='lost'").get();
  expect(proof.acknowledged_at).toBeNull();
  lose = false;
  expect(await (f.service as any).reconcileCapacityHandoff("lost")).toBe(true);
  const acknowledged = f.db.prepare("SELECT proof,acknowledged_at FROM thread_capacity_handoff WHERE execution_id='lost'").get();
  expect(acknowledged.proof).toBe(proof.proof);
  expect(typeof acknowledged.acknowledged_at).toBe("number");
});

test("positively completed native work settles its original execution instead of replaying it", async () => {
  const f = fixture(); unwrap(f.authority.initialize([])); f.thread("settled", true);
  unwrap(f.service.importMessage({ id: "landed-work", threadId: "settled", text: "already delivered", state: "dispatched", executionId: "settled", insertedAt: Date.now() }));
  Object.assign(f.states.get("settled")!, { landedWorkIds: ["landed-work"], completedWorkIds: ["landed-work"],
    lastAssistantMessage: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Original result" }], timestamp: Date.now() } });
  expect(await (f.service as any).reconcileCapacityHandoff("settled")).toBe(true);
  expect(f.service.latestSettlement("settled")).toMatchObject({ executionId: "settled", outcome: "complete" });
  expect(f.service.pending("settled")).toHaveLength(0);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM thread_execution").get().n).toBe(1);
  expect(f.authority.entries()).toHaveLength(0);
});

test("unknown-owner queued unentered admission is withdrawn before successor custody and acknowledgement survives restart", async () => {
  const f = fixture(); f.thread("queued", false); unwrap(f.authority.initialize([]));
  expect(await (f.service as any).reconcileCapacityHandoff("queued")).toBe(true);
  expect(unwrap(f.authority.inspect("old-root", { agentId: "queued", executionId: "queued" })).state).toBe("released");
  expect(f.db.prepare("SELECT owner_id,state FROM thread_capacity WHERE execution_id='queued'").get()).toEqual({ owner_id: "old-root", state: "released" });
  expect(JSON.parse(f.db.prepare("SELECT proof FROM thread_capacity_handoff").get().proof).kind).toBe("unentered");
  unwrap(await (f.service as any).acquireCapacity("queued", "new", "work", "work"));
  expect(f.db.prepare("SELECT owner_id FROM thread_capacity WHERE execution_id='new'").get().owner_id).toBe("scope");
  await f.service.detach();
  const next = new ThreadService({ databasePath: join(f.root, "threads.sqlite3"), sessionsDir: f.root, capacity: client(f.authority, "scope"), openSession: async () => { throw new Error("No native"); } });
  closes.push(() => next.detach());
  expect(typeof (next as any).db.prepare("SELECT acknowledged_at FROM thread_capacity_handoff WHERE execution_id='queued'").get().acknowledged_at).toBe("number");
});

test("migration staging derives grants from exact registered host and UID inventory, not owner names", () => {
  const authority = { databasePath: "/preserved", owners: [{ id: "administrator", host: "host-a" }, { id: "misleading-host-b/person", host: "host-a" }, { id: "host-a/impostor", host: "host-b" }] };
  const client = { owners: [{ uid: 0, ownerId: "administrator" }, { uid: 1000, ownerId: "misleading-host-b/person" }] };
  const stage = migrationConfiguration(authority, client, "host-a");
  expect(stage.client.migration).toEqual({ ownerId: "administrator", ownerIds: ["administrator", "misleading-host-b/person"] });
  expect(stage.authority.databasePath).toBe("/preserved");
  const both = migrationConfiguration(stage.authority, { owners: [{ uid: 0, ownerId: "host-a/impostor" }] }, "host-b");
  expect(both.authority.migrations).toEqual([stage.client.migration, { ownerId: "host-a/impostor", ownerIds: ["host-a/impostor"] }]);
  expect(both.authority.databasePath).toBe("/preserved");
  expect(authority).not.toHaveProperty("migrations");
  expect(() => migrationConfiguration(authority, { owners: [...client.owners, { uid: 1001, ownerId: "host-a/impostor" }] }, "host-a")).toThrow("same-host");
  expect(() => migrationConfiguration(authority, { owners: client.owners.filter(owner => owner.uid !== 0) }, "host-a")).toThrow("root UID");
});

test("owner lookup is exact, explicitly granted, non-enumerating and host bounded", async () => {
  const f = fixture(); unwrap(f.authority.initialize([])); f.thread("agent", true);
  const server = createAgentCapacityServer(f.authority, [{ id: "migration", token: "m", host: "a" }, { id: "ordinary", token: "o", host: "a" }, { id: "old-root", token: "r", host: "a" }, { id: "scope", token: "s", host: "a" }], [{ ownerId: "migration", ownerIds: ["old-root", "scope"] }]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); closes.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const migration = createAgentCapacityClient({ url, ownerId: "migration", token: "m" }), ordinary = createAgentCapacityClient({ url, ownerId: "ordinary", token: "o" });
  expect(unwrap(await migration.recordedOwner({ agentId: "agent", executionId: "agent" }))).toBe("old-root");
  expect((await ordinary.recordedOwner({ agentId: "agent", executionId: "agent" })).ok).toBe(false);
  expect((await migration.recordedOwner({ agentId: "other", executionId: "agent" })).ok).toBe(false);
  expect(f.authority.recordedOwner({ agentId: "agent", executionId: "agent" }, ["foreign-host"]).ok).toBe(false);
  const config = join(f.root, "authority.json");
  writeFileSync(config, JSON.stringify({ databasePath: "/tmp/proof", listenHost: "127.0.0.1", port: 2482,
    owners: [{ id: "migration", host: "a", tokenFile: "/tmp/m" }, { id: "foreign", host: "b", tokenFile: "/tmp/o" }], migrations: [{ ownerId: "migration", ownerIds: ["foreign"] }] }));
  expect(() => readAgentCapacityAuthorityConfig(config)).toThrow("same-host");
});
