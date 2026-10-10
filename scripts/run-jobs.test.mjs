import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkParallelism, runJob, runJobs } from "./run-jobs.mjs";
import { checkJobs } from "./test.mjs";
import { workspaceChecks } from "../tools/agent-workspace/check.mjs";
import { orchestratorTestChecks } from "../packages/orchestrator/scripts/check.mjs";

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

test("an exited job drains output from a descendant finishing its shutdown", async () => {
  let output = "";
  const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"setTimeout(() => console.log('DRAINED'), 400)"],{stdio:['ignore','inherit','inherit']}); child.unref();`;
  const result = await runJob(["shutdown", process.execPath, ["-e", code]], text => { output += text; });
  assert.equal(result.code, 0, output);
  assert.match(output, /DRAINED/);
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

test("publication partitions deployment checks without dropping or repeating contracts", async () => {
  const jobs = checkJobs.filter(([name]) => name === "deploy lock" || name.startsWith("deploy host guest "));
  assert.equal(jobs.length, 3);
  const root = mkdtempSync(join(tmpdir(), "pi-deploy-check-plan-"));
  try {
    const files = [...new Set(jobs.flatMap(([, , args]) => args.filter(arg => arg.endsWith(".test.mjs"))))];
    const names = files.flatMap(file => file === "scripts/deploy-lock.test.mjs" ? [
      "one host deployment installs its shared dependency tree once",
      ...["disabled", "enabled"].map(guest => `host deployment activates Pi Remote and reconciles daemons with guest ${guest}`),
    ] : [file]);
    for (const file of files) {
      const contracts = file === "scripts/deploy-lock.test.mjs" ? names.slice(0, 3) : [file];
      writeFileSync(join(root, file.split("/").at(-1)), `import test from 'node:test';\n${contracts.map(name =>
        `test(${JSON.stringify(name)}, () => console.log(${JSON.stringify(`CONTRACT:${name}`)}));`).join("\n")}\n`);
    }
    let output = "";
    const results = await runJobs(jobs.map(([name, command, args, options]) => [name, command,
      args.map(arg => arg.endsWith(".test.mjs") ? join(root, arg.split("/").at(-1)) : arg), options]), {
      concurrency: 2, write(text) { output += text; },
    });
    assert.deepEqual(results.map(result => result.code), [0, 0, 0], output);
    const executed = [...output.matchAll(/CONTRACT:([^\n\r]+)/g)].map(match => match[1]);
    assert.deepEqual(executed.sort(), names.sort(), output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication fixture files run exactly once as separately bounded jobs", async () => {
  const suites = checkJobs.filter(([name]) => name.startsWith("publication "));
  const expected = ["config", "transport", "roots", "", "gate", "bundle", "source", "progress", "proof", "continuation", "timings", "hosts", "host-lanes"]
    .map(suite => `scripts/publication${suite ? `-${suite}` : ""}.test.mjs`);
  assert.deepEqual(suites.flatMap(([, , args]) => args.filter(arg => arg.endsWith(".test.mjs"))), expected);
  assert.ok(suites.every(job => job[3].timeoutMs === 55_000));
  const root = mkdtempSync(join(tmpdir(), "pi-publication-check-plan-"));
  try {
    for (const file of expected) writeFileSync(join(root, file.split("/").at(-1)),
      `import test from 'node:test'; test('fixture live-telephone', () => console.log(${JSON.stringify(`CONTRACT:${file}`)}));`);
    let output = "";
    const results = await runJobs(suites.map(([name, command, args, options]) => [name, command,
      args.map(arg => arg.endsWith(".test.mjs") ? join(root, arg.split("/").at(-1)) : arg), options]), {
      concurrency: 2, write(text) { output += text; },
    });
    assert.deepEqual(results.map(result => result.code), suites.map(() => 0), output);
    assert.deepEqual([...output.matchAll(/CONTRACT:([^\n\r]+)/g)].map(match => match[1]).sort(), expected.sort(), output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workspace checks have their own shared budget, not an application release veto", async () => {
  const shards = workspaceChecks.filter(([name]) => /^agent workspace \d+\/\d+$/.test(name));
  assert.ok(shards.length > 0);
  assert.equal(checkJobs.some(([name]) => name.startsWith('agent workspace ')), false);
  assert.equal(workspaceChecks.filter(([name]) => name === "agent workspace component deployment").length, 1);
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
  assert.deepEqual(results.map(result => result.code), shards.map(() => 0));
});

test("workspace shards execute a selected contract exactly once across the tool plan", async () => {
  const shards = workspaceChecks.filter(([name]) => /^agent workspace \d+\/\d+$/.test(name));
  let output = "";
  const results = await runJobs(shards.map(([name, command, args, options]) => [name, command,
    [fileURLToPath(new URL('./test-node.mjs', import.meta.url)), "--test-name-pattern=cache discovery walks each directory once", ...args.slice(1)], options]), {
    concurrency: 2, write(text) { output += text; },
  });
  assert.deepEqual(results.map(result => result.code), shards.map(() => 0), output);
  assert.equal((output.match(/✔ cache discovery walks each directory once/g) ?? []).length, 1, output);
});

test("publication gives each Orchestrator contract its own verdict and retains shared typed prerequisites", () => {
  const suites = checkJobs.filter(([name]) => name.startsWith('orchestrator test: '));
  assert.ok(suites.length > 100);
  assert.equal(new Set(suites.map(job => job[2].at(-1))).size, suites.length);
  for (const [, command, args, options] of suites) {
    assert.equal(command, process.execPath);
    assert.equal(args[1], 'run');
    assert.ok(!args.some(arg => arg.startsWith('--shard=')));
    assert.deepEqual(options.dependsOn, ['orchestrator shared RPC', 'orchestrator tool schemas']);
    assert.ok(options.checkInputs.includes(`packages/orchestrator/${args.at(-1)}`));
  }
  for (const file of ['tests/routing-runtime.test.ts', 'tests/thread-wake-native.test.ts']) {
    assert.equal(suites.filter(job => job[2].at(-1) === file).length, 1);
  }
  for (const prerequisite of ['orchestrator memory build', 'orchestrator types', 'orchestrator shared RPC', 'orchestrator tool schemas']) {
    assert.equal(checkJobs.filter(([name]) => name === prerequisite).length, 1);
  }
});

test("check budgets reject invalid settings and permit an empty queue", async () => {
  assert.equal(checkParallelism({ PI_STACK_CHECK_CONCURRENCY: "2" }), 2);
  for (const value of ["0", "-1", "1.5", "garbage", ""]) {
    assert.throws(() => checkParallelism({ PI_STACK_CHECK_CONCURRENCY: value }), /positive integer/);
  }
  await assert.rejects(runJobs([], { concurrency: 0 }), /positive integer/);
  assert.deepEqual(await runJobs([], { concurrency: 1 }), []);
});

test("the job deadline also bounds output drain after process exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-job-drain-deadline-"));
  const pidFile = join(root, "pid");
  try {
    const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:['ignore','inherit','inherit']}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref();`;
    const result = await runJob(["drain deadline", process.execPath, ["-e", code], { timeoutMs: 200 }], () => {});
    assert.equal(result.code, 1);
    assert.match(result.error, /deadline/);
    assert.ok(result.elapsedMs < 2_000);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running job has a bounded deadline", async () => {
  const result = await runJob(["stuck", process.execPath, ["-e", "setInterval(()=>{},60000)"], { timeoutMs: 50 }], () => {});
  assert.equal(result.code, 1);
  assert.match(result.error, /deadline/);
  assert.ok(result.elapsedMs < 2_000);
});
