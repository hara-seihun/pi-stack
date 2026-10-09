import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freezeSourceBundle, sourceOnlyQueued, sourceBundleMembers, resolveSourceBundle } from "../deploy/publication-bundle.mjs";
import { publicationConfig } from "./publication-fixture.mjs";

const request = digit => ({ requestId: `PUB-${digit.repeat(24)}`, sourceSha: digit.repeat(40), sourceRef: `refs/heads/pi-stack-publications/PUB-${digit.repeat(24)}`,
  status: "queued", step: "queued", attempt: 0, failures: [] });
const ready = () => true;
const freeze = (leader, requests) => {
  const result = freezeSourceBundle(leader, requests, ready);
  assert.equal(result.ok, true);
  return { ...leader, sourceBundle: result.bundle };
};
const follower = (source, owner) => ({ ...source, step: "awaiting-source-bundle", sourceBundleOwner: { requestId: owner.requestId, bundleId: owner.sourceBundle.id } });

const root = mkdtempSync(join(tmpdir(), "publication-bundle-"));
process.env.PI_STACK_PUBLICATION_CONFIG = publicationConfig(root);
process.env.PI_STACK_PUBLICATION_STATE = root;
const { integrateSourceBundle, freezeQueuedSources, reconcileSourceBundles } = await import("../deploy/publication");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("one frozen cohort excludes repairs, nonready requests and any live or historical host effects", () => {
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

test("cohort identities bind exact immutable source refs and reject tampering", () => {
  const owner = freeze(request("1"), [request("2")]);
  assert.equal(sourceBundleMembers(owner).ok, true);
  const tampered = structuredClone(owner);
  tampered.sourceBundle.sources[1].sourceSha = "f".repeat(40);
  assert.equal(sourceBundleMembers(tampered).error.kind, "invalid-bundle");
  const changedSource = follower({ ...request("2"), sourceSha: "e".repeat(40) }, owner);
  assert.equal(resolveSourceBundle(changedSource, owner).error.kind, "bundle-binding-mismatch");
  assert.equal(resolveSourceBundle(follower(request("2"), owner), undefined).error.kind, "missing-bundle-owner");
});

test("source evidence becomes reusable only after passing checks and integration, independently of host waits or failures", () => {
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

test("integration fetches the cohort once and retains every branch ancestry; moved immutable refs fail before merging", () => {
  const remote = join(root, "remote");
  mkdirSync(remote);
  git(remote, "init", "--quiet", "-b", "main");
  git(remote, "config", "user.name", "Fixture");
  git(remote, "config", "user.email", "fixture@example.test");
  writeFileSync(join(remote, "base"), "base");
  git(remote, "add", ".");
  git(remote, "commit", "--quiet", "-m", "base");
  const baseSha = git(remote, "rev-parse", "HEAD");
  const sources = [request("1"), request("2")].map((source, index) => {
    git(remote, "checkout", "--quiet", "-B", `source-${index}`, baseSha);
    writeFileSync(join(remote, `source-${index}`), String(index));
    git(remote, "add", ".");
    git(remote, "commit", "--quiet", "-m", `source-${index}`);
    source.sourceSha = git(remote, "rev-parse", "HEAD");
    git(remote, "update-ref", source.sourceRef, source.sourceSha);
    return source;
  });
  git(remote, "checkout", "--quiet", "main");
  const clone = spawnSync("git", ["clone", "--quiet", remote, join(root, "repository")], { encoding: "utf8", timeout: 5_000 });
  assert.equal(clone.status, 0, clone.stderr);
  mkdirSync(join(root, "requests"));
  for (const source of sources) writeFileSync(join(root, "requests", `${source.requestId}.json`), JSON.stringify(source));
  const owner = freeze(sources[0], sources);
  const log = join(root, "bundle.log");
  const integration = integrateSourceBundle(owner, log);
  assert.equal(integration.ok, true, integration.stderr);
  assert.equal(integration.baseSha, baseSha);
  for (const source of sources) git(join(root, "repository"), "merge-base", "--is-ancestor", source.sourceSha, "HEAD");
  const steps = readFileSync(log, "utf8");
  assert.equal(steps.match(/\] fetch-submitted-sources/g).length, 1);
  assert.equal(steps.match(/\] merge-source/g).length, 2);
  assert.equal(/\] checks/.test(steps), false);
  git(remote, "update-ref", sources[1].sourceRef, baseSha);
  const moved = integrateSourceBundle(owner, join(root, "moved.log"));
  assert.equal(moved.ok, false);
  assert.match(moved.stderr, /source ref moved/);
  assert.equal(/create-integration/.test(readFileSync(join(root, "moved.log"), "utf8")), false);

  for (const source of sources) {
    source.updatedAt = "2026-10-09T00:00:00Z";
    source.queuedAt = "2026-10-09T00:00:00Z";
    writeFileSync(join(root, "requests", `${source.requestId}.json`), JSON.stringify(source));
  }
  freezeQueuedSources(sources[0]);
  const followerPath = join(root, "requests", `${sources[1].requestId}.json`);
  const bound = JSON.parse(readFileSync(followerPath));
  assert.equal(bound.sourceBundleOwner.requestId, sources[0].requestId);
  assert.equal(bound.integrationSha, undefined);
  writeFileSync(followerPath, JSON.stringify(sources[1]));
  reconcileSourceBundles();
  assert.deepEqual(JSON.parse(readFileSync(followerPath)).sourceBundleOwner, bound.sourceBundleOwner, "restarts repair a partially persisted cohort binding");

  const checkedOwner = { ...sources[0], status: "failed", integrationSha: git(join(root, "repository"), "rev-parse", "HEAD"), baseSha,
    checks: { status: "passed", log }, integratedAt: "2026-10-09T00:01:00Z", hosts: { converge: { status: "failed" } },
    nativeHistory: { hosts: { converge: { state: "repair-required" } } } };
  writeFileSync(join(root, "requests", `${checkedOwner.requestId}.json`), JSON.stringify(checkedOwner));
  reconcileSourceBundles();
  const hydrated = JSON.parse(readFileSync(followerPath));
  assert.equal(hydrated.integrationSha, checkedOwner.integrationSha);
  assert.equal(hydrated.status, "queued");
  assert.equal(hydrated.step, "source-bundle-ready");
  assert.equal(hydrated.nativeHistory, undefined);
  assert.equal(hydrated.hosts, undefined);
  assert.equal(JSON.parse(readFileSync(join(root, "requests", `${checkedOwner.requestId}.json`))).nativeHistory.hosts.converge.state, "repair-required");
  writeFileSync(join(root, "requests", `${sources[1].requestId}.cancel`), "cancel");
  assert.throws(() => integrateSourceBundle(checkedOwner, join(root, "cancelled.log")), /Source bundle member .* cancelled/);
  assert.throws(() => integrateSourceBundle(hydrated, join(root, "cancelled-follower.log")), /Publication cancelled/);
});
