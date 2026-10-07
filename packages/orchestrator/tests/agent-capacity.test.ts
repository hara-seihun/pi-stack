import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCapacityAuthority, createAgentCapacityServer } from "../src/agent-capacity-authority.js";
import { AGENT_CAPACITY_AUTHORITY, GLOBAL_AGENT_LIMIT, createAgentCapacityClient, configuredAgentCapacity,
  type CapacityCustody, type CapacityTransport } from "../src/agent-capacity.js";
import type { Result } from "../src/threads/contracts.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const owners = [{ id: "server-owner", token: "synthetic-server-token" }, { id: "converge-owner", token: "synthetic-converge-token" }];
function value<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function memoryAuthority(initialized: boolean): AgentCapacityAuthority {
  const authority = new AgentCapacityAuthority(":memory:");
  cleanups.push(() => authority.close());
  if (initialized) value(authority.initialize([]));
  return authority;
}
async function listen(server: Server): Promise<string> {
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("admits at most 100 parallel HTTP executions across two authenticated owners and explicitly queues the rest", async () => {
  const authority = memoryAuthority(true);
  const url = await listen(createAgentCapacityServer(authority, owners));
  let peak = 0;
  const transport: CapacityTransport = async (input, init) => {
    const response = await fetch(input, init);
    peak = Math.max(peak, authority.status().active);
    return response;
  };
  const clients = owners.map(owner => createAgentCapacityClient({ url, ownerId: owner.id, token: owner.token, transport }));
  const executions = Array.from({ length: GLOBAL_AGENT_LIMIT + 25 }, (_, index) => ({ agentId: `agent-${index}`, executionId: `execution-${index}` }));
  const results = await Promise.all(executions.map((execution, index) => clients[index % clients.length]!.acquire(execution)));
  expect(results.filter(result => result.ok)).toHaveLength(100);
  expect(peak).toBe(100);
  expect(authority.status()).toEqual({ authority: AGENT_CAPACITY_AUTHORITY, initialized: true, limit: 100, active: 100, queued: 25 });
  for (const result of results.filter(result => !result.ok)) expect(result).toMatchObject({ ok: false, error: {
    code: "unavailable", retryAt: expect.any(Number), message: expect.stringContaining("Global agent limit 100/100"),
  } });
  const denied = results.findIndex(result => !result.ok);
  expect(await clients[denied % clients.length]!.acquire(executions[denied]!)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(authority.status().queued).toBe(25);
  const granted = results.findIndex(result => result.ok);
  value(await value(results[granted]!).release());
  const promoted = value(await clients[denied % clients.length]!.acquire(executions[denied]!));
  expect(promoted).toMatchObject(executions[denied]!);
  expect(authority.status()).toMatchObject({ active: 100, queued: 24 });
});

it("fails closed before census cutover and for missing client configuration", async () => {
  const authority = memoryAuthority(false);
  const execution = { agentId: "agent", executionId: "execution" };
  expect(authority.acquire(owners[0]!.id, execution)).toMatchObject({ ok: false, error: {
    code: "unavailable", message: expect.stringContaining("census cutover"),
  } });
  expect(authority.status()).toMatchObject({ initialized: false, active: 0, queued: 1 });
  const url = await listen(createAgentCapacityServer(authority, owners));
  const client = createAgentCapacityClient({ url, ownerId: owners[0]!.id, token: owners[0]!.token });
  expect(await client.acquire(execution)).toMatchObject({ ok: false, error: { code: "unavailable", retryAt: expect.any(Number) } });
  expect(await configuredAgentCapacity({}).acquire(execution)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(authority.status().active).toBe(0);
  value(authority.initialize([]));
  value(await client.acquire(execution));
  expect(authority.status()).toMatchObject({ initialized: true, active: 1, queued: 0 });
});

it("rejects an over-limit initial census without changing custody and holds cutover until at most 100 remain", () => {
  const authority = memoryAuthority(false);
  const census = Array.from({ length: 102 }, (_, index) => ({ ownerId: owners[index % owners.length]!.id,
    agentId: `existing-agent-${index}`, executionId: `existing-execution-${index}` }));
  const fresh = { agentId: "fresh-agent", executionId: "fresh-execution" };
  expect(authority.acquire(owners[0]!.id, fresh)).toMatchObject({ ok: false });
  const before = authority.status();
  expect(authority.initialize(census)).toMatchObject({ ok: false, error: { message: expect.stringContaining("100") } });
  expect(authority.status()).toEqual(before);
  expect(authority.status()).toMatchObject({ initialized: false, active: 0, queued: 1 });
  expect(authority.entries()).toEqual([]);
  expect(census).toHaveLength(102);
  expect(authority.acquire(owners[0]!.id, fresh)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  value(authority.initialize(census.slice(0, 100)));
  expect(authority.status()).toMatchObject({ initialized: true, active: 100, queued: 1 });
  expect(authority.acquire(owners[0]!.id, fresh)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  const settled = authority.entries()[0]!;
  value(authority.release(settled.ownerId, settled));
  value(authority.acquire(owners[0]!.id, fresh));
  expect(authority.status()).toMatchObject({ active: 100, queued: 0 });
});

it("uses one slot for an execution identity and prevents overlapping executions of the same agent", async () => {
  const authority = memoryAuthority(true);
  const execution = { agentId: "agent", executionId: "execution-1" };
  const first = value(authority.acquire(owners[0]!.id, execution));
  expect(value(authority.acquire(owners[0]!.id, execution))).toEqual(first);
  expect(authority.acquire(owners[1]!.id, execution)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(authority.acquire(owners[0]!.id, { agentId: "another-agent", executionId: execution.executionId })).toMatchObject({ ok: false });
  const next = { agentId: execution.agentId, executionId: "execution-2" };
  expect(authority.acquire(owners[0]!.id, next)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(authority.status()).toMatchObject({ active: 1, queued: 1 });
  value(authority.release(owners[0]!.id, first));
  const second = value(authority.acquire(owners[0]!.id, next));
  expect(second.leaseId).not.toBe(first.leaseId);
  expect(authority.acquire(owners[0]!.id, execution)).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(authority.status()).toMatchObject({ active: 1, queued: 0 });
});

it("retains active and queued custody across authority restart without reseeding or duplicating leases", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-capacity-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "capacity.sqlite3");
  let authority = new AgentCapacityAuthority(path);
  cleanups.push(() => authority.close());
  value(authority.initialize([]));
  const execution = { agentId: "agent", executionId: "execution-1" };
  const custody = value(authority.acquire(owners[0]!.id, execution));
  expect(authority.acquire(owners[0]!.id, { agentId: "agent", executionId: "execution-2" })).toMatchObject({ ok: false });
  authority.close();
  authority = new AgentCapacityAuthority(path);
  expect(authority.status()).toMatchObject({ initialized: true, active: 1, queued: 1 });
  expect(value(authority.acquire(owners[0]!.id, execution))).toEqual(custody);
  expect(authority.initialize([])).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(authority.entries()).toEqual([{ ...custody, ownerId: owners[0]!.id }]);
  value(authority.release(owners[0]!.id, custody));
  expect(authority.status().active).toBe(0);
});

it("does not let a stale release token or another authenticated owner free current custody", async () => {
  const authority = memoryAuthority(true);
  const url = await listen(createAgentCapacityServer(authority, owners));
  const [owner, other] = owners.map(entry => createAgentCapacityClient({ url, ownerId: entry.id, token: entry.token }));
  const old = value(await owner!.acquire({ agentId: "agent", executionId: "old-execution" }));
  value(await old.release());
  const current = value(await owner!.acquire({ agentId: "agent", executionId: "new-execution" }));
  expect(await owner!.release({ ...current, leaseId: old.leaseId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(await other!.release(current)).toMatchObject({ ok: false, error: { code: "conflict" } });
  value(await old.release());
  expect(authority.entries()).toEqual([{ agentId: current.agentId, executionId: current.executionId, leaseId: current.leaseId, ownerId: owners[0]!.id }]);
  const forged = await fetch(`${url}/v1/release`, { method: "POST", headers: { authorization: `Bearer ${owners[1]!.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...current, ownerId: owners[0]!.id }) });
  expect(forged.status).toBe(403);
  expect(authority.status().active).toBe(1);
  value(await current.release());
  expect(authority.status().active).toBe(0);
});

it("keeps custody after a lost acquisition acknowledgement and retries the same execution without another slot", async () => {
  const authority = memoryAuthority(true);
  const url = await listen(createAgentCapacityServer(authority, owners));
  let loseReceipt = true;
  const transport: CapacityTransport = vi.fn(async (input, init) => {
    const response = await fetch(input, init);
    if (loseReceipt) { loseReceipt = false; await response.body?.cancel(); throw new TypeError("acknowledgement connection lost"); }
    return response;
  });
  const owner = createAgentCapacityClient({ url, ownerId: owners[0]!.id, token: owners[0]!.token, transport });
  const execution = { agentId: "agent", executionId: "execution" };
  expect(await owner.acquire(execution)).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("custody is retained") } });
  expect(authority.status().active).toBe(1);
  const recorded = authority.entries()[0]!;
  const retry = value(await owner.acquire(execution));
  expect(retry.leaseId).toBe(recorded.leaseId);
  expect(authority.status().active).toBe(1);
  const offline = createAgentCapacityClient({ url, ownerId: owners[0]!.id, token: owners[0]!.token,
    transport: async () => { throw new TypeError("authority disconnected"); } });
  expect(await offline.release(retry)).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("custody is retained") } });
  expect(authority.entries()).toEqual([recorded]);
  value(await retry.release());
  expect(authority.status().active).toBe(0);
});

it("rejects a mismatched authority receipt rather than manufacturing a lease", async () => {
  const execution = { agentId: "agent", executionId: "execution" };
  const wrongCustody: CapacityCustody = { ...execution, agentId: "another-agent", leaseId: "lease" };
  for (const receipt of [
    { authority: "another-authority", result: { ok: true, value: wrongCustody } },
    { authority: AGENT_CAPACITY_AUTHORITY, result: { ok: true, value: wrongCustody } },
    { authority: AGENT_CAPACITY_AUTHORITY, result: { ok: true, value: null } },
  ]) {
    const client = createAgentCapacityClient({ url: "http://127.0.0.1:1234", ownerId: owners[0]!.id, token: owners[0]!.token,
      transport: async () => Response.json(receipt) });
    expect(await client.acquire(execution)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  }
});
