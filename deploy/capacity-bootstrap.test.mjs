import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceBootstrap, newBootstrapLedger } from "./capacity-bootstrap.mjs";
import { requireCapacityReady } from "./capacity-ready.mjs";

function fixture(counts = [4, 3]) {
  const commit = "a".repeat(40), barrierId = "synthetic-cutover";
  const owners = [{ id: "a-person", host: "alpha" }, { id: "a-fleet", host: "alpha" }, { id: "b-person", host: "beta" }];
  const command = (host, operation) => ({ command: "/usr/bin/true", args: [host, operation], cwd: "/tmp", timeoutMs: 1000 });
  const plan = { version: 1, barrierId, releaseCommit: commit, stateDir: "/tmp/synthetic-capacity",
    hosts: ["alpha", "beta"].map(id => ({ id, ...Object.fromEntries(["gate", "verify", "census", "doctors", "restore"].map(operation => [operation, command(id, operation)])) })) };
  const ledger = newBootstrapLedger(plan), gated = new Set(), opened = new Set(), trace = [], native = { alive: true };
  let initialized = false, entries = [];
  const receipts = Object.fromEntries(plan.hosts.map(host => [host.id, { version: 1, barrierId, host: host.id, releaseCommit: commit,
    oldControllers: [], owners: owners.filter(owner => owner.host === host.id).map(owner => ({ ownerId: owner.id, state: "gated", coverage: "complete", unavailableSources: [] })),
    directIngress: { cli: "managed", sdk: "managed", root: "idle-managed", evidence: { releaseCommit: commit } } }]));
  const censuses = Object.fromEntries(plan.hosts.map((host, hostIndex) => [host.id, { version: 1, barrierId,
    hosts: [{ host: host.id, capturedAt: new Date().toISOString(), owners: owners.filter(owner => owner.host === host.id).map(owner => owner.id) }],
    entries: Array.from({ length: counts[hostIndex] }, (_, index) => ({ ownerId: owners.find(owner => owner.host === host.id).id,
      agentId: `${host.id}-agent-${index}`, executionId: `${host.id}-execution-${index}`, source: "/synthetic/threads.sqlite3", uncertain: true })) }]));
  const deps = { owners, snapshot: () => ({ initialized, active: entries.length }), save: () => {},
    initialize: census => { assert.equal(gated.size, plan.hosts.length); initialized = true; entries = [...census]; trace.push("seed"); return { ok: true, value: undefined }; },
    reconcile: census => census.every(entry => entries.some(other => other.executionId === entry.executionId)),
    run: async hook => {
      const [host, operation] = hook.args; trace.push(`${host}:${operation}`);
      switch (operation) {
        case "gate": assert.equal(initialized, false); gated.add(host); return { ok: true };
        case "verify": assert.ok(gated.has(host)); return receipts[host];
        case "census": assert.equal(gated.size, plan.hosts.length); assert.equal(initialized, false); return censuses[host];
        case "doctors": assert.equal(initialized, true); assert.equal(gated.size, plan.hosts.length); assert.ok(entries.length <= 100); return { ok: true };
        case "restore": assert.equal(initialized, true); assert.ok(trace.includes("alpha:doctors") && trace.includes("beta:doctors")); opened.add(host); return { ok: true };
        default: throw new Error("Unknown synthetic hook");
      }
    } };
  return { plan, ledger, deps, receipts, censuses, trace, native, opened, get initialized() { return initialized; } };
}

test("both failclosed host barriers precede census/seed; native work survives and doctors/ingress wait for initialized custody", async () => {
  const f = fixture();
  for (const phase of ["gated", "censused", "initialized", "proved", "opened"]) {
    await advanceBootstrap(f.plan, f.ledger, f.deps); assert.equal(f.ledger.phase, phase); assert.equal(f.native.alive, true);
  }
  assert.equal(f.deps.snapshot().active, 7);
  assert.equal(f.opened.size, 2);
  assert.ok(f.trace.indexOf("beta:gate") < f.trace.indexOf("alpha:census"));
  assert.ok(f.trace.indexOf("seed") > f.trace.indexOf("beta:census"));
  assert.ok(f.trace.indexOf("seed") < f.trace.indexOf("alpha:doctors"));
});

test("busy root, unmanaged launchers or missing locked-owner coverage keep cutover uninitialized", async () => {
  for (const damage of [
    receipt => { receipt.directIngress.root = "busy"; },
    receipt => { receipt.directIngress.sdk = "unmanaged"; },
    receipt => { receipt.directIngress.evidence.releaseCommit = "b".repeat(40); },
    receipt => { receipt.oldControllers.push(123); },
    receipt => { receipt.owners[0].coverage = "unavailable"; receipt.owners[0].unavailableSources = ["/locked/threads.sqlite3"]; },
    receipt => { receipt.owners.pop(); },
  ]) {
    const f = fixture(); damage(f.receipts.beta);
    await assert.rejects(advanceBootstrap(f.plan, f.ledger, f.deps));
    assert.equal(f.ledger.phase, "unprepared"); assert.equal(f.initialized, false); assert.equal(f.opened.size, 0);
    assert.equal(f.native.alive, true); assert.equal(f.trace.includes("seed"), false);
  }
});

test("101 executions hold the barrier without truncating census or initializing authority", async () => {
  const f = fixture([51, 50]);
  await advanceBootstrap(f.plan, f.ledger, f.deps);
  await assert.rejects(advanceBootstrap(f.plan, f.ledger, f.deps), /overcapacity 101\/100/);
  assert.equal(f.ledger.phase, "gated"); assert.equal(f.initialized, false);
  assert.equal(f.ledger.censuses.alpha.entries.length + f.ledger.censuses.beta.entries.length, 101);
  assert.equal(f.opened.size, 0);
});

test("private root ThreadService execution shares the initial bounded census", async () => {
  const f = fixture();
  f.censuses.alpha.entries.push({ ownerId: "a-person", agentId: "root-request", executionId: "root-execution", source: "/private/root-sessions/request-uuid/threads.sqlite3", uncertain: true });
  await advanceBootstrap(f.plan, f.ledger, f.deps);
  await advanceBootstrap(f.plan, f.ledger, f.deps);
  await advanceBootstrap(f.plan, f.ledger, f.deps);
  assert.equal(f.deps.snapshot().active, 8);
  assert.ok(f.ledger.census.entries.some(entry => entry.agentId === "root-request"));
});

test("seed receipt lost after commit resumes by custody reconciliation, not another initialization", async () => {
  const f = fixture();
  await advanceBootstrap(f.plan, f.ledger, f.deps); await advanceBootstrap(f.plan, f.ledger, f.deps);
  const initialize = f.deps.initialize;
  f.deps.initialize = entries => { initialize(entries); throw new Error("receipt connection lost"); };
  await assert.rejects(advanceBootstrap(f.plan, f.ledger, f.deps), /receipt connection lost/);
  assert.equal(f.ledger.phase, "initializing");
  f.deps.initialize = () => { throw new Error("must not reseed"); };
  await advanceBootstrap(f.plan, f.ledger, f.deps);
  assert.equal(f.ledger.phase, "initialized"); assert.equal(f.trace.filter(item => item === "seed").length, 1);
});

test("changed plans and unexpected authority initialization are explicit errors", async () => {
  const f = fixture();
  await assert.rejects(advanceBootstrap({ ...f.plan, barrierId: "another" }, f.ledger, f.deps), /plan changed/);
  f.deps.snapshot = () => ({ initialized: true, active: 0 });
  await assert.rejects(advanceBootstrap(f.plan, f.ledger, f.deps), /already initialized without/);
});

test("ready guard does not manufacture initialization or run inference", async () => {
  let calls = 0;
  const valid = { authority: "pi-stack-global-agents-v1", limit: 100, initialized: true, active: 100, queued: 20 };
  assert.deepEqual(await requireCapacityReady(async () => { calls++; return { ok: true, value: valid }; }), valid);
  for (const value of [{ ...valid, initialized: false }, { ...valid, active: 101 }, { ...valid, authority: "other" }]) await assert.rejects(requireCapacityReady(async () => ({ ok: true, value })), /cutover incomplete/);
  await assert.rejects(requireCapacityReady(async () => ({ ok: false, error: { message: "authority unreachable" } })), /authority unreachable/);
  assert.equal(calls, 1);
});
