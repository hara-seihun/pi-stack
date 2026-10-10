import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freezeSourceBundle, sourceOnlyQueued, sourceBundleMembers, resolveSourceBundle } from "../deploy/publication-bundle.mjs";
import { repairSourceRef } from "../deploy/publication-continuation.mjs";
import { publicationConfig } from "./publication-fixture.mjs";

const publication = new URL("../deploy/publication", import.meta.url).href;
const request = digit => ({ requestId: `PUB-${digit.repeat(24)}`, sourceSha: digit.repeat(40), sourceRef: `refs/heads/pi-stack-publications/PUB-${digit.repeat(24)}`,
  status: "queued", step: "queued", attempt: 0, failures: [] });
const ready = () => true;
const freeze = (leader, requests) => {
  const result = freezeSourceBundle(leader, requests, ready);
  assert.equal(result.ok, true);
  return { ...leader, sourceBundle: result.bundle };
};
const follower = (source, owner) => ({ ...source, step: "awaiting-source-bundle", sourceBundleOwner: { requestId: owner.requestId, bundleId: owner.sourceBundle.id } });

test("a frozen cohort excludes nonready requests, repairs and live or historical host effects", () => {
  const leader = request("1"), other = request("2");
  const excluded = [
    { ...request("3"), status: "running" }, { ...request("4"), repairOf: leader.requestId },
    { ...request("5"), attempt: 1 }, { ...request("6"), failures: [{ reason: "checks-failed" }] },
    ...["hosts", "reservations", "bootstrap", "maintenance", "nativeHistory", "waiting", "android", "checks", "actionJournal"].map(key => ({ ...request("7"), [key]: {} })),
  ];
  for (const candidate of excluded) assert.equal(sourceOnlyQueued(candidate), false);
  const frozen = freezeSourceBundle(leader, [leader, other, request("8"), ...excluded], candidate => candidate.requestId !== request("8").requestId);
  assert.deepEqual(frozen.bundle.sources.map(source => source.requestId), [leader.requestId, other.requestId]);
  assert.equal(freezeSourceBundle(excluded[0], [leader], ready).error.kind, "ineligible-leader");
});

test("cohort identities bind immutable source refs and reject tampering", () => {
  const owner = freeze(request("1"), [request("2")]);
  assert.equal(sourceBundleMembers(owner).ok, true);
  const tampered = structuredClone(owner);
  tampered.sourceBundle.sources[1].sourceSha = "f".repeat(40);
  assert.equal(sourceBundleMembers(tampered).error.kind, "invalid-bundle");
  const changedSource = follower({ ...request("2"), sourceSha: "e".repeat(40) }, owner);
  assert.equal(resolveSourceBundle(changedSource, owner).error.kind, "bundle-binding-mismatch");
  assert.equal(resolveSourceBundle(follower(request("2"), owner), undefined).error.kind, "missing-bundle-owner");
});

test("checked immutable source evidence is reusable independently of host waits or failures", () => {
  const original = freeze(request("1"), [request("2")]);
  const consumer = follower(request("2"), original);
  assert.equal(resolveSourceBundle(consumer, original).state, "pending");
  const checked = { ...original, integrationSha: "a".repeat(40), baseSha: "b".repeat(40), checks: { status: "passed", command: "check" } };
  assert.equal(resolveSourceBundle(consumer, checked).state, "pending");
  const delivered = { ...checked, integratedAt: "2026-10-09T00:00:00Z", hosts: { converge: { status: "failed", failure: { reason: "native-history-custody" } } },
    nativeHistory: { hosts: { converge: { state: "repair-required" } } }, reservations: { converge: { state: "reserved" } },
    android: { directory: "/immutable/artifacts", status: "published", hosts: { local: { status: "passed" } }, release: { revision: checked.integrationSha } } };
  for (const status of ["queued", "failed", "published"]) {
    const result = resolveSourceBundle(consumer, { ...delivered, status });
    assert.equal(result.state, "ready");
    assert.equal(result.evidence.android.directory, delivered.android.directory);
    assert.deepEqual(result.evidence.android.hosts, {});
    for (const key of ["hosts", "nativeHistory", "reservations", "reporter", "actionJournal"]) assert.equal(key in result.evidence, false);
    result.evidence.checks.command = "changed";
    assert.equal(delivered.checks.command, "check");
  }
});

test("failed unchecked bundle returns causal failure instead of resubmitting unchanged sources", () => {
  const owner = { ...freeze(request("1"), [request("2")]), status: "failed", failure: { step: "checks", message: "bad combined source", log: "/proof/log" } };
  const result = resolveSourceBundle(follower(request("2"), owner), owner);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.failure, owner.failure);
  assert.equal(resolveSourceBundle(follower(request("2"), owner), { ...owner, status: "published" }).error.kind, "invalid-owner-state");
});

function git(path, ...args) {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "publication-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "source"), remote = join(root, "remote.git"), checkout = join(root, "repository");
  mkdirSync(work);
  git(root, "init", "--quiet", "--bare", remote);
  git(work, "init", "--quiet", "-b", "main");
  git(work, "config", "user.name", "Fixture");
  git(work, "config", "user.email", "fixture@example.test");
  writeFileSync(join(work, "base"), "base\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "base");
  const baseSha = git(work, "rev-parse", "HEAD");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  git(root, "clone", "--quiet", "--branch", "main", remote, checkout);
  const config = publicationConfig(root);
  mkdirSync(join(root, "requests"));
  const path = source => join(root, "requests", `${source.requestId}.json`);
  const persist = source => writeFileSync(path(source), JSON.stringify(source));
  const read = source => JSON.parse(readFileSync(path(source), "utf8"));
  function commit(name, parent = baseSha) {
    git(work, "checkout", "--quiet", "--detach", parent);
    writeFileSync(join(work, name), `${name}\n`);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", name);
    return git(work, "rev-parse", "HEAD");
  }
  function source(digit, parent = baseSha) {
    const submitted = { ...request(digit), sourceSha: commit(`source-${digit}`, parent) };
    git(work, "push", "--quiet", "origin", `${submitted.sourceSha}:${submitted.sourceRef}`);
    persist(submitted);
    return submitted;
  }
  function repair(owner, name, parent) {
    const sourceSha = commit(name, parent);
    const retained = { sourceSha, sourceRef: repairSourceRef(owner.requestId, sourceSha) };
    git(work, "push", "--quiet", "origin", `${sourceSha}:${retained.sourceRef}`);
    return retained;
  }
  function moveMain(parent = baseSha) {
    const main = commit("concurrent-main", parent);
    git(work, "push", "--quiet", "origin", `${main}:refs/heads/main`);
    git(checkout, "fetch", "--quiet", "origin");
    return main;
  }
  function run(script) {
    return spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { integrateSourceBundle, freezeQueuedSources, reconcileSourceBundles } from ${JSON.stringify(publication)};
      ${script}
    `], { encoding: "utf8", timeout: 5_000,
      env: { ...process.env, PI_STACK_PUBLICATION_CONFIG: config, PI_STACK_PUBLICATION_STATE: root } });
  }
  function integrate(owner, name = "integration") {
    const log = join(root, `${name}.log`);
    const result = run(`console.log(JSON.stringify(integrateSourceBundle(${JSON.stringify(owner)}, ${JSON.stringify(log)})));`);
    assert.equal(result.status, 0, result.stderr);
    return { result: JSON.parse(result.stdout), log };
  }
  return { root, work, remote, checkout, baseSha, source, repair, moveMain, persist, read, run, integrate };
}

function assertExactSelection(f, expected, log) {
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), expected, "integration must never synthesize a new commit");
  const steps = readFileSync(log, "utf8");
  assert.equal(/\] (merge-source|merge-repair-source|checks)\b/.test(steps), false);
}

test("integration selects the exact submitted SHA, not concurrent main", t => {
  const f = fixture(t), owner = f.source("1");
  const main = f.moveMain();
  assert.notEqual(main, owner.sourceSha);
  const { result, log } = f.integrate(owner);
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.baseSha, owner.sourceSha);
  assertExactSelection(f, owner.sourceSha, log);
  assert.equal(git(f.checkout, "rev-parse", "origin/main"), main);
  const absent = spawnSync("git", ["-C", f.checkout, "cat-file", "-e", "HEAD:concurrent-main"], { timeout: 5_000 });
  assert.notEqual(absent.status, 0, "latest main must not leak into the submitted tree");
});

test("same-request continuation selects the last retained repair SHA exactly", t => {
  const f = fixture(t), owner = f.source("1");
  const first = f.repair(owner, "repair-one", owner.sourceSha);
  const last = f.repair(owner, "repair-two", first.sourceSha);
  owner.repairSources = [first, last];
  f.persist(owner);
  f.moveMain();
  const { result, log } = f.integrate(owner);
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.baseSha, owner.sourceSha);
  assertExactSelection(f, last.sourceSha, log);
  for (const source of [owner, first]) git(f.checkout, "merge-base", "--is-ancestor", source.sourceSha, "HEAD");
  assert.equal(f.read(owner).sourceSha, owner.sourceSha, "continuation keeps the original request source binding");
});

test("readiness can freeze only queued ancestors covered by the leader's exact SHA", t => {
  const f = fixture(t), ancestor = f.source("2"), leader = f.source("1", ancestor.sourceSha), divergent = f.source("3");
  const frozen = freezeSourceBundle(leader, [ancestor, divergent], candidate => {
    const proof = spawnSync("git", ["-C", f.work, "merge-base", "--is-ancestor", candidate.sourceSha, leader.sourceSha], { timeout: 5_000 });
    assert.ok(proof.status === 0 || proof.status === 1);
    return proof.status === 0;
  });
  assert.equal(frozen.ok, true);
  assert.deepEqual(frozen.bundle.sources.map(source => source.requestId), [leader.requestId, ancestor.requestId]);
});

test("retained ancestor bundles validate once without changing the selected commit, and restart bindings preserve separate custody", t => {
  const f = fixture(t), ancestor = f.source("2"), owner = freeze(f.source("1", ancestor.sourceSha), [ancestor]);
  f.persist(owner);
  f.moveMain();
  const { result, log } = f.integrate(owner);
  assert.equal(result.ok, true, result.stderr);
  assertExactSelection(f, owner.sourceSha, log);
  git(f.checkout, "merge-base", "--is-ancestor", ancestor.sourceSha, "HEAD");
  assert.equal(readFileSync(log, "utf8").match(/\] fetch-submitted-sources/g).length, 1);
  let bound = f.run(`freezeQueuedSources(${JSON.stringify(owner)});`);
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(f.read(ancestor).sourceBundleOwner.requestId, owner.requestId);
  assert.equal(f.read(ancestor).integrationSha, undefined);
  f.persist(ancestor);
  bound = f.run("reconcileSourceBundles();");
  assert.equal(bound.status, 0, bound.stderr);
  assert.deepEqual(f.read(ancestor).sourceBundleOwner, follower(ancestor, owner).sourceBundleOwner, "restart repairs partially persisted retained bindings");

  const checkedOwner = { ...owner, status: "failed", integrationSha: owner.sourceSha, baseSha: owner.sourceSha,
    checks: { status: "passed", log }, integratedAt: "2026-10-09T00:01:00Z", hosts: { converge: { status: "failed" } },
    nativeHistory: { hosts: { converge: { state: "repair-required" } } } };
  f.persist(checkedOwner);
  const reconciled = f.run("reconcileSourceBundles();");
  assert.equal(reconciled.status, 0, reconciled.stderr);
  const hydrated = f.read(ancestor);
  assert.equal(hydrated.integrationSha, owner.sourceSha);
  assert.equal(hydrated.status, "queued");
  assert.equal(hydrated.step, "source-bundle-ready");
  assert.equal(hydrated.nativeHistory, undefined);
  assert.equal(hydrated.hosts, undefined);
  assert.equal(f.read(owner).nativeHistory.hosts.converge.state, "repair-required");
  writeFileSync(join(f.root, "requests", `${ancestor.requestId}.cancel`), "cancel");
  const cancelledOwner = f.run(`integrateSourceBundle(${JSON.stringify(checkedOwner)}, ${JSON.stringify(join(f.root, "cancelled.log"))});`);
  assert.notEqual(cancelledOwner.status, 0);
  assert.match(cancelledOwner.stderr, /Source bundle member .* cancelled/);
  const cancelledFollower = f.run(`integrateSourceBundle(${JSON.stringify(hydrated)}, ${JSON.stringify(join(f.root, "cancelled-follower.log"))});`);
  assert.notEqual(cancelledFollower.status, 0);
  assert.match(cancelledFollower.stderr, /Publication cancelled/);
});

test("an uncovered retained bundle member fails instead of merging a different commit", t => {
  const f = fixture(t), leader = f.source("1"), unrelated = f.source("2"), owner = freeze(leader, [unrelated]);
  f.persist(owner);
  const { result, log } = f.integrate(owner);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /omits/);
  assert.ok(result.stderr.includes(unrelated.sourceSha));
  assertExactSelection(f, leader.sourceSha, log);
});

test("the selected repair must cover earlier retained repairs", t => {
  const f = fixture(t), owner = f.source("1");
  const first = f.repair(owner, "repair-one", owner.sourceSha);
  const fork = f.repair(owner, "repair-fork", owner.sourceSha);
  owner.repairSources = [first, fork];
  f.persist(owner);
  const { result, log } = f.integrate(owner);
  assert.equal(result.ok, false);
  assert.ok(result.stderr.includes(first.sourceSha));
  assertExactSelection(f, fork.sourceSha, log);
});

for (const repairMoved of [false, true]) test(`a moved immutable ${repairMoved ? "repair" : "submission"} ref fails instead of selecting its new target`, t => {
  const f = fixture(t), owner = f.source("1");
  let retained = owner;
  if (repairMoved) {
    retained = f.repair(owner, "repair", owner.sourceSha);
    owner.repairSources = [retained];
    f.persist(owner);
  }
  git(f.remote, "update-ref", retained.sourceRef, f.baseSha);
  const { result, log } = f.integrate(owner);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /source ref moved|repair source ref changed/i);
  assertExactSelection(f, f.baseSha, log);
});

test("queued requests do not automatically become a new cohort", t => {
  const f = fixture(t), ancestor = f.source("2"), leader = f.source("1", ancestor.sourceSha);
  const frozen = f.run(`freezeQueuedSources(${JSON.stringify(leader)});`);
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.equal(f.read(leader).sourceBundle, undefined);
  assert.equal(f.read(ancestor).sourceBundleOwner, undefined);
  assert.equal(f.read(ancestor).step, "queued");
});
