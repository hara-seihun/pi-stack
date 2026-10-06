import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkParallelism, runJob, runJobs } from "./run-jobs.mjs";
import { checkJobs } from "./test.mjs";
import { workspaceChecks } from "../tools/agent-workspace/check.mjs";

test("job output is visible before the process finishes", async () => {
  let complete = false;
  let sawLiveOutput = false;
  const result = await runJob(["stream", process.execPath, ["-e", "console.log('READY'); setTimeout(() => {}, 100)"]], text => {
    if (text.includes("READY")) sawLiveOutput = !complete;
  });
  complete = true;
  assert.equal(sawLiveOutput, true);
  assert.equal(result.code, 0);
});

test("an exited job with inherited descendant pipes fails instead of hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-job-pipe-"));
  const pidFile = join(root, "pid");
  try {
    const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{detached:true,stdio:['ignore','inherit','inherit']}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref();`;
    const result = await runJob(["leak", process.execPath, ["-e", code], { drainTimeoutMs: 25 }], () => {});
    assert.equal(result.code, 1);
    assert.match(result.error, /descendants still hold/);
    assert.ok(result.elapsedMs < 2_000);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pool bounds concurrency, shares its budget, and drains all jobs after a failure", async () => {
  let active = 0;
  let peak = 0;
  const output = [];
  const exitCode = process.exitCode;
  try {
    const jobs = Array.from({ length: 5 }, (_, index) => [
      `pool-${index}`, process.execPath,
      ["-e", `console.log('BUDGET=' + process.env.PI_STACK_CHECK_CONCURRENCY + ':' + process.env.MARKER); setTimeout(() => process.exit(${index === 0 ? 1 : 0}), 50)`],
      { env: { MARKER: "preserved" } },
    ]);
    const results = await runJobs(jobs, { concurrency: 2, write(text) {
      output.push(text);
      if (text.includes(": started =====")) peak = Math.max(peak, ++active);
      if (/: (passed|failed) \(/.test(text)) active--;
    } });
    assert.equal(peak, 2);
    assert.equal(active, 0);
    assert.deepEqual(results.map(result => result.name), jobs.map(job => job[0]));
    assert.deepEqual(results.map(result => result.code), [1, 0, 0, 0, 0]);
    assert.equal(output.join("").match(/BUDGET=1:preserved/g)?.length, 5);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = exitCode; }
});

test("the Node test driver expands file patterns and propagates failures without dropping later files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-node-tests-"));
  try {
    writeFileSync(join(root, "a.test.mjs"), "import test from 'node:test'; test('deliberate failure', () => { throw new Error('fixture failure'); });");
    writeFileSync(join(root, "b.test.mjs"), "import test from 'node:test'; test('later file', () => console.log('LATER_FILE_RAN'));");
    let output = "";
    const result = await runJob(["node driver", process.execPath, [fileURLToPath(new URL("./test-node.mjs", import.meta.url)), "*.test.mjs"], {
      cwd: root, env: { ...process.env, PI_STACK_CHECK_CONCURRENCY: "1" },
    }], text => { output += text; });
    assert.equal(result.code, 1, output);
    assert.match(output, /fixture failure/);
    assert.match(output, /LATER_FILE_RAN/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication schedules every workspace shard directly under the shared budget", async () => {
  const shards = checkJobs.filter(([name]) => name.startsWith("agent workspace "));
  assert.equal(shards.length, 6);
  assert.deepEqual(shards.map(job => job[3].env.AGENT_WORKSPACE_TEST_SHARD), ["0/6", "1/6", "2/6", "3/6", "4/6", "5/6"]);
  assert.deepEqual(shards.map(job => job[0]), workspaceChecks.map(job => job[0]));
  assert.equal(checkJobs.some(([, command, args]) => command === "npm" && args.includes("--workspace=@hara-seihun/agent-workspace")), false);
  let active = 0, peak = 0;
  const results = await runJobs(shards.map(([name, , , options]) => [name, process.execPath,
    ["-e", "if (process.env.PI_STACK_CHECK_CONCURRENCY !== '1' || !process.env.AGENT_WORKSPACE_TEST_SHARD) process.exit(1); setTimeout(() => {}, 20)"], options]), {
    concurrency: 2,
    write(text) {
      if (text.includes(": started =====")) peak = Math.max(peak, ++active);
      if (/: (passed|failed) \(/.test(text)) active--;
    },
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0, 0, 0]);
});

test("workspace shards execute a selected contract exactly once across the publication plan", async () => {
  const shards = checkJobs.filter(([name]) => name.startsWith("agent workspace "));
  let output = "";
  const results = await runJobs(shards.map(([name, command, args, options]) => [name, command,
    [args[0], "--test-name-pattern=cache discovery walks each directory once", ...args.slice(1)], options]), {
    concurrency: 2, write(text) { output += text; },
  });
  assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0, 0, 0], output);
  assert.equal((output.match(/✔ cache discovery walks each directory once/g) ?? []).length, 1, output);
});

test("check budgets reject invalid settings and permit an empty queue", async () => {
  assert.equal(checkParallelism({ PI_STACK_CHECK_CONCURRENCY: "2" }), 2);
  for (const value of ["0", "-1", "1.5", "garbage", ""]) {
    assert.throws(() => checkParallelism({ PI_STACK_CHECK_CONCURRENCY: value }), /positive integer/);
  }
  await assert.rejects(runJobs([], { concurrency: 0 }), /positive integer/);
  assert.deepEqual(await runJobs([], { concurrency: 1 }), []);
});

test("a running job has a bounded deadline", async () => {
  const result = await runJob(["stuck", process.execPath, ["-e", "setInterval(()=>{},60000)"], { timeoutMs: 50 }], () => {});
  assert.equal(result.code, 1);
  assert.match(result.error, /deadline/);
  assert.ok(result.elapsedMs < 2_000);
});
