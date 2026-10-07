import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { abortAndSettleStandaloneSession, beginStandaloneAgent } from "../src/standalone-agent.js";
import type { AgentCapacity, CapacityCustody } from "../src/agent-capacity.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "standalone-capacity-")); roots.push(root);
  const leases = new Map<string, CapacityCustody>();
  let releaseFails = false;
  const release = vi.fn(async (custody: CapacityCustody) => {
    if (releaseFails) return { ok: false as const, error: { code: "unavailable" as const, message: "Lost release receipt" } };
    leases.delete(custody.executionId);
    return { ok: true as const, value: undefined };
  });
  const capacity: AgentCapacity = {
    acquire: async execution => {
      if (leases.size >= 100) return { ok: false, error: { code: "unavailable", message: "Capacity queued" } };
      const custody = { ...execution, leaseId: `lease-${execution.executionId}` };
      leases.set(execution.executionId, custody);
      return { ok: true, value: { ...custody, release: () => release(custody) } };
    }, release,
    inspect: async execution => { const custody = leases.get(execution.executionId); return { ok: true, value: custody ? { state: "active", custody } : { state: "absent" } }; },
    withdraw: async execution => leases.has(execution.executionId)
      ? { ok: false, error: { code: "conflict", message: "Active custody cannot be withdrawn" } }
      : { ok: true, value: undefined },
  };
  const options = (id: string) => ({ capacity, env: { PI_AGENT_CAPACITY_OWNER: "fixture-host/root" }, recordPath: join(root, id, "capacity.json"), agentId: `root:${id}`, executionId: id });
  const record = (id: string) => JSON.parse(readFileSync(options(id).recordPath, "utf8"));
  return { root, leases, options, record, release, releaseFailure: (value: boolean) => { releaseFails = value; } };
}
it("101 standalone executions cannot run together; a proven settlement admits the queued execution", async () => {
  const f = fixture();
  const admitted = await Promise.all(Array.from({ length: 100 }, (_, n) => beginStandaloneAgent(f.options(String(n)))));
  expect(admitted.every(result => result.ok)).toBe(true);
  expect(f.leases.size).toBe(100);
  const waiting = await beginStandaloneAgent(f.options("101"));
  expect(waiting.ok).toBe(false);
  expect(f.record("101").state).toBe("acquiring");
  expect(f.release).not.toHaveBeenCalled();
  if (!admitted[0].ok) throw new Error("missing lease");
  expect(await admitted[0].value.settle()).toEqual({ ok: true, value: undefined });
  expect(f.record("0").state).toBe("released");
  expect((await beginStandaloneAgent(f.options("101"))).ok).toBe(true);
  expect(f.leases.size).toBe(100);
});
it("failed cancellation and native activity do not release; positive abort settlement releases exactly once", async () => {
  const f = fixture(), result = await beginStandaloneAgent(f.options("cancel"));
  if (!result.ok) throw new Error(result.error.message);
  const session = { abort: vi.fn(async () => { throw new Error("cancel failed"); }), isIdle: true, isStreaming: true, isCompacting: false, isRetrying: false, dispose: vi.fn() };
  await expect(abortAndSettleStandaloneSession(session, result.value)).rejects.toThrow("cancel failed");
  expect(f.release).not.toHaveBeenCalled();
  expect(f.record("cancel").state).toBe("held");
  session.abort = vi.fn(async () => {});
  await expect(abortAndSettleStandaloneSession(session, result.value)).rejects.toThrow("has not settled");
  expect(session.dispose).not.toHaveBeenCalled();
  session.isStreaming = false;
  await abortAndSettleStandaloneSession(session, result.value);
  await result.value.settle();
  expect(f.release).toHaveBeenCalledTimes(1);
});
it("lost release receipt retains a durable settlement proof that recovery replays without another agent", async () => {
  const f = fixture(), result = await beginStandaloneAgent(f.options("receipt"));
  if (!result.ok) throw new Error(result.error.message);
  f.releaseFailure(true);
  expect((await result.value.settle()).ok).toBe(false);
  expect(f.record("receipt").state).toBe("settled");
  expect(f.leases.size).toBe(1);
  f.releaseFailure(false);
  const recovered = await beginStandaloneAgent(f.options("receipt"));
  expect(recovered.ok).toBe(false);
  expect(f.record("receipt").state).toBe("released");
  expect(f.leases.size).toBe(0);
});
it("concurrent release receipts serialize before any later native execution can start", async () => {
  const f = fixture(), result = await beginStandaloneAgent(f.options("serial"));
  if (!result.ok) throw new Error(result.error.message);
  let releaseReceipt!: () => void;
  const pending = new Promise<void>(resolve => { releaseReceipt = resolve; });
  f.release.mockImplementationOnce(async custody => { await pending; f.leases.delete(custody.executionId); return { ok: true, value: undefined }; });
  const first = result.value.settle(), second = result.value.settle();
  expect(first).toBe(second);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect((await beginStandaloneAgent({ ...f.options("serial"), executionId: "later" })).ok).toBe(false);
  releaseReceipt();
  expect((await first).ok).toBe(true);
  expect((await beginStandaloneAgent({ ...f.options("serial"), executionId: "later" })).ok).toBe(true);
});

it("a new positive-settlement attempt has fresh custody that an earlier handle cannot overwrite", async () => {
  const f = fixture(), first = await beginStandaloneAgent(f.options("attempt"));
  if (!first.ok) throw new Error(first.error.message);
  f.releaseFailure(true);
  expect((await first.value.settle()).ok).toBe(false);
  f.releaseFailure(false);
  const second = await beginStandaloneAgent({ ...f.options("attempt"), executionId: "new-attempt" });
  expect(second.ok).toBe(true);
  expect(f.record("attempt").executionId).toBe("new-attempt");
  expect((await first.value.settle()).ok).toBe(false);
  expect(f.record("attempt").state).toBe("held");
  expect(f.leases.size).toBe(1);
});

it("duplicate and recovered held identities never share one global lease", async () => {
  const f = fixture();
  const admitted = await Promise.all([beginStandaloneAgent(f.options("same")), beginStandaloneAgent(f.options("same"))]);
  expect(admitted.filter(result => result.ok)).toHaveLength(1);
  expect(f.leases.size).toBe(1);
  unlinkSync(f.options("same").recordPath + ".lock");
  expect((await beginStandaloneAgent(f.options("same"))).ok).toBe(false);
  expect(f.record("same").state).toBe("held");
  expect(f.release).not.toHaveBeenCalled();
});
it("unconfigured standalone execution fails closed before obtaining an agent", async () => {
  const f = fixture();
  const { capacity: _, ...options } = f.options("unconfigured");
  expect((await beginStandaloneAgent({ ...options, env: { PI_AGENT_CAPACITY_OWNER: "fixture" } })).ok).toBe(false);
  expect(existsSync(options.recordPath)).toBe(false);
  expect(f.leases.size).toBe(0);
});
