import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

// Each pass performs dozens of durable writes and subprocesses alongside other check jobs.
const fixtureTimeoutMs = 15_000;

test("divergent host ancestry stops only that host and retains its peer's matched release proof", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-ancestry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["requests", "bin", "repository/.git"]) mkdirSync(join(root, path), { recursive: true });
  const source = "a".repeat(40), base = "b".repeat(40), integration = "c".repeat(40), divergent = "d".repeat(40);
  const requestId = "PUB-0123456789abcdef01234567";
  const receipt = join(root, "requests", `${requestId}.json`);
  writeFileSync(receipt, JSON.stringify({ requestId, sourceSha: source, sourceRef: `refs/heads/pi-stack-publications/${requestId}`,
    baseSha: base, integrationSha: integration, checks: { status: "passed" },
    status: "queued", step: "queued", attempt: 0, queuedAt: "2026-09-13", failures: [] }));
  writeFileSync(join(root, "main"), base);
  writeFileSync(join(root, "bin/git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE/git"
case "$*" in
  *push*) echo ${integration} > "$TRACE/main";;
  *'remote get-url origin'*) echo https://github.com/hara-seihun/pi-stack.git;;
  *'rev-parse refs/remotes/origin/main'*) cat "$TRACE/main";;
  *':deploy/android-update'*) exit 1;;
  *grep*) exit 1;;
  *'merge-base --is-ancestor ${divergent}'*|*'merge-base --is-ancestor ${integration} ${divergent}'*) exit 1;;
esac
`, { mode: 0o700 });
  for (const [command, host, selected] of [["bash", "gmktec", integration], ["ssh", "converge", divergent]]) {
    writeFileSync(join(root, "bin", command), `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const script = readFileSync(0, "utf8");
appendFileSync(process.env.TRACE + "/${command}", process.argv.slice(2).join(" ") + "\\n");
appendFileSync(process.env.TRACE + "/host-scripts", script);
let proof;
if (script.includes("operation=$1") && script.includes("pi_stack_acquire_host_lock")) process.exit(0);
else if (script.includes("checkoutCommit:") && script.includes("runtimes:$runtimes"))
  proof = { host: "${host}", selectedCommit: "${selected}", checkoutCommit: "${selected}", runtimes: [], fleet: { activeRuns: [] } };
else if (script.includes("supervisors:$people") && script.includes("voiceCommit:"))
  proof = { host: "${host}", integrationSha: "${selected}", remoteCommit: "${selected}", orchestratorCommit: "${selected}", voiceCommit: "${selected}" };
else if (script.includes("root=/var/lib/pi-remote/app-updates/current"))
  proof = { revision: "${selected}", web: { revision: "${selected}" } };
else throw new Error("Unexpected host operation: " + process.argv.slice(2).join(" "));
console.log(JSON.stringify(proof));
`, { mode: 0o700 });
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../deploy/publication", import.meta.url)), "drain"], {
    encoding: "utf8", timeout: fixtureTimeoutMs,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TRACE: root,
      PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: publicationConfig(root), PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox") },
  });
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(failed.status, "failed");
  assert.match(readFileSync(join(root, "inbox/pi-stack-publication-issues.md"), "utf8"), /converge.*integration omits selected or checkout source/);
  assert.match(failed.failure.message, /converge.*integration omits selected or checkout source/);
  assert.equal(failed.integrationSha, integration);
  assert.equal(failed.checks.status, "passed");
  assert.equal(failed.hosts.gmktec.status, "passed");
  assert.equal(failed.hosts.gmktec.integrationSha, integration);
  assert.equal(failed.hosts.gmktec.android.web.revision, integration);
  assert.equal(failed.hosts.converge.status, "failed");
  assert.equal(failed.maintenance, undefined);
  assert.equal(failed.bootstrap, undefined);
  assert.ok(failed.integratedAt);
  const proof = JSON.parse(readFileSync(join(root, "proofs", requestId, "converge-release-ancestry.json"), "utf8"));
  assert.equal(proof.ok, false);
  assert.ok(proof.baselines.every(baseline => baseline.commit === divergent && !baseline.included));
  assert.match(readFileSync(join(root, "git"), "utf8"), /push/);
  assert.doesNotMatch(readFileSync(join(root, "host-scripts"), "utf8"), /systemctl (start|stop|restart|kill)|fleet_cli pause/);
  assert.deepEqual(Object.values(failed.reservations).map(host => host.state), ["released", "released"]);
  assert.doesNotMatch(readFileSync(join(root, "ssh"), "utf8"), /pi-stack-release /);
});

test("main movement returns before deployment and the next worker pass reruns checks", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-main-moved-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["bin", "repository/.git", "repository/deploy", "canonical/apps/kenan/android"]) mkdirSync(join(root, path), { recursive: true });
  const source = "a".repeat(40), base = "b".repeat(40), integration = "c".repeat(40), moved = "d".repeat(40);
  const requestId = "PUB-0123456789abcdef01234567";
  const receipt = join(root, "requests", `${requestId}.json`);
  const request = { requestId, sourceSha: source, sourceRef: "refs/heads/submission", baseSha: base,
    integrationSha: integration, checks: { status: "passed" }, status: "queued", attempt: 0, failures: [] };
  writeFileSync(join(root, "main"), base);
  writeFileSync(join(root, "repository/deploy/lib"), 'pi_stack_prepare_dependencies() { :; }\n');
  writeFileSync(join(root, "canonical/apps/kenan/android/local.properties"), "fixture=true\n");
  writeFileSync(join(root, "bin/git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE/git"
case "$*" in
  *push*) echo 'unexpected push' >&2; exit 99;;
  *'remote get-url origin'*) echo https://github.com/hara-seihun/pi-stack.git;;
  *'fetch --quiet --no-tags origin +refs/heads/main:'*)
    count=0
    if [ -e "$TRACE/fetch-count" ]; then count=$(cat "$TRACE/fetch-count"); fi
    count=$((count + 1))
    echo "$count" > "$TRACE/fetch-count"
    if [ "$count" -eq 2 ]; then echo ${moved} > "$TRACE/main"; fi;;
  *'rev-parse refs/remotes/origin/main'*) cat "$TRACE/main";;
  *'rev-parse refs/pi-stack-publication/'*) echo ${source};;
  *'rev-parse HEAD'*) echo ${integration};;
  *':deploy/android-update'*) exit 1;;
  *grep*) exit 1;;
esac
`, { mode: 0o700 });
  const hostStub = `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE/hosts"
echo 'unexpected host operation before integration' >&2
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
  assert.equal(queued.status, "queued");
  assert.equal(queued.checks, undefined);
  assert.equal(queued.mainMovements[0].integrationSha, integration);
  assert.deepEqual(queued.failures, []);
  assert.equal(queued.reservations, undefined);
  assert.doesNotMatch(readFileSync(join(root, "git"), "utf8"), /push/);
  assert.equal(existsSync(join(root, "hosts")), false, "main movement must requeue before any host operation");
  rmSync(join(root, "bin/bash"));
  writeFileSync(join(root, "bin/npm"), '#!/bin/sh\necho "fresh integration checks reached" >&2\nexit 1\n', { mode: 0o700 });
  const checked = processOne(queued);
  assert.equal(checked.attempt, 2);
  assert.equal(checked.baseSha, moved);
  assert.equal(checked.failure.step, "checks");
  assert.match(checked.failure.excerpt, /fresh integration checks reached/);
  assert.equal(checked.mainMovements.length, 1);
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
  *'merge-base --is-ancestor'*) exit 1;;
  *'merge --no-ff'*) ${failedStep === "merge-source" ? "echo 'CONFLICT (content): Merge conflict in README.md'; exit 1" : ":"};;
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
  assert.deepEqual(failed.failure.progress.args, ["-c", 'set -euo pipefail\nsource deploy/lib\npi_stack_prepare_dependencies "$PWD"\nnpm run check\nnpm run android:test --workspace=kenan']);
  assert.equal(failed.failure.progress.cwd, join(root, "repository"));
  assert.match(failed.failure.excerpt, /integration fixture rejects wrong core/);
  assert.match(failed.failure.excerpt, /Received: 409/);
  assert.match(readFileSync(failed.failure.log, "utf8"), /checks/);
});
