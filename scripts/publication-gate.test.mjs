import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canResumeRebootedIntegration, policy } from "../deploy/publication-control.mjs";
import { publicationConfig } from "./publication-fixture.mjs";

const currentBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const previousBootId = currentBootId === "00000000-0000-0000-0000-000000000001"
  ? "00000000-0000-0000-0000-000000000002" : "00000000-0000-0000-0000-000000000001";

function interruptedIntegration() {
  return { status: "running", step: "integrate-main", workerBootId: previousBootId, attempt: 1,
    baseSha: "b".repeat(40), integrationSha: "c".repeat(40), checks: { status: "passed" } };
}

test("only a bounded, checked pre-host integration may resume after a proven reboot", () => {
  const request = interruptedIntegration();
  assert.equal(canResumeRebootedIntegration(request, currentBootId), true);
  assert.equal(canResumeRebootedIntegration({ ...request, step: "confirm-integrated-main" }, currentBootId), true);
  for (const change of [
    { workerBootId: currentBootId }, { workerBootId: undefined }, { workerBootId: "unknown" },
    { status: "failed" }, { step: "checks" }, { step: "roll-forward-hosts" },
    { checks: { status: "running" } }, { integrationSha: undefined }, { baseSha: undefined },
    { integratedAt: "2030-01-01" }, { recoveryInProgress: true }, { hosts: {} },
    { reservations: {} }, { maintenance: {} }, { bootstrap: {} },
    { workerRestarts: Array(policy.maxAttempts).fill({}) },
  ]) assert.equal(canResumeRebootedIntegration({ ...request, ...change }, currentBootId), false, JSON.stringify(change));
  assert.equal(canResumeRebootedIntegration(request, "unknown"), false);
});

// Each pass performs dozens of durable writes and subprocesses alongside other check jobs.
const fixtureTimeoutMs = 15_000;

test("main movement returns before deployment and the next worker pass reruns checks", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-main-moved-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["bin", "repository/.git", "repository/deploy", "canonical/apps/kenan/android"]) mkdirSync(join(root, path), { recursive: true });
  const source = "a".repeat(40), base = "b".repeat(40), integration = "c".repeat(40), moved = "d".repeat(40);
  const requestId = "PUB-0123456789abcdef01234567";
  const receipt = join(root, "requests", `${requestId}.json`);
  const request = { requestId, sourceSha: source, sourceRef: `refs/heads/pi-stack-publications/${requestId}`, baseSha: base,
    integrationSha: integration, checks: { status: "passed" }, status: "queued", attempt: 0, failures: [] };
  writeFileSync(join(root, "main"), base);
  writeFileSync(join(root, "repository/deploy/lib"), 'pi_stack_prepare_dependencies() { :; }\n');
  writeFileSync(join(root, "canonical/apps/kenan/android/local.properties"), "fixture=true\n");
  writeFileSync(join(root, "bin/git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE/git"
case "$*" in
  *push*) echo 'unexpected push' >&2; exit 99;;
  *'remote get-url origin'*) echo https://github.com/hara-seihun/pi-stack.git;;
  *'fetch --quiet --no-tags origin +refs/heads/main:refs/remotes/origin/main'*)
    if [ -e "$TRACE/fetched" ]; then echo ${moved} > "$TRACE/main"; else touch "$TRACE/fetched"; fi;;
  *'rev-parse refs/remotes/origin/main'*) cat "$TRACE/main";;
  *'rev-parse refs/pi-stack-publication/'*) echo ${source};;
  *'rev-parse HEAD'*) echo ${integration};;
  *':deploy/android-update'*) exit 1;;
  *grep*) exit 1;;
esac
`, { mode: 0o700 });
  const hostStub = `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE/hosts"
cat >> "$TRACE/host-scripts"
echo 'host command before source integration' >&2
exit 99
`;
  writeFileSync(join(root, "bin/bash"), hostStub, { mode: 0o700 });
  writeFileSync(join(root, "bin/ssh"), hostStub, { mode: 0o700 });
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TRACE: root,
    PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root), PI_STACK_PUBLICATION_REPOSITORY: join(root, "canonical"), PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox") };
  function processOne(value) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { processRequest } from ${JSON.stringify(new URL("../deploy/publication", import.meta.url).href)};
      processRequest(${JSON.stringify(value)});
    `], { encoding: "utf8", timeout: fixtureTimeoutMs, env });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(readFileSync(receipt, "utf8"));
  }
  const queued = processOne(request);
  assert.equal(queued.status, "queued", JSON.stringify(queued.failure));
  assert.equal(queued.checks, undefined);
  assert.equal(queued.mainMovements[0].integrationSha, integration);
  assert.deepEqual(queued.failures, []);
  assert.equal(queued.reservations, undefined);
  assert.doesNotMatch(readFileSync(join(root, "git"), "utf8"), /push/);
  assert.equal(existsSync(join(root, "hosts")), false);
  rmSync(join(root, "bin/bash"));
  writeFileSync(join(root, "bin/npm"), '#!/bin/sh\necho "fresh integration checks reached" >&2\nexit 1\n', { mode: 0o700 });
  const checked = processOne(queued);
  assert.equal(checked.attempt, 2);
  assert.equal(checked.baseSha, moved, JSON.stringify(checked.failure));
  assert.equal(checked.failure.step, "checks");
  assert.match(checked.failure.excerpt, /fresh integration checks reached/);
  assert.equal(checked.mainMovements.length, 1);
});

for (const mainState of ["base", "pushed", "moved", "same-boot", "unrecorded-boot"]) test(`reboot recovery reconciles interrupted integration with ${mainState} main custody`, t => {
  const root = mkdtempSync(join(tmpdir(), "publication-reboot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["requests", "bin", "repository/.git"]) mkdirSync(join(root, path), { recursive: true });
  const requestId = "PUB-0123456789abcdef01234567";
  const receipt = join(root, "requests", `${requestId}.json`);
  const request = { ...interruptedIntegration(), requestId, sourceSha: "a".repeat(40), sourceRef: `refs/heads/pi-stack-publications/${requestId}`,
    failures: [], updatedAt: "2026-01-01T00:00:00.000Z", queuedAt: "2026-01-01T00:00:00.000Z",
    progress: { command: "git", args: ["push"], deadlineAt: "2026-01-01T00:00:00.000Z" } };
  if (mainState === "same-boot") request.workerBootId = currentBootId;
  if (mainState === "unrecorded-boot") delete request.workerBootId;
  writeFileSync(receipt, JSON.stringify(request));
  writeFileSync(join(root, "main"), mainState === "pushed" ? request.integrationSha : mainState === "moved" ? "d".repeat(40) : request.baseSha);
  writeFileSync(join(root, "bin/git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE/git"
case "$*" in
  *'remote get-url origin'*) echo https://github.com/hara-seihun/pi-stack.git;;
  *'rev-parse refs/remotes/origin/main'*) cat "$TRACE/main";;
  *'rev-parse refs/pi-stack-publication/'*) echo ${request.sourceSha};;
  *'rev-parse HEAD'*) echo ${request.integrationSha};;
  *push*) echo ${request.integrationSha} > "$TRACE/main";;
  *':deploy/android-update'*) exit 1;;
  *grep*) exit 1;;
esac
`, { mode: 0o700 });
  const hostStub = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE/hosts"\ncat >> "$TRACE/host-scripts"\nexit 75\n';
  for (const command of ["bash", "ssh"]) writeFileSync(join(root, "bin", command), hostStub, { mode: 0o700 });
  writeFileSync(join(root, "bin/npm"), '#!/bin/sh\necho unexpected-check > "$TRACE/npm"\nexit 99\n', { mode: 0o700 });
  writeFileSync(join(root, "bin/systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE/systemctl"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TRACE: root,
    PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root),
    PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox") };
  if (["base", "pushed"].includes(mainState)) {
    const watched = spawnSync(process.execPath, [fileURLToPath(new URL("../deploy/publication", import.meta.url)), "watchdog"], {
      encoding: "utf8", timeout: fixtureTimeoutMs, env,
    });
    assert.equal(watched.status, 0, watched.stderr);
    assert.equal(JSON.parse(readFileSync(receipt, "utf8")).status, "running", "old boot deadlines cannot race reboot recovery");
    assert.equal(existsSync(join(root, "repairs", requestId, "receipt.json")), false);
    assert.doesNotMatch(readFileSync(join(root, "systemctl"), "utf8"), /stop pi-stack-publication.service/);
  }
  const args = mainState === "moved" ? ["--input-type=module", "-e", `
    import { readFileSync } from "node:fs";
    import { processRequest } from ${JSON.stringify(new URL("../deploy/publication", import.meta.url).href)};
    processRequest(JSON.parse(readFileSync(${JSON.stringify(receipt)}, "utf8")));
  `] : [fileURLToPath(new URL("../deploy/publication", import.meta.url)), "drain"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: fixtureTimeoutMs, env });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const recovered = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(recovered.attempt, 1, "recovery keeps the existing publication attempt");
  if (["same-boot", "unrecorded-boot"].includes(mainState)) {
    assert.equal(recovered.status, "failed");
    assert.match(recovered.failure.message, /worker interrupted/);
    assert.equal(recovered.workerRestarts, undefined);
    assert.equal(existsSync(join(root, "hosts")), false);
    return;
  }
  assert.equal(recovered.status, "queued", JSON.stringify(recovered.failure));
  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.workerBootId, currentBootId);
  assert.deepEqual(recovered.workerRestarts, [{ at: recovered.workerRestarts[0].at, fromBootId: previousBootId,
    toBootId: currentBootId, attempt: 1, step: request.step, progress: request.progress }]);
  const commands = readFileSync(join(root, "git"), "utf8");
  assert.equal(existsSync(join(root, "npm")), false);
  if (mainState === "moved") {
    assert.equal(recovered.integrationSha, undefined);
    assert.equal(recovered.checks, undefined, "changed main invalidates the old checks");
    assert.equal(recovered.mainMovements[0].integrationSha, request.integrationSha);
    assert.doesNotMatch(commands, /push/);
    assert.equal(existsSync(join(root, "hosts")), false);
  } else {
    assert.equal(recovered.integrationSha, request.integrationSha);
    assert.deepEqual(recovered.checks, request.checks);
    assert.ok(recovered.integratedAt);
    assert.equal(commands.split("\\n").filter(line => line.includes("push")).length, mainState === "base" ? 1 : 0);
    assert.ok(recovered.hosts);
    for (const reservation of Object.values(recovered.reservations)) assert.equal(reservation.state, "released");
  }
});

for (const failedStep of ["merge-source", "checks"]) test(`failed ${failedStep} retains its command and diagnostics without publishing main`, t => {
  const root = mkdtempSync(join(tmpdir(), "publication-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["requests", "bin", "repository/.git", "repository/deploy", "canonical/apps/kenan/android"]) mkdirSync(join(root, path), { recursive: true });
  const source = "a".repeat(40), base = "b".repeat(40), integration = "c".repeat(40);
  const requestId = "PUB-0123456789abcdef01234567";
  const receipt = join(root, "requests", `${requestId}.json`);
  writeFileSync(receipt, JSON.stringify({ requestId, sourceSha: source, sourceRef: `refs/heads/pi-stack-publications/${requestId}`, status: "queued", step: "queued", attempt: 0, queuedAt: "2026-09-13", failures: [] }));
  writeFileSync(join(root, "repository/deploy/lib"), 'pi_stack_prepare_dependencies() { :; }\n');
  writeFileSync(join(root, "canonical/apps/kenan/android/local.properties"), "fixture=true\n");
  writeFileSync(join(root, "bin/git"), `#!/bin/sh
case "$*" in
  *push*) echo 'unexpected push' >&2; exit 99;;
  *'remote get-url origin'*) echo https://github.com/hara-seihun/pi-stack.git;;
  *'rev-parse refs/pi-stack-publication/'*) echo ${source};;
  *'rev-parse refs/remotes/origin/main'*) echo ${base};;
  *'rev-parse HEAD'*) echo ${integration};;
  *'merge-base --is-ancestor'*) test -f '${join(root, 'merged')}' && exit 0; exit 1;;
  *'merge --no-ff'*) ${failedStep === "merge-source" ? "echo 'CONFLICT (content): Merge conflict in README.md'; exit 1" : `touch '${join(root, 'merged')}'`};;
esac
`, { mode: 0o700 });
  writeFileSync(join(root, "bin/npm"), '#!/bin/sh\necho "(fail) integration fixture rejects wrong core" >&2\necho "Expected: 201" >&2\necho "Received: 409" >&2\nexit 1\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../deploy/publication", import.meta.url)), "drain"], {
    encoding: "utf8", timeout: fixtureTimeoutMs,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root), PI_STACK_PUBLICATION_REPOSITORY: join(root, "canonical"), PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox") },
  });
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.step, failedStep);
  assert.equal(failed.failure.message, `${failedStep} exited 1`);
  assert.match(readFileSync(join(root, "inbox/pi-stack-publication-issues.md"), "utf8"), new RegExp(`${failedStep} exited 1`));
  assert.equal(failed.hosts, undefined);
  assert.equal(failed.integratedAt, undefined);
  if (failedStep === "merge-source") {
    assert.equal(failed.integrationSha, undefined);
    assert.equal(failed.checks, undefined);
    assert.equal(failed.failure.progress.command, "git");
    assert.ok(failed.failure.progress.args.includes("merge"));
    assert.match(failed.failure.excerpt, /Merge conflict in README.md/);
    return;
  }
  assert.equal(failed.integrationSha, integration);
  assert.equal(failed.baseSha, base);
  assert.equal(failed.checks.status, "failed");
  assert.equal(failed.failure.step, "checks");
  assert.equal(failed.failure.progress.command, "bash");
  assert.deepEqual(failed.failure.progress.args, ["-c", 'set -euo pipefail\nsource deploy/lib\npi_stack_prepare_dependencies "$PWD"\nnpm run check']);
  assert.equal(failed.failure.progress.cwd, join(root, "repository"));
  assert.match(failed.failure.excerpt, /integration fixture rejects wrong core/);
  assert.match(failed.failure.excerpt, /Received: 409/);
  assert.match(readFileSync(failed.failure.log, "utf8"), /checks/);
});
