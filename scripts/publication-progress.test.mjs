import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { policy, repairPrompt, runnable, stallReason } from "../deploy/publication-control.mjs";

const publication = fileURLToPath(new URL("../deploy/publication", import.meta.url));
const requestId = "PUB-0123456789abcdef01234567";

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o700 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function runPublication(root, bin, operation, extraEnvironment = {}) {
  const args = [publication, operation, ...(operation === "watchdog" ? [] : [requestId])];
  return run(process.execPath, args, {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PI_STACK_PUBLICATION_STATE: root,
      PI_STACK_PUBLICATION_ALERT_COMMAND: join(bin, "alert"),
      PI_STACK_PUBLICATION_COMMAND: join(bin, "publication-submit"),
      ...extraEnvironment,
    },
  });
}

function makeCommandStubs(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  executable(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "$1" = "--user" ] && [ "$2" = "show" ]; then
  printf '%s\\n' "\${SYSTEMCTL_ACTIVE_STATE:-inactive}"
fi
`);
  executable(join(bin, "alert"), "#!/bin/sh\nprintf '%s\\n' /fixture/alert.md\n");
  executable(join(bin, "agent-workspace"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AGENT_WORKSPACE_LOG"
if [ "$1" = "create" ]; then
  printf '{"path":"%s"}\\n' "$STUB_WORKSPACE"
fi
`);
  executable(join(bin, "pi"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PI_STUB_LOG"
printf '%s\\n' "$PI_STUB_OUTCOME" > "$PI_STUB_RESULT"
`);
  executable(join(bin, "publication-submit"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PUBLICATION_SUBMIT_LOG"
printf '{"requestId":"PUB-fedcba9876543210fedcba98","sourceSha":"%s","status":"queued","receipt":"/fixture/successor.json"}\\n' "$2"
`);
  return bin;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function initializeRepository(path) {
  mkdirSync(path);
  assert.equal(run("git", ["init", "--quiet"], { cwd: path }).status, 0);
  assert.equal(run("git", ["config", "user.name", "Publication test"], { cwd: path }).status, 0);
  assert.equal(run("git", ["config", "user.email", "publication-test@example.invalid"], { cwd: path }).status, 0);
  writeFileSync(join(path, "source.txt"), "original\n");
  assert.equal(run("git", ["add", "source.txt"], { cwd: path }).status, 0);
  assert.equal(run("git", ["commit", "--quiet", "-m", "original"], { cwd: path }).status, 0);
  const sourceSha = run("git", ["rev-parse", "HEAD"], { cwd: path }).stdout.trim();
  writeFileSync(join(path, "source.txt"), "repaired\n");
  assert.equal(run("git", ["commit", "--quiet", "-am", "repair"], { cwd: path }).status, 0);
  const repairedSha = run("git", ["rev-parse", "HEAD"], { cwd: path }).stdout.trim();
  return { sourceSha, repairedSha };
}

function repairFixture(t, status = "launching") {
  const root = mkdtempSync(join(tmpdir(), "publication-progress-"));
  const requests = join(root, "requests");
  const repairDirectory = join(root, "repairs", requestId);
  const workspace = join(root, "workspace");
  mkdirSync(requests, { recursive: true });
  mkdirSync(repairDirectory, { recursive: true });
  const { sourceSha, repairedSha } = initializeRepository(workspace);
  assert.equal(run("git", ["clone", "--quiet", workspace, join(root, "repository")]).status, 0);
  const publicationLog = join(root, "publication.log");
  writeFileSync(publicationLog, "dependency resolution failed: package fixture is missing\n");
  const requestPath = join(requests, `${requestId}.json`);
  const failure = {
    at: "2026-04-15T12:00:00.000Z",
    step: "checks",
    message: "integration checks exited 17",
    log: publicationLog,
    command: "npm run check",
    progress: {
      step: "checks",
      command: "npm",
      args: ["run", "check"],
      cwd: "/fixture/source",
      startedAt: "2026-04-15T11:59:00.000Z",
      deadlineAt: "2026-04-15T12:00:00.000Z",
      log: publicationLog,
    },
    excerpt: "ERR fixture dependency unavailable",
  };
  const request = {
    version: 2,
    requestId,
    sourceSha,
    integrationSha: "b".repeat(40),
    status: "failed",
    step: "checks",
    attempt: 1,
    failures: [failure],
    failure,
  };
  writeJson(requestPath, request);
  const repairPath = join(repairDirectory, "receipt.json");
  const repair = {
    id: `REPAIR-${requestId}`,
    requestId,
    sourceSha,
    integrationSha: request.integrationSha,
    failure,
    status,
    createdAt: "2026-04-15T12:00:01.000Z",
    path: repairPath,
    requestPath,
    session: join(repairDirectory, "session.jsonl"),
    log: join(repairDirectory, "agent.log"),
    result: join(repairDirectory, "result.json"),
    prompt: join(repairDirectory, "prompt.md"),
    unit: `pi-stack-publication-repair@${requestId}.service`,
    launchAttempts: 1,
  };
  writeJson(repairPath, repair);
  const bin = makeCommandStubs(root);
  const environment = {
    SYSTEMCTL_LOG: join(root, "systemctl.log"),
    AGENT_WORKSPACE_LOG: join(root, "agent-workspace.log"),
    STUB_WORKSPACE: workspace,
    PI_STACK_PUBLICATION_PI: join(bin, "pi"),
    PI_STUB_LOG: join(root, "pi.log"),
    PI_STUB_RESULT: repair.result,
    PUBLICATION_SUBMIT_LOG: join(root, "publication-submit.log"),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bin, workspace, request, requestPath, repair, repairPath, repairedSha, environment };
}

test("stall policy puts a finite bound on commands, idle logs, and time between steps", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-stall-policy-"));
  const log = join(root, "worker.log");
  writeFileSync(log, "last output\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.parse("2030-01-01T00:10:00.000Z");

  const betweenSteps = { status: "running", updatedAt: new Date(now - policy.betweenStepsMs).toISOString() };
  assert.equal(stallReason(betweenSteps, now), null);
  assert.equal(stallReason(betweenSteps, now + 1), "Worker stopped recording progress");

  const deadline = new Date(now - policy.commandGraceMs).toISOString();
  const command = {
    status: "running",
    updatedAt: new Date(now).toISOString(),
    progress: { startedAt: new Date(now - 1_000).toISOString(), deadlineAt: deadline },
  };
  assert.equal(stallReason(command, now), null);
  assert.equal(stallReason(command, now + 1), `Command exceeded deadline ${deadline}`);

  const lastOutput = now - policy.idleMs;
  utimesSync(log, new Date(lastOutput), new Date(lastOutput));
  const idle = {
    status: "finalizing",
    updatedAt: new Date(now).toISOString(),
    progress: {
      startedAt: new Date(lastOutput - 1_000).toISOString(),
      deadlineAt: new Date(now + 60_000).toISOString(),
      log,
    },
  };
  assert.equal(stallReason(idle, now - 1_000), null);
  assert.equal(stallReason(idle, now + 1_000), `No command or log progress for ${policy.idleMs / 1000}s`);

  assert.equal(runnable({ status: "queued" }, now), true);
  assert.equal(runnable({ status: "blocked", nextAttemptAt: new Date(now).toISOString() }, now), true);
  assert.equal(runnable({ status: "blocked", nextAttemptAt: new Date(now + 1).toISOString() }, now), false);
  assert.equal(runnable({ status: "failed" }, now), false);
  assert.equal(stallReason({ ...command, status: "failed" }, now + policy.commandGraceMs + 1), null);
});

test("repairPrompt carries the failed command and compact failure context", () => {
  const request = {
    requestId,
    sourceSha: "a".repeat(40),
    integrationSha: "b".repeat(40),
    step: "checks",
    failure: {
      step: "checks",
      message: "integration checks exited 17",
      log: "/state/attempt-1.log",
      excerpt: "ERR fixture dependency unavailable",
      progress: { command: "npm", args: ["run", "check"], cwd: "/checkout" },
    },
  };
  const repair = {
    requestPath: "/state/requests/request.json",
    path: "/state/repairs/request/receipt.json",
    session: "/state/repairs/request/session.jsonl",
    workspace: "/work/repair",
    result: "/state/repairs/request/result.json",
  };
  const prompt = repairPrompt(request, repair, "/machine/publication");
  assert.match(prompt, /integration checks exited 17/);
  assert.match(prompt, /"command":"npm","args":\["run","check"\]/);
  assert.match(prompt, /Full publication log: \/state\/attempt-1\.log/);
  assert.match(prompt, /ERR fixture dependency unavailable/);
  assert.match(prompt, /Write \/state\/repairs\/request\/result\.json/);
  assert.match(prompt, /"status":"source-fixed"/);
  assert.match(prompt, /"status":"infrastructure-fixed"/);
  assert.match(prompt, /"status":"blocked"/);
});

test("watchdog stops a bounded stall and launches one independent repair", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-watchdog-"));
  const requests = join(root, "requests");
  const logs = join(root, "logs", requestId);
  mkdirSync(requests, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const bin = makeCommandStubs(root);
  const log = join(logs, "attempt-1.log");
  writeFileSync(log, "original failing command output\n");
  const requestPath = join(requests, `${requestId}.json`);
  writeJson(requestPath, {
    version: 2,
    requestId,
    sourceSha: "a".repeat(40),
    status: "running",
    step: "checks",
    queuedAt: "2026-04-15T11:00:00.000Z",
    updatedAt: "2026-04-15T11:01:00.000Z",
    attempt: 1,
    failures: [{ at: "2026-04-15T11:00:30.000Z", message: "earlier failure remains useful" }],
    progress: {
      step: "checks",
      command: "npm",
      args: ["run", "check"],
      startedAt: "2026-04-15T11:00:00.000Z",
      deadlineAt: "2026-04-15T11:01:00.000Z",
      log,
    },
  });
  writeJson(join(root, "repair-policy.json"), { activatedAt: "2026-01-01T00:00:00.000Z", policy });
  const environment = {
    SYSTEMCTL_LOG: join(root, "systemctl.log"),
    SYSTEMCTL_ACTIVE_STATE: "active",
    AGENT_WORKSPACE_LOG: join(root, "agent-workspace.log"),
    STUB_WORKSPACE: join(root, "unused-workspace"),
    PI_STUB_LOG: join(root, "pi.log"),
    PI_STUB_RESULT: join(root, "unused-result.json"),
    PI_STUB_OUTCOME: JSON.stringify({ status: "blocked", summary: "unused" }),
    PUBLICATION_SUBMIT_LOG: join(root, "publication-submit.log"),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let result = runPublication(root, bin, "watchdog", environment);
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(readFileSync(requestPath, "utf8"));
  assert.equal(failed.status, "failed");
  assert.match(failed.failure.message, /Command exceeded deadline/);
  assert.deepEqual(failed.failures.map(failure => failure.message), [
    "earlier failure remains useful",
    failed.failure.message,
  ]);
  assert.match(failed.failure.excerpt, /original failing command output/);
  const repairPath = join(root, "repairs", requestId, "receipt.json");
  const repair = JSON.parse(readFileSync(repairPath, "utf8"));
  assert.equal(repair.status, "launching");
  assert.equal(repair.launchAttempts, 1);
  assert.equal(repair.failure.message, failed.failure.message);

  result = runPublication(root, bin, "watchdog", environment);
  assert.equal(result.status, 0, result.stderr);
  const systemctl = readFileSync(environment.SYSTEMCTL_LOG, "utf8").split("\n");
  assert.equal(systemctl.filter(line => line === "--user stop pi-stack-publication.service").length, 1);
  assert.equal(systemctl.filter(line => line === `--user start --no-block ${repair.unit}`).length, 1);
});

test("repair-run launches the registered local Pi process once and accepts each terminal result", async t => {
  const cases = [
    { status: "blocked", summary: "upstream credentials are required", expected: "blocked" },
    { status: "infrastructure-fixed", summary: "repaired the host package index", expected: "ready-to-retry", evidence: true },
    { status: "source-fixed", summary: "corrected dependency selection", expected: "submitted", evidence: true, source: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.status, child => {
      const fixture = repairFixture(child);
      const evidence = join(fixture.root, "focused-proof.json");
      if (scenario.evidence) writeJson(evidence, { check: "focused", passed: true });
      const outcome = {
        status: scenario.status,
        summary: scenario.summary,
        ...(scenario.evidence ? { evidence } : {}),
        ...(scenario.source ? { sourceSha: fixture.repairedSha } : {}),
      };
      const environment = { ...fixture.environment, PI_STUB_OUTCOME: JSON.stringify(outcome) };

      let result = runPublication(fixture.root, fixture.bin, "repair-run", environment);
      assert.equal(result.status, 0, result.stderr);
      const repair = JSON.parse(readFileSync(fixture.repairPath, "utf8"));
      assert.equal(repair.status, scenario.expected, repair.summary);
      assert.equal(repair.outcome.status, outcome.status);
      assert.equal(repair.outcome.summary, outcome.summary);
      if (scenario.evidence) {
        assert.equal(repair.outcome.evidenceSource, evidence);
        assert.match(repair.outcome.evidenceSha256, /^[a-f0-9]{64}$/);
        assert.equal(readFileSync(repair.outcome.evidence, "utf8"), readFileSync(evidence, "utf8"));
        assert.notEqual(repair.outcome.evidence, evidence);
      }
      assert.ok(repair.finishedAt);
      const piCalls = readFileSync(environment.PI_STUB_LOG, "utf8").trim().split("\n");
      assert.equal(piCalls.length, 1);
      assert.match(piCalls[0], new RegExp(`--session ${fixture.repair.session.replaceAll("/", "\\/")}`));
      assert.match(piCalls[0], new RegExp(`@${fixture.repair.prompt.replaceAll("/", "\\/")}`));
      const workspaceCalls = readFileSync(environment.AGENT_WORKSPACE_LOG, "utf8");
      assert.match(workspaceCalls, new RegExp(`create .*--repo ${join(fixture.root, "repository").replaceAll("/", "\\/")} .*--owner REPAIR-${requestId}`));
      const prompt = readFileSync(fixture.repair.prompt, "utf8");
      assert.match(prompt, /integration checks exited 17/);
      assert.match(prompt, /ERR fixture dependency unavailable/);
      assert.match(prompt, /"command":"npm","args":\["run","check"\]/);
      if (scenario.source) {
        assert.match(readFileSync(environment.PUBLICATION_SUBMIT_LOG, "utf8"), new RegExp(`submit ${fixture.repairedSha} --repair-of ${requestId}`));
        assert.match(workspaceCalls, new RegExp(`release --path ${fixture.workspace.replaceAll("/", "\\/")}`));
      }

      result = runPublication(fixture.root, fixture.bin, "repair-run", environment);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(environment.PI_STUB_LOG, "utf8").trim().split("\n").length, 1);
      writeJson(fixture.repairPath, { ...repair, status: "launching" });
      result = runPublication(fixture.root, fixture.bin, "repair-run", environment);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(environment.PI_STUB_LOG, "utf8").trim().split("\n").length, 1, "an ambiguous launch reply cannot replay the durable agent attempt");
    });
  }
});

test("watchdog blocks an interrupted repair without launching a second model", t => {
  const fixture = repairFixture(t, "running");
  const environment = {
    ...fixture.environment,
    SYSTEMCTL_ACTIVE_STATE: "inactive",
    PI_STUB_OUTCOME: JSON.stringify({ status: "blocked", summary: "must not run" }),
  };
  const result = runPublication(fixture.root, fixture.bin, "watchdog", environment);
  assert.equal(result.status, 0, result.stderr);
  const repair = JSON.parse(readFileSync(fixture.repairPath, "utf8"));
  assert.equal(repair.status, "blocked");
  assert.match(repair.summary, /interrupted without a terminal receipt/);
  assert.equal(repair.failure.message, fixture.request.failure.message);
  assert.equal(existsSync(environment.PI_STUB_LOG), false);

  const rerun = runPublication(fixture.root, fixture.bin, "repair-run", environment);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(existsSync(environment.PI_STUB_LOG), false);
});

test("activation leaves historical failures assigned to their existing agents", t => {
  const fixture = repairFixture(t);
  rmSync(join(fixture.root, "repairs"), { recursive: true });
  writeJson(join(fixture.root, "repair-policy.json"), { activatedAt: new Date().toISOString() });
  const result = runPublication(fixture.root, fixture.bin, "watchdog", fixture.environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.repairPath), false);
  assert.equal(existsSync(fixture.environment.PI_STUB_LOG), false);
  assert.equal(JSON.parse(readFileSync(fixture.requestPath, "utf8")).status, "failed");
});

test("an unclaimed queue gets a repair owner after its progress budget", t => {
  const fixture = repairFixture(t);
  rmSync(join(fixture.root, "repairs"), { recursive: true });
  writeJson(fixture.requestPath, { ...fixture.request, status: "queued", step: "queued", updatedAt: new Date().toISOString() });
  writeJson(join(fixture.root, "worker-watch.json"), { since: "2026-01-01T00:00:00.000Z" });
  const result = runPublication(fixture.root, fixture.bin, "watchdog", fixture.environment);
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(readFileSync(fixture.requestPath, "utf8"));
  assert.equal(failed.status, "failed");
  assert.match(failed.failure.message, /worker never claimed/);
  assert.equal(JSON.parse(readFileSync(fixture.repairPath, "utf8")).status, "launching");
});
