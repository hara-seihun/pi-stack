import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

const configRoot = mkdtempSync(join(tmpdir(), "publication-reservation-config-"));
process.env.PI_STACK_PUBLICATION_CONFIG = publicationConfig(configRoot);
process.on("exit", () => rmSync(configRoot, { recursive: true, force: true }));
const { publicationReservationScript, outstandingHostCustody } = await import("../deploy/publication");
const request = "PUB-0123456789abcdef01234567";
const revision = "a".repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "publication-reservation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, "deploy.lock");
  const reservation = `${lock}.publication`;
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/sudo"), '#!/bin/sh\n[ "$1" != -n ] || shift\nexec "$@"\n', { mode: 0o755 });
  const env = { ...process.env, PI_STACK_HOST_LOCK_PATH: lock, PATH: `${root}/bin:${process.env.PATH}` };
  function run(script, args = [], overrides = {}) {
    return spawnSync("bash", ["-s", "--", ...args], {
      input: script, encoding: "utf8", timeout: 3000, env: { ...env, ...overrides },
    });
  }
  function reserve(operation = "reserve", owner = request, commit = revision) {
    return run(publicationReservationScript, [operation, owner, commit]);
  }
  function check(owner = "", commit = revision) {
    return run('set -euo pipefail\nsource "$1"\npi_stack_acquire_host_lock\npi_stack_check_publication_reservation "$2"',
      [resolve("deploy/release-checkout"), commit], { PI_STACK_PUBLICATION_REQUEST: owner });
  }
  return { root, lock, reservation, env, run, reserve, check };
}

test("a publication reserves the host across separate commands, until its own release", t => {
  const f = fixture(t);
  assert.equal(f.check().status, 0);
  assert.equal(f.reserve().status, 0);
  assert.equal(f.reserve().status, 0, "recovery can reacquire the same reservation");
  assert.equal(f.check().status, 75, "direct deployment cannot supersede the first host during second-host proof");
  assert.equal(f.check("another-publication").status, 75);
  assert.equal(f.check(request, "b".repeat(40)).status, 75, "owner cannot deploy an unchecked commit");
  assert.equal(f.check(request).status, 0);
  for (const operation of ["reserve", "release"]) {
    assert.equal(f.reserve(operation, "another-publication").status, 75);
    assert.equal(JSON.parse(readFileSync(f.reservation)).requestId, request);
  }
  assert.equal(f.reserve("release").status, 0);
  assert.equal(f.reserve("release").status, 0, "release after a crash is idempotent");
  assert.equal(existsSync(f.reservation), false);
  assert.equal(f.check().status, 0);
});

test("component entry checks the reservation even when its caller already holds the deployment locks", t => {
  const f = fixture(t);
  const repo = join(f.root, "repo");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  for (const file of ["lib", "release-checkout"]) copyFileSync(resolve("deploy", file), join(repo, "deploy", file));
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(f.reserve("reserve", request, commit).status, 0);
  const script = 'set -euo pipefail\nsource "$1/deploy/lib"\npi_stack_enter_deployment "$1/deploy/runtime" "$1"\necho activated';
  const held = { PI_STACK_DEPLOY_DEADLINE_ACTIVE: "1", PI_STACK_HOST_LOCK_HELD: "1", PI_STACK_DEPLOY_LOCK_HELD: "1" };
  const denied = f.run(script, [repo], held);
  assert.equal(denied.status, 75, denied.stderr);
  assert.equal(denied.stdout, "");
  const allowed = f.run(script, [repo], { ...held, PI_STACK_PUBLICATION_REQUEST: request });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "activated");
});

for (const outcome of ["busy", "interrupted", "failed", "published"]) test(`publication ${outcome} releases its reservation without dropping source or restoration history`, t => {
  const f = fixture(t);
  const configPath = publicationConfig(f.root, resolve("."));
  const config = JSON.parse(readFileSync(configPath));
  config.targets = config.targets.slice(0, 1);
  writeFileSync(configPath, JSON.stringify(config));
  const receipt = { requestId: request, integrationSha: revision, sourceSha: revision,
    sourceRef: "refs/heads/submitted", status: ["busy", "interrupted"].includes(outcome) ? "running" : outcome,
    maintenance: { hosts: { gmktec: { state: "restored", plan: { launches: "paused" } } } } };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { reserveTarget, requeueBusyHost, recoverOutstandingCustody } from ${JSON.stringify(new URL("../deploy/publication", import.meta.url).href)};
    const request = ${JSON.stringify(receipt)};
    const target = ${JSON.stringify(config.targets[0])};
    const log = ${JSON.stringify(join(f.root, "commands.log"))};
    const result = reserveTarget(request, target, log);
    if (!result.ok) throw new Error(JSON.stringify(result));
    if (${JSON.stringify(outcome)} === "busy") requeueBusyHost(request, target, log);
    else recoverOutstandingCustody(request);
    console.log(JSON.stringify(request));
  `], { encoding: "utf8", timeout: 3000, env: { ...f.env,
    PI_STACK_PUBLICATION_CONFIG: configPath, PI_STACK_PUBLICATION_STATE: f.root } });
  assert.equal(result.status, 0, result.stderr);
  const restored = JSON.parse(result.stdout);
  assert.equal(restored.reservations.gmktec.state, "released");
  assert.equal(restored.sourceRef, receipt.sourceRef);
  assert.equal(restored.integrationSha, revision);
  assert.deepEqual(restored.maintenance, receipt.maintenance);
  assert.equal(existsSync(f.reservation), false);
  assert.equal(f.check().status, 0);
});

test("reservation-only custody remains visible to recovery, watchdog and issue reporting", () => {
  for (const status of ["running", "queued", "failed", "published"]) {
    const receipt = { status, reservations: { gmktec: { state: "restore-required", integrationSha: revision } } };
    assert.equal(outstandingHostCustody(receipt), true, status);
    receipt.reservations.gmktec.state = "released";
    assert.equal(outstandingHostCustody(receipt), false, status);
  }
});
