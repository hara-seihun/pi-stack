import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { publicationConfig } from "./publication-fixture.mjs";
import { observeQueueProgress, queueStallReason, policy } from "../deploy/publication-control.mjs";

const now = Date.parse("2026-09-29T16:54:08Z");
const iso = delta => new Date(now + delta).toISOString();
const request = { requestId: "PUB-0123456789abcdef01234567", status: "queued", updatedAt: iso(-200_000), nextAttemptAt: iso(-170_000),
  waiting: { kind: "live-meeting" } };
const observed = { ...observeQueueProgress(request, undefined, now), since: iso(-100_000), observedAt: iso(-10_000) };

test("queue supervision measures one unchanged request across continuous observations", () => {
  assert.match(queueStallReason(request, observed, now), /Meeting probe was not serviced/);
  assert.match(queueStallReason({ ...request, waiting: undefined }, observed, now), /worker never claimed/);
  for (const changed of [
    { ...request, requestId: "PUB-fedcba9876543210fedcba98" },
    { ...request, updatedAt: iso(-40_000) },
    { ...request, nextAttemptAt: iso(-5_000) },
    { ...request, status: "running" },
    { ...request, status: "failed" },
    { ...request, nextAttemptAt: iso(30_000) },
  ]) assert.equal(queueStallReason(changed, observed, now), null, JSON.stringify(changed));
  assert.equal(observeQueueProgress(undefined, observed, now), undefined);
});

test("watchdog downtime and pre-upgrade global clocks cannot exhaust a request's claim budget", () => {
  for (const previous of [undefined, { since: iso(-100_000) }, { ...observed, observedAt: iso(-policy.betweenStepsMs - 1) },
    { ...observed, observedAt: iso(1) }]) {
    const resumed = observeQueueProgress(request, previous, now);
    assert.equal(resumed.since, iso(0));
    assert.equal(queueStallReason(request, resumed, now), null);
  }
});

test("arbitrarily long meetings stay healthy through probes, but a missing worker still fails", () => {
  let current = request;
  let observation;
  for (let minutes = 0; minutes < 240; minutes += 1) {
    const time = now + minutes * 60_000;
    current = { ...current, updatedAt: new Date(time - 40_000).toISOString(), nextAttemptAt: new Date(time - 10_000).toISOString() };
    observation = observeQueueProgress(current, observation, time);
    assert.equal(queueStallReason(current, observation, time), null);
  }
  const start = Date.parse(observation.observedAt);
  for (let delta = 10_000; delta <= 100_000; delta += 10_000) {
    observation = observeQueueProgress(current, observation, start + delta);
    assert.equal(Boolean(queueStallReason(current, observation, start + delta)), delta > policy.betweenStepsMs);
  }
});

function ownerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "publication-held-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(join(state, "requests"), { recursive: true });
  mkdirSync(bin);
  const calls = join(root, "systemctl.log");
  writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n', { mode: 0o700 });
  const env = { ...process.env, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root),
    PI_STACK_PUBLICATION_STATE: state, PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox"),
    PATH: `${bin}:${process.env.PATH}`, SYSTEMCTL_LOG: calls };
  const command = new URL("../deploy/publication", import.meta.url).pathname;
  const run = (args) => spawnSync(process.execPath, [command, ...args], { env, encoding: "utf8", timeout: 5000 });
  const invoke = (expression) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { prepareRepairSource } from ${JSON.stringify(pathToFileURL(command).href)}; ${expression}`], { env, encoding: "utf8", timeout: 5000 });
  const receipt = join(state, "requests", `${request.requestId}.json`);
  const queued = { ...request, waiting: undefined, sourceSha: "a".repeat(40) };
  writeFileSync(receipt, JSON.stringify(queued));
  return { root, state, env, calls, run, invoke, receipt, queued };
}

const hold = { version: 1, reason: "Keep admission open during owner repair", threadId: "fixture-parent",
  applicationStop: false, releaseWhen: "Always-open owner is installed" };

test("explicit hold preserves queued receipts, suppresses wake/failure and resets the claim clock on release", t => {
  const f = ownerFixture(t);
  const holdPath = join(f.state, "always-open-source-hold.json");
  writeFileSync(holdPath, JSON.stringify(hold));
  const unchanged = readFileSync(f.receipt, "utf8");
  writeFileSync(join(f.state, "worker-watch.json"), JSON.stringify({ queue: {
    ...observeQueueProgress(f.queued, undefined), since: new Date(Date.now() - 200_000).toISOString() } }));
  let result = f.run(["watchdog"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.receipt, "utf8"), unchanged);
  const watch = JSON.parse(readFileSync(join(f.state, "worker-watch.json"), "utf8"));
  assert.equal(watch.hold.reason, hold.reason);
  assert.equal(watch.queue, undefined);
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /start --no-block pi-stack-publication\.service/);
  result = f.run(["_fail-unclaimed", request.requestId, JSON.stringify(observed)]);
  assert.equal(result.status, 0, result.stderr);
  result = f.run(["drain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.receipt, "utf8"), unchanged);
  assert.equal(readFileSync(holdPath, "utf8"), JSON.stringify(hold));
  rmSync(holdPath);
  result = f.run(["watchdog"]);
  assert.equal(result.status, 0, result.stderr);
  const released = JSON.parse(readFileSync(join(f.state, "worker-watch.json"), "utf8"));
  assert.equal(released.hold, undefined);
  assert.ok(Date.now() - Date.parse(released.queue.since) < 5000);
  assert.match(readFileSync(f.calls, "utf8"), /start --no-block pi-stack-publication\.service/);
  assert.equal(readFileSync(f.receipt, "utf8"), unchanged);
});

test("malformed hold refuses execution instead of interpreting it as permission to deploy", t => {
  const f = ownerFixture(t);
  writeFileSync(join(f.state, "always-open-source-hold.json"), JSON.stringify({ ...hold, applicationStop: true }));
  const result = f.run(["drain"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid publication hold/);
  assert.equal(existsSync(f.calls), false);
});

test("repair preparation fetches exact immutable source custody before a local writer clone", t => {
  const f = ownerFixture(t);
  const remote = join(f.root, "remote");
  const repository = join(f.state, "repository");
  const git = (args) => {
    const result = spawnSync("git", args, { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", remote]);
  writeFileSync(join(remote, "source"), "retained source\n");
  git(["-C", remote, "add", "."]);
  git(["-C", remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "Source"]);
  const sourceSha = git(["-C", remote, "rev-parse", "HEAD"]);
  const sourceRef = `refs/heads/pi-stack-publications/${request.requestId}`;
  git(["-C", remote, "update-ref", sourceRef, sourceSha]);
  git(["init", "-q", repository]);
  git(["-C", repository, "config", `url.file://${remote}.insteadOf`, "https://github.com/hara-seihun/pi-stack.git"]);
  const repair = { requestId: request.requestId, sourceSha, sourceRef };
  let result = f.invoke(`console.log(prepareRepairSource(${JSON.stringify(repair)}));`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), sourceSha);
  const retainedRef = `refs/pi-stack-publication/${request.requestId}/source`;
  assert.equal(git(["-C", repository, "rev-parse", `${retainedRef}^{commit}`]), sourceSha);
  git(["clone", "--quiet", "--no-checkout", repository, join(f.root, "writer")]);
  git(["-C", join(f.root, "writer"), "checkout", "--quiet", "--detach", sourceSha]);
  result = f.invoke(`prepareRepairSource(${JSON.stringify({ ...repair, sourceSha: "b".repeat(40) })});`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Retained repair source differs/);
  assert.equal(git(["-C", repository, "rev-parse", retainedRef]), sourceSha);
  result = f.invoke(`prepareRepairSource(${JSON.stringify({ ...repair, sourceRef: "refs/heads/other" })});`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Repair source ref does not match/);
});
