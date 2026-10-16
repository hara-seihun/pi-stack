import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { finishSourceJob, readSourceJobRequest, runSourceJob, writeSourceJobProgress } from "./source-job.mjs";

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(mode = "running") {
  const root = mkdtempSync(path.join(tmpdir(), "source-job-test-"));
  roots.push(root);
  const context = path.join(root, "manager.json");
  writeFileSync(context, JSON.stringify({ mode, submissions: [], units: {} }));
  for (const executable of ["systemctl", "systemd-run"]) {
    const filename = path.join(root, executable);
    writeFileSync(filename, `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const context = process.env.FAKE_JOB_CONTEXT;
const state = JSON.parse(fs.readFileSync(context, 'utf8'));
const args = process.argv.slice(2);
if (process.argv[1].endsWith('/systemctl')) {
  if (state.mode === 'unsupported') { process.stderr.write('Failed to connect to user bus'); process.exit(1); }
  const unit = args[2];
  const active = state.units[unit];
  process.stdout.write('LoadState=' + (active ? 'loaded' : 'not-found') + '\nActiveState=' + (active || 'inactive') + '\nSubState=' + (active === 'active' ? 'running' : 'dead') + '\nResult=success\nExecMainStatus=0\n');
} else {
  state.submissions.push(args);
  const unit = args.find(value => value.startsWith('--unit=')).slice(7);
  state.units[unit] = 'active';
  fs.writeFileSync(context, JSON.stringify(state));
  if (state.mode === 'ready' || state.mode === 'no-result') {
    const command = args.slice(args.indexOf('--') + 1);
    cp.spawnSync(command[0], command.slice(1), { stdio: 'ignore' });
    state.units[unit] = 'inactive';
    fs.writeFileSync(context, JSON.stringify(state));
    // systemd-run acknowledges exec admission, not the worker's eventual exit status.
    process.exit(0);
  }
}
`}`);
    chmodSync(filename, 0o700);
  }
  const saved = { PATH: process.env.PATH, FAKE_JOB_CONTEXT: process.env.FAKE_JOB_CONTEXT };
  process.env.PATH = `${root}:${process.env.PATH}`;
  process.env.FAKE_JOB_CONTEXT = context;
  const options = {
    directory: path.join(root, "jobs"), key: "local-source", request: { source: "safe", stamp: "one" },
    command: [process.execPath, "-e", "process.exit(0)"], waitMs: 0,
  };
  return {
    root, options,
    state: () => JSON.parse(readFileSync(context, "utf8")),
    update: state => writeFileSync(context, JSON.stringify(state)),
    jobDirectory: () => path.join(options.directory, readdirSync(options.directory)[0]),
    restore: () => {
      process.env.PATH = saved.PATH;
      if (saved.FAKE_JOB_CONTEXT === undefined) delete process.env.FAKE_JOB_CONTEXT;
      else process.env.FAKE_JOB_CONTEXT = saved.FAKE_JOB_CONTEXT;
    },
  };
}

function readyCommand(value) {
  return [process.execPath, "--input-type=module", "-e", `
    import { finishSourceJob, readSourceJobRequest, writeSourceJobProgress } from ${JSON.stringify(new URL("./source-job.mjs", import.meta.url).href)};
    const directory = process.env.PI_WORKSPACE_SOURCE_JOB_DIR;
    const request = readSourceJobRequest(directory);
    if (!request.ok) process.exit(2);
    writeSourceJobProgress(directory, {phase:'fetched',source:request.value.source});
    const result = finishSourceJob(directory, {state:'ready',value:${JSON.stringify(value)}});
    if (!result.ok) process.exit(3);
  `];
}

test("submits once, returns bounded durable pending, and freezes auth environment privately", () => {
  const f = fixture();
  try {
    f.options.env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "sensitive-token" };
    const started = Date.now();
    const first = runSourceJob(f.options);
    assert.equal(first.state, "pending");
    assert.equal(first.phase, "running");
    assert.ok(Date.now() - started < 2000);
    const repeated = runSourceJob(f.options);
    assert.equal(repeated.jobId, first.jobId);
    assert.equal(f.state().submissions.length, 1);
    assert.ok(!JSON.stringify(f.state().submissions).includes("sensitive-token"));
    const directory = f.jobDirectory();
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(directory, "environment.json")).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "environment.json"))).GIT_CONFIG_VALUE_0, "sensitive-token");
    assert.deepEqual(readSourceJobRequest(directory), { ok: true, value: f.options.request });
    assert.equal(JSON.parse(readFileSync(first.progressPath)).state, "starting");
  } finally { f.restore(); }
});

test("worker produces explicit ready result; creator restart reuses it, source stamp mutation does not", () => {
  const f = fixture("ready");
  try {
    f.options.command = readyCommand({ commit: "one" });
    assert.deepEqual(runSourceJob(f.options), { state: "ready", value: { commit: "one" } });
    const state = f.state();
    state.mode = "unsupported";
    f.update(state);
    assert.deepEqual(runSourceJob(f.options), { state: "ready", value: { commit: "one" } });
    state.mode = "running";
    f.update(state);
    const changed = runSourceJob({ ...f.options, request: { stamp: "two", source: "safe" } });
    assert.equal(changed.state, "pending");
    assert.equal(f.state().submissions.length, 2);
    assert.equal(readdirSync(f.options.directory).length, 2);
  } finally { f.restore(); }
});

test("positive stopped unit without result is interrupted, never ready; explicit restart reuses job identity", () => {
  const f = fixture();
  try {
    const first = runSourceJob(f.options);
    const state = f.state();
    for (const unit of Object.keys(state.units)) state.units[unit] = "inactive";
    f.update(state);
    const interrupted = runSourceJob(f.options);
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.error.code, "source-job-interrupted");
    assert.equal(f.state().submissions.length, 1);
    const resumed = runSourceJob({ ...f.options, restartInterrupted: true });
    assert.equal(resumed.state, "pending");
    assert.equal(resumed.jobId, first.jobId);
    assert.equal(f.state().submissions.length, 2);
    assert.notEqual(f.state().submissions[0].find(arg => arg.startsWith("--unit=")), f.state().submissions[1].find(arg => arg.startsWith("--unit=")));
  } finally { f.restore(); }
});

test("worker exit without a terminal result is failed even when exit code is zero", () => {
  const f = fixture("no-result");
  try {
    const result = runSourceJob(f.options);
    assert.equal(result.state, "failed");
    assert.equal(result.error.code, "source-job-worker-no-result");
    assert.deepEqual(runSourceJob(f.options), result);
    assert.equal(f.state().submissions.length, 1);
  } finally { f.restore(); }
});

for (const signal of ["SIGKILL", "SIGTERM"]) test(`worker ${signal} is interrupted and resumes under the same identity`, () => {
  const f = fixture("ready");
  try {
    f.options.command = readyCommand({ resumed: true });
    f.options.command[3] = `
      import { existsSync, writeFileSync } from 'node:fs';
      const marker = process.env.PI_WORKSPACE_SOURCE_JOB_DIR + '/interrupted-once';
      if (!existsSync(marker)) {
        writeFileSync(marker, 'interrupted');
        process.kill(process.pid, ${JSON.stringify(signal)});
      }
    ` + f.options.command[3];
    const first = runSourceJob(f.options);
    assert.equal(first.state, "interrupted");
    assert.equal(first.error.code, "source-job-interrupted");
    const directory = f.jobDirectory();
    assert.equal(existsSync(path.join(directory, "result.json")), false);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "attempt.json"))).number, 1);
    const repeated = runSourceJob(f.options);
    assert.equal(repeated.state, "interrupted");
    assert.equal(repeated.jobId, first.jobId);
    assert.equal(f.state().submissions.length, 1);
    assert.deepEqual(runSourceJob({ ...f.options, restartInterrupted: true }), { state: "ready", value: { resumed: true } });
    assert.equal(path.basename(directory), first.jobId);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "attempt.json"))).number, 2);
    assert.equal(f.state().submissions.length, 2);
  } finally { f.restore(); }
});

test("ordinary nonzero worker exit without result stays terminal on explicit restart", () => {
  const f = fixture("no-result");
  try {
    f.options.command = [process.execPath, "-e", "process.exit(17)"];
    const result = runSourceJob(f.options);
    assert.equal(result.state, "failed");
    assert.equal(result.error.code, "source-job-worker-no-result");
    assert.match(result.error.message, /exit 17, signal null/);
    assert.deepEqual(runSourceJob({ ...f.options, restartInterrupted: true }), result);
    assert.equal(f.state().submissions.length, 1);
  } finally { f.restore(); }
});

test("published ready result wins over a subsequent worker signal", () => {
  const f = fixture("ready");
  try {
    f.options.command = readyCommand({ published: true });
    f.options.command[3] += "process.kill(process.pid, 'SIGKILL');";
    assert.deepEqual(runSourceJob(f.options), { state: "ready", value: { published: true } });
    assert.equal(f.state().submissions.length, 1);
  } finally { f.restore(); }
});

test("missing user manager has typed unsupported result and no detached worker", () => {
  const f = fixture("unsupported");
  try {
    // Model the actual launcher refusing the unavailable bus, not a fake launch acceptance.
    const state = f.state();
    state.units = {};
    f.update(state);
    runSourceJob(f.options);
    const result = runSourceJob(f.options);
    assert.equal(result.state, "failed");
    assert.equal(result.error.code, "source-job-unsupported");
    assert.equal(f.state().submissions.length, 1);
  } finally { f.restore(); }
});

test("terminal results are immutable, progress is atomic, and corrupt results never become success", () => {
  const f = fixture();
  try {
    const first = runSourceJob(f.options);
    const directory = f.jobDirectory();
    assert.deepEqual(writeSourceJobProgress(directory, { bytes: 8192 }), { ok: true });
    assert.equal(JSON.parse(readFileSync(first.progressPath)).value.bytes, 8192);
    assert.deepEqual(finishSourceJob(directory, { state: "failed", error: { code: "fetch-failed", message: "fetch refused" } }), { ok: true });
    assert.deepEqual(finishSourceJob(directory, { state: "failed", error: { code: "fetch-failed", message: "fetch refused" } }), { ok: true });
    assert.equal(finishSourceJob(directory, { state: "ready", value: "guessed" }).error.code, "source-job-result-conflict");
    assert.equal(runSourceJob(f.options).error.code, "fetch-failed");
    writeFileSync(path.join(directory, "result.json"), JSON.stringify({ state: "ready" }));
    assert.equal(runSourceJob(f.options).state, "failed");
    assert.equal(f.state().submissions.length, 1);
  } finally { f.restore(); }
});

test("OS-backed launch fence prevents duplicate concurrent submissions and releases on close", () => {
  const f = fixture();
  let lock;
  try {
    const first = runSourceJob(f.options);
    lock = new DatabaseSync(path.join(f.jobDirectory(), "lock.sqlite3"));
    lock.exec("BEGIN IMMEDIATE");
    const concurrent = runSourceJob(f.options);
    assert.equal(concurrent.state, "pending");
    assert.equal(concurrent.phase, "submitting");
    assert.equal(concurrent.jobId, first.jobId);
    assert.equal(f.state().submissions.length, 1);
    lock.close();
    lock = undefined;
    assert.equal(runSourceJob(f.options).phase, "running");
  } finally { if (lock) lock.close(); f.restore(); }
});

test("finite real systemd resource worker survives its creator exiting and publishes ready", async t => {
  const manager = spawnSync("systemctl", ["--user", "show", "basic.target", "--property=ActiveState", "--value"], { encoding: "utf8", timeout: 2000 });
  if (manager.status !== 0 || manager.stdout.trim() !== "active") return t.skip("no systemd user manager on this test host");
  const directory = mkdtempSync(path.join(tmpdir(), "source-job-real-"));
  roots.push(directory);
  const moduleUrl = new URL("./source-job.mjs", import.meta.url).href;
  const options = {
    directory, key: "finite-resource-proof", request: { purpose: "source preparation lifecycle proof" }, waitMs: 0,
    env: { SOURCE_JOB_PRIVATE_PROOF: "retained-private-value" },
    command: [process.execPath, "--input-type=module", "-e", `
      import { finishSourceJob } from ${JSON.stringify(moduleUrl)};
      setTimeout(() => {
        const done = finishSourceJob(process.env.PI_WORKSPACE_SOURCE_JOB_DIR, {
          state:'ready', value:{environmentPreserved:process.env.SOURCE_JOB_PRIVATE_PROOF === 'retained-private-value'}
        });
        if (!done.ok) process.exit(2);
      }, 350);
    `],
  };
  const launcher = spawnSync(process.execPath, ["--input-type=module"], {
    input: `import {runSourceJob} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(runSourceJob(${JSON.stringify(options)})));`,
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(launcher.status, 0, launcher.stderr);
  const first = JSON.parse(launcher.stdout);
  assert.equal(first.state, "pending", JSON.stringify(first));
  assert.equal(first.phase, "running");
  // The creator is already gone; only the finite resource unit can publish this result.
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(runSourceJob(options), { state: "ready", value: { environmentPreserved: true } });
});

test("worker command change on same identity is rejected; JSON key order has no effect", () => {
  const f = fixture();
  try {
    const first = runSourceJob(f.options);
    assert.equal(runSourceJob({ ...f.options, request: { stamp: "one", source: "safe" } }).jobId, first.jobId);
    assert.equal(runSourceJob({ ...f.options, command: [process.execPath, "-e", "process.exit(1)"] }).error.code, "source-job-command-conflict");
    assert.equal(runSourceJob({ ...f.options, waitMs: 55000 }).error.code, "source-job-invalid-request");
  } finally { f.restore(); }
});

test("user-manager discovery fills absent connection variables without changing caller configuration", async () => {
  const { userManagerEnvironment } = await import("./source-job.mjs");
  const input = { PATH: process.env.PATH, HOME: process.env.HOME };
  const resolved = userManagerEnvironment(input);
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.value.XDG_RUNTIME_DIR, `/run/user/${process.geteuid()}`);
  assert.equal(resolved.value.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${process.geteuid()}/bus`);
  assert.deepEqual(Object.keys(input).sort(), ["HOME", "PATH"]);
  assert.deepEqual(userManagerEnvironment(resolved.value), resolved);
  for (const override of [{ XDG_RUNTIME_DIR: "" }, { XDG_RUNTIME_DIR: "/tmp" },
    { XDG_RUNTIME_DIR: "/no-such-user-runtime-546" }, { DBUS_SESSION_BUS_ADDRESS: "" }]) {
    const invalid = userManagerEnvironment({ ...input, ...override });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "source-job-user-environment");
  }
});
