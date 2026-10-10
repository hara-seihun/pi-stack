import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostLaneInputPath, hostLaneLockPath, hostWaitKind, mergeHostLanes, readHostLane, rollForwardHosts, runHostLane, runHostLaneRecovery, reconcileHostLaneObservation } from "../deploy/publication-hosts.mjs";

const targets = [{ id: "kenan-server" }, { id: "converge" }];
const requestId = "PUB-0123456789abcdef01234567";
const integrationSha = "a".repeat(40);
const moduleUrl = new URL("../deploy/publication-hosts.mjs", import.meta.url).href;
const initial = () => ({ requestId, integrationSha, status: "running", step: "central-source",
  checks: { status: "passed" }, progress: { command: "central-check" }, stageTimings: { "central-source": { elapsedMs: 3 } },
  android: { release: { revision: integrationSha }, hosts: {}, status: "prepared" },
  bootstrap: { contract: "unified-threads-v1", hosts: {} },
  executorHandoffs: { "kenan-server": { integrationSha }, converge: { integrationSha } },
});

const workerSource = `
import { readFileSync, writeFileSync } from 'node:fs';
import { runHostLane } from ${JSON.stringify(moduleUrl)};
const input = process.argv[2];
const hostId = JSON.parse(readFileSync(input, 'utf8')).hostId;
let checkpoint;
runHostLane(input, {
  bind(local, save) { checkpoint = save; },
  recover(local) {
    if (local.reservations[hostId].state !== 'restore-required') throw new Error('Lost reservation custody');
    writeFileSync(process.env.RECOVERY_PROOF, JSON.stringify(local.reservations[hostId]));
    local.reservations[hostId].state = 'released';
    checkpoint(local);
  },
  deliver(local) {
    (local.reservations ??= {})[hostId] = {state:'restore-required', integrationSha:local.integrationSha};
    (local.nativeHistory ??= {hosts:{}}).hosts[hostId] = {state:'restore-required', integrationSha:local.integrationSha};
    local.step = 'deploy-' + hostId;
    local.progress = {command:'host-deploy', host:hostId};
    local.stageTimings = {'host-deploy':{elapsedMs:17, command:'host-deploy'}};
    local.android.hosts[hostId] = {revision:local.integrationSha};
    checkpoint(local);
    process.stdout.write(JSON.stringify({event:'ready', hostId}) + '\\n');
    readFileSync(0);
    if (process.env.OUTCOME === 'failed') throw new Error('activation failed');
    local.reservations[hostId].state = 'released';
    local.nativeHistory.hosts[hostId].state = 'released';
    delete local.executorHandoffs[hostId];
    checkpoint(local);
    return {status:'passed', integrationSha:local.integrationSha};
  },
});
`;

function harness(t, outcomes = {}) {
  const root = mkdtempSync(join(tmpdir(), "host-lanes-"));
  const laneRoot = join(root, "lanes");
  const workerPath = join(root, "worker.mjs");
  writeFileSync(workerPath, workerSource);
  const children = new Map();
  const launches = [];
  const saves = [];
  t.after(() => { for (const child of children.values()) if (child.exitCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });
  const operations = {
    laneRoot,
    active(target) { const child = children.get(target.id); return !!child && child.exitCode === null && child.signalCode === null; },
    launch(target, inputPath) {
      launches.push(target.id);
      const child = spawn("flock", ["-n", "-E", "75", "--no-fork", hostLaneLockPath(laneRoot, target.id), process.execPath, workerPath, inputPath], {
        env: { ...process.env, OUTCOME: outcomes[target.id] ?? "passed", RECOVERY_PROOF: join(root, `${target.id}-recovered.json`) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.ready = new Promise((resolve, reject) => {
        let data = "";
        child.stdout.on("data", chunk => { data += chunk; if (data.includes('"event":"ready"')) resolve(); });
        child.once("error", reject);
        child.once("exit", code => { if (!data.includes('"event":"ready"')) reject(new Error(`worker exited before ready: ${code} ${child.errors}`)); });
      });
      child.errors = "";
      child.stderr.on("data", chunk => { child.errors += chunk; });
      child.completion = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      children.set(target.id, child);
      return { ok: true };
    },
    save(request) { saves.push(structuredClone(request)); },
  };
  return { root, laneRoot, children, launches, saves, operations };
}

async function release(child) { child.stdin.end(); const result = await child.completion; assert.equal(result.code, 0, child.errors); }

test("host-delivery has its own wait kind rather than the lock contention budget", () => {
  assert.equal(hostWaitKind({ kind: "host-delivery" }), "waiting-for-host-delivery");
});

test("host workers overlap; independent custody and receipt merges lose no peer or central fields", async t => {
  const h = harness(t);
  const request = initial();
  assert.deepEqual(rollForwardHosts(request, targets, h.operations), { status: "waiting", hosts: targets.map(t => t.id) });
  await Promise.all([...h.children.values()].map(child => child.ready));
  mergeHostLanes(request, h.laneRoot, targets);
  for (const { id } of targets) {
    assert.equal(request.reservations[id].state, "restore-required");
    assert.equal(request.nativeHistory.hosts[id].state, "restore-required");
    assert.equal(request.hostDelivery[id].progress.host, id);
    assert.equal(request.hostDelivery[id].timings['host-deploy'].elapsedMs, 17);
    assert.equal(request.hosts[id].waiting.kind, "host-delivery");
  }
  assert.equal(request.step, "central-source");
  assert.deepEqual(request.progress, { command: "central-check" });
  assert.deepEqual(request.checks, { status: "passed" });
  assert.deepEqual(request.stageTimings, { "central-source": { elapsedMs: 3 } });
  assert.equal(request.bootstrap.contract, "unified-threads-v1");
  rollForwardHosts(request, targets, h.operations);
  assert.deepEqual(h.launches, targets.map(t => t.id), "active units must not be relaunched");
  await release(h.children.get("converge"));
  mergeHostLanes(request, h.laneRoot, targets);
  assert.equal(request.hosts.converge.status, "passed");
  assert.equal(request.reservations["kenan-server"].state, "restore-required");
  assert.equal(request.executorHandoffs.converge, undefined);
  assert.ok(request.executorHandoffs["kenan-server"]);
  assert.equal(request.android.status, "published", "artifact receipts are independent of final host proof");
  await release(h.children.get("kenan-server"));
  assert.deepEqual(rollForwardHosts(request, targets, h.operations), { status: "passed" });
  assert.equal(request.reservations.converge.state, "released");
  assert.equal(request.reservations["kenan-server"].state, "released");
  assert.equal(h.launches.length, 2);
});

test("failed host does not terminalize the request while its peer owns live custody", async t => {
  const h = harness(t, { "kenan-server": "failed" });
  const request = initial();
  rollForwardHosts(request, targets, h.operations);
  await Promise.all([...h.children.values()].map(child => child.ready));
  await release(h.children.get("kenan-server"));
  assert.deepEqual(rollForwardHosts(request, targets, h.operations), { status: "waiting", hosts: ["converge"] });
  assert.equal(request.hosts["kenan-server"].failure.message, "activation failed");
  assert.equal(request.reservations.converge.state, "restore-required");
  await release(h.children.get("converge"));
  assert.deepEqual(rollForwardHosts(request, targets, h.operations), { status: "failed", hosts: ["kenan-server"] });
  assert.equal(request.hosts.converge.status, "passed");
});

test("SIGKILL retains pre-effect custody; restart recovers only the interrupted host before replay", async t => {
  const h = harness(t);
  const request = initial();
  rollForwardHosts(request, targets, h.operations);
  await Promise.all([...h.children.values()].map(child => child.ready));
  await release(h.children.get("converge"));
  const killed = h.children.get("kenan-server");
  killed.kill("SIGKILL");
  await killed.completion;
  const restarted = initial();
  mergeHostLanes(restarted, h.laneRoot, targets);
  const before = readHostLane(h.laneRoot, requestId, integrationSha, "kenan-server");
  assert.equal(before.state, "running");
  assert.equal(restarted.reservations["kenan-server"].state, "restore-required");
  rollForwardHosts(restarted, targets, h.operations);
  const resumed = h.children.get("kenan-server");
  await resumed.ready;
  assert.equal(JSON.parse(readFileSync(join(h.root, "kenan-server-recovered.json"))).state, "restore-required");
  assert.equal(readHostLane(h.laneRoot, requestId, integrationSha, "kenan-server").token, before.token);
  assert.deepEqual(h.launches, ["kenan-server", "converge", "kenan-server"]);
  await release(resumed);
  assert.deepEqual(rollForwardHosts(restarted, targets, h.operations), { status: "passed" });
});

test("launch failure retains immutable queued input and does not gate peer launch", t => {
  const h = harness(t);
  const request = initial();
  const inputs = [];
  const operations = { ...h.operations, active: () => false, launch: (target, path) => { inputs.push(path); return { ok: false, error: "unit manager unavailable" }; } };
  rollForwardHosts(request, targets, operations);
  const retained = hostLaneInputPath(h.laneRoot, requestId, integrationSha, "kenan-server");
  const snapshot = readFileSync(retained, "utf8");
  rollForwardHosts(request, targets, operations);
  assert.equal(inputs.length, 4);
  assert.equal(inputs[0], inputs[2]);
  assert.equal(readFileSync(retained, "utf8"), snapshot);
});

for (const kind of ["live-meeting", "live-telephone", "native-source", "native-history", "host-lock"]) {
  test(`${kind} retains completed peer and retries only when its host is ready`, t => {
    const h = harness(t);
    const request = initial();
    const calls = [];
    let ready = false;
    const operations = { ...h.operations, active: () => false,
      launch(target, inputPath) {
        calls.push(target.id);
        runHostLane(inputPath, { bind() {}, recover() { throw new Error("Unexpected recovery"); },
          deliver(local) {
            assert.equal(local.executorHandoffs[target.id === "converge" ? "kenan-server" : "converge"], undefined);
            return target.id === "kenan-server" && !ready
              ? { status: "waiting", ready: false, waiting: { kind, host: target.id, at: "2026-10-10T00:00:00Z" } }
              : { status: "passed", integrationSha };
          },
        });
        return { ok: true };
      },
    };
    rollForwardHosts(request, targets, operations);
    const peer = structuredClone(request.hosts.converge);
    rollForwardHosts(request, targets, operations);
    assert.deepEqual(calls, ["kenan-server", "converge"]);
    ready = true;
    request.hosts["kenan-server"].ready = true;
    assert.deepEqual(rollForwardHosts(request, targets, operations), { status: "passed" });
    assert.deepEqual(calls, ["kenan-server", "converge", "kenan-server"]);
    assert.deepEqual(request.hosts.converge, peer);
  });
}

test("explicit recovery owns terminal custody without erasing failure or replaying delivery", t => {
  const h = harness(t);
  const request = initial();
  let checkpoint;
  const operations = { ...h.operations, active: () => false, launch(target, inputPath) {
    runHostLane(inputPath, { bind(local, save) { checkpoint = save; }, recover() {}, deliver(local) {
      local.nativeHistory = { hosts: { [target.id]: { state: "repair-required", integrationSha } } };
      checkpoint(local);
      return { status: "failed", failure: { message: "retained activation failure" } };
    } });
    return { ok: true };
  } };
  rollForwardHosts(request, [targets[0]], operations);
  const inputPath = hostLaneInputPath(h.laneRoot, requestId, integrationSha, targets[0].id);
  const before = readHostLane(h.laneRoot, requestId, integrationSha, targets[0].id);
  const failed = runHostLaneRecovery(inputPath, { bind(local, save) { checkpoint = save; }, recover(local) {
    assert.equal(readHostLane(h.laneRoot, requestId, integrationSha, targets[0].id).state, "recovering");
    local.nativeHistory.hosts[targets[0].id].state = "restore-required";
    checkpoint(local);
    throw new Error("restore command unavailable");
  } });
  assert.deepEqual(failed, { ok: false, error: { kind: "host-recovery-failed", message: "restore command unavailable" } });
  const interrupted = readHostLane(h.laneRoot, requestId, integrationSha, targets[0].id);
  const path = join(h.laneRoot, requestId, integrationSha, targets[0].id, "journal.json");
  writeFileSync(path, JSON.stringify({ ...interrupted, state: "recovering", recovery: { ...interrupted.recovery, status: "running" } }));
  assert.throws(() => runHostLane(inputPath, { bind() {}, recover() {}, deliver() { assert.fail("Explicit recovery must not deploy"); } }), /must resume through runHostLaneRecovery/);
  assert.deepEqual(runHostLaneRecovery(inputPath, { bind(local, save) { checkpoint = save; }, recover(local) {
    local.nativeHistory.hosts[targets[0].id].state = "restored";
    checkpoint(local);
  } }), { ok: true });
  mergeHostLanes(request, h.laneRoot, targets);
  const after = readHostLane(h.laneRoot, requestId, integrationSha, targets[0].id);
  assert.equal(after.token, before.token);
  assert.equal(request.nativeHistory.hosts[targets[0].id].state, "restored");
  assert.equal(request.hosts[targets[0].id].failure.message, "retained activation failure");
  assert.equal(after.recoveries.length, 2);
  assert.equal(request.hostDelivery[targets[0].id].recovery.status, "completed");
});

test('native recovery receipts are additive across hosts, stable across checkpoints and retained with older history', t => {
  const h = harness(t);
  const request = initial();
  const legacy = { at: '2026-01-01T00:00:00Z', hosts: ['converge', 'kenan-server'], status: 'failed' };
  request.nativeHistoryRecoveries = [legacy];
  rollForwardHosts(request, targets, { ...h.operations, active: () => false, launch(target, inputPath) {
    runHostLane(inputPath, { bind() {}, recover() {}, deliver() { return { status: 'failed', failure: { message: 'activation failed' } }; } });
    return { ok: true };
  } });
  for (const target of targets) {
    let checkpoint;
    const inputPath = hostLaneInputPath(h.laneRoot, requestId, integrationSha, target.id);
    assert.deepEqual(runHostLaneRecovery(inputPath, { bind(local, save) { checkpoint = save; }, recover(local) {
      const receipt = { at: '2026-02-01T00:00:00Z', hosts: [], status: 'running' };
      (local.nativeHistoryRecoveries ??= []).push(receipt);
      checkpoint(local);
      mergeHostLanes(request, h.laneRoot, targets);
      const running = request.nativeHistoryRecoveries.find(item => item.laneHostId === target.id);
      assert.equal(running.status, 'running');
      receipt.hosts.push(target.id);
      receipt.status = 'restored';
      checkpoint(local);
    } }), { ok: true });
  }
  mergeHostLanes(request, h.laneRoot, targets);
  assert.equal(request.nativeHistoryRecoveries.length, 3);
  assert.deepEqual(request.nativeHistoryRecoveries[0], legacy);
  const receipts = request.nativeHistoryRecoveries.slice(1);
  assert.equal(new Set(receipts.map(item => item.laneRecoveryId)).size, 2, 'same timestamps on independent hosts are distinct receipts');
  for (const target of targets) {
    const receipt = receipts.find(item => item.laneHostId === target.id);
    assert.equal(receipt.status, 'restored');
    assert.deepEqual(receipt.hosts, [target.id]);
  }
  mergeHostLanes(request, h.laneRoot, targets);
  assert.equal(request.nativeHistoryRecoveries.length, 3, 'read/restart does not append another copy');
});

test('settled readiness observation retains causal failure and custody with a revision fence', t => {
  const h = harness(t);
  const request = initial();
  let checkpoint;
  const operations = { ...h.operations, active: () => false, launch(target, inputPath) {
    runHostLane(inputPath, { bind(local, save) { checkpoint = save; }, recover() {}, deliver(local) {
      local.nativeHistory = { hosts: { [target.id]: { state: 'restore-required', integrationSha } } };
      checkpoint(local);
      return { status: 'waiting', waiting: { kind: 'native-history', host: target.id, at: '2026-01-01T00:00:00Z' } };
    } });
    return { ok: true };
  } };
  rollForwardHosts(request, [targets[0]], operations);
  const inputPath = hostLaneInputPath(h.laneRoot, requestId, integrationSha, targets[0].id);
  const revision = request.hostDelivery[targets[0].id].revision;
  request.hosts[targets[0].id] = { status: 'failed', failure: { reason: 'readiness-probe-failed', message: 'schema custody mismatch' } };
  request.nativeHistory.hosts[targets[0].id].state = 'repair-required';
  const result = reconcileHostLaneObservation(inputPath, request, revision);
  assert.deepEqual(result, { ok: true, revision: revision + 1, changed: true });
  const retained = initial();
  mergeHostLanes(retained, h.laneRoot, targets);
  assert.equal(retained.hosts[targets[0].id].failure.reason, 'readiness-probe-failed');
  assert.equal(retained.nativeHistory.hosts[targets[0].id].state, 'repair-required');
  assert.equal(readHostLane(h.laneRoot, requestId, integrationSha, targets[0].id).observations[0].state, 'waiting');
  assert.deepEqual(reconcileHostLaneObservation(inputPath, request, revision), {
    ok: false, error: { kind: 'host-observation-conflict', revision: revision + 1 },
  });
  assert.deepEqual(reconcileHostLaneObservation(inputPath, retained, revision + 1), { ok: true, revision: revision + 1, changed: false });
  assert.deepEqual(reconcileHostLaneObservation(inputPath, { ...request, integrationSha: 'b'.repeat(40) }, revision + 1), {
    ok: false, error: { kind: 'host-observation-identity-conflict' },
  });
});

test('nonterminal custody rejects a coordinator observation even with the current revision', t => {
  const h = harness(t);
  const request = initial();
  rollForwardHosts(request, [targets[0]], { ...h.operations, active: () => false, launch: () => ({ ok: true }) });
  const revision = request.hostDelivery[targets[0].id].revision;
  const inputPath = hostLaneInputPath(h.laneRoot, requestId, integrationSha, targets[0].id);
  request.hosts[targets[0].id] = { status: 'failed', failure: { message: 'synthetic' } };
  assert.deepEqual(reconcileHostLaneObservation(inputPath, request, revision), {
    ok: false, error: { kind: 'host-observation-busy', state: 'queued' },
  });
  assert.equal(readHostLane(h.laneRoot, requestId, integrationSha, targets[0].id).state, 'queued');
});

test("another publication cannot acquire an active host lane, but can deliver its independent peer", async t => {
  const h = harness(t);
  const first = initial();
  rollForwardHosts(first, [targets[0]], h.operations);
  const child = h.children.get(targets[0].id);
  await child.ready;
  const second = { ...initial(), requestId: "PUB-abcdef012345678901234567" };
  const inputPaths = new Map();
  rollForwardHosts(second, targets, { ...h.operations, active: () => false, launch(target, inputPath) {
    inputPaths.set(target.id, inputPath);
    return { ok: true };
  } });
  const inputPath = inputPaths.get(targets[0].id);
  const contention = spawn("flock", ["-n", "-E", "75", hostLaneLockPath(h.laneRoot, targets[0].id), process.execPath, "-e", "process.exit(42)"], { stdio: "ignore" });
  assert.equal(await new Promise(resolve => contention.once("exit", resolve)), 75);
  assert.equal(readHostLane(h.laneRoot, second.requestId, integrationSha, targets[0].id).state, "queued");
  assert.equal(JSON.parse(readFileSync(inputPath)).request.requestId, second.requestId);
  runHostLane(inputPaths.get(targets[1].id), { bind() {}, recover() {}, deliver() { return { status: "passed", integrationSha }; } });
  mergeHostLanes(second, h.laneRoot, targets);
  assert.equal(second.hosts.converge.status, "passed");
  assert.equal(first.reservations?.[targets[0].id], undefined, "parent's central snapshot isn't a shared writer");
  mergeHostLanes(first, h.laneRoot, targets);
  assert.equal(first.reservations[targets[0].id].state, "restore-required");
  await release(child);
});

test("checkpoint rejects changed integration and lost journal revision before a later effect", t => {
  const h = harness(t);
  const request = initial();
  let checkpoint;
  let local;
  const operations = { ...h.operations, active: () => false, launch(target, inputPath) {
    runHostLane(inputPath, { bind(value, save) { local = value; checkpoint = save; }, recover() {},
      deliver(value) { return { status: "passed", integrationSha: value.integrationSha }; } });
    return { ok: true };
  } };
  rollForwardHosts(request, [targets[0]], operations);
  local.integrationSha = "b".repeat(40);
  assert.throws(() => checkpoint(local), /immutable integration/);
  local.integrationSha = integrationSha;
  const lane = readHostLane(h.laneRoot, requestId, integrationSha, targets[0].id);
  const path = join(h.laneRoot, requestId, integrationSha, targets[0].id, "journal.json");
  writeFileSync(path, JSON.stringify({ ...lane, revision: lane.revision + 1 }));
  assert.throws(() => checkpoint(local), /lost custody/);
});
