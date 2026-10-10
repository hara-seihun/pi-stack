import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runJob, runJobs } from "./run-jobs.mjs";
import { orchestratorBuildChecks, orchestratorChecks, orchestratorTestChecks, orchestratorTypeChecks } from "../packages/orchestrator/scripts/check.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const silent = () => {};

async function withoutExitCode(fn) {
  const exitCode = process.exitCode;
  try { await fn(); } finally { process.exitCode = exitCode; }
}

test("check modes return their complete graph or reject input before execution", () => {
  const args = ["tests/import.test.ts", "--testNamePattern=import fixture"];
  assert.deepEqual(orchestratorChecks("test", args), orchestratorTestChecks([{ name: "orchestrator tests", args }]));
  assert.deepEqual(orchestratorChecks("typecheck", []), orchestratorTypeChecks());
  assert.deepEqual(orchestratorChecks("build", []), orchestratorBuildChecks());
  for (const mode of [undefined, "", "typo"]) {
    assert.throws(() => orchestratorChecks(mode, []), /unknown Orchestrator check mode/);
  }
  for (const mode of ["typecheck", "build"]) {
    assert.throws(() => orchestratorChecks(mode, args), new RegExp(`${mode} does not accept arguments`));
  }
});

test("failed prerequisites block runtime transitively while independent checks finish", () => withoutExitCode(async () => {
  const command = (name, code, dependsOn = []) => [name, process.execPath, ["-e", `process.exit(${code})`], { dependsOn }];
  const results = await runJobs([
    command("suite", 0, ["prepare"]),
    command("prepare", 0, ["types"]),
    command("types", 1),
    command("independent", 0),
  ], { concurrency: 2, write: silent });
  assert.deepEqual(results.map(result => result.outcome), ["blocked", "blocked", "failed", "passed"]);
  assert.deepEqual(results[0].blockedBy, ["prepare"]);
  assert.deepEqual(results[1].blockedBy, ["types"]);
  assert.equal(results[0].elapsedMs, 0);
  assert.equal(process.exitCode, 1);
}));

test("invalid graphs and standalone dependent jobs are rejected before spawning", async () => {
  const job = (name, dependsOn = []) => [name, "must-not-run", [], { dependsOn }];
  await assert.rejects(runJobs([job("a"), job("a")]), /duplicate/);
  await assert.rejects(runJobs([job("a", ["missing"])]), /unknown prerequisite/);
  await assert.rejects(runJobs([job("a", ["b"]), job("b", ["a"])]), /cyclic/);
  assert.throws(() => runJob(job("a", ["b"])), /without its check graph/);
});

test("publication shares prerequisites once and bounds all seven runtime suites", async () => {
  const suites = Array.from({ length: 7 }, (_, index) => ({ name: `suite ${index}`, args: [] }));
  const plan = orchestratorTestChecks(suites);
  let active = 0, peak = 0;
  const started = [], passed = new Set();
  const jobs = plan.map(([name, , , { dependsOn = [] }]) => [name, process.execPath,
    ["-e", "setTimeout(() => {}, 20)"], { dependsOn }]);
  const results = await runJobs(jobs, { concurrency: 3, write(text) {
    const start = text.match(/===== (.+): started =====/);
    if (start) {
      const name = start[1];
      const dependencies = jobs.find(job => job[0] === name)[3].dependsOn;
      for (const dependency of dependencies) assert.ok(passed.has(dependency), `${name} preceded ${dependency}`);
      started.push(name);
      peak = Math.max(peak, ++active);
    }
    const pass = text.match(/===== (.+): passed \(/);
    if (pass) { passed.add(pass[1]); active--; }
  } });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(new Set(started).size, 11);
  assert.equal(results.filter(result => result.outcome === "passed").length, 11);
});

test("focused npm test cannot report success for a transpile-valid fixture missing required settings", () => withoutExitCode(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-typed-test-"));
  const cwd = join(root, "packages/orchestrator");
  const marker = join(cwd, "runtime-ran");
  const put = (path, content) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    for (const path of ["scripts/run-jobs.mjs", "scripts/workspace-closure.mjs", "packages/orchestrator/scripts/check.mjs"]) {
      put(path, readFileSync(join(repository, path)));
    }
    const manifest = JSON.parse(readFileSync(join(repository, "packages/orchestrator/package.json"), "utf8"));
    put("package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    put("packages/orchestrator/package.json", JSON.stringify({ name: manifest.name, type: "module", exports: {}, scripts: manifest.scripts }));
    for (const name of ['kenan-memory', 'kenan-root']) {
      put(`packages/${name}/package.json`, JSON.stringify({ name, type: 'module', exports: {} }));
      mkdirSync(join(root, 'packages', name, 'src'));
    }
    put("packages/runtime/patch-shared-rpc.mjs", "process.exit(0);\n");
    put("packages/runtime/patch-anthropic-tool-schema.mjs", "process.exit(0);\n");
    copyFileSync(join(repository, "packages/orchestrator/tsconfig.json"), join(cwd, "tsconfig.json"));
    mkdirSync(join(root, "node_modules"));
    for (const name of readdirSync(join(repository, "node_modules"))) {
      if (name !== ".cache") symlinkSync(join(repository, "node_modules", name), join(root, "node_modules", name));
    }
    put("packages/orchestrator/src/threads.ts", "export function importThread(input: { settings: { model: string }; title: string }) { return input.title; }\n");
    const fixture = settings => `import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { importThread } from '../src/threads.js';
it('import fixture', () => {
  expect(importThread({ title: 'fixture'${settings} })).toBe('fixture');
  writeFileSync('runtime-ran', 'yes');
});\n`;
    put("packages/orchestrator/tests/import.test.ts", fixture(""));
    put('packages/orchestrator/vitest.config.ts', 'export default {};\n');
    let output = "";
    const raw = await runJob(["raw transpile", process.execPath,
      [join(root, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=1", "tests/import.test.ts"], { cwd }], text => { output += text; });
    assert.equal(raw.code, 0, output);
    assert.ok(existsSync(marker));
    rmSync(marker);
    output = "";
    const invalid = await runJob(["focused check", "npm", ["--ignore-scripts", "test", "--", "tests/import.test.ts"], { cwd }], text => { output += text; });
    assert.equal(invalid.code, 1, output);
    assert.match(output, /Property 'settings' is missing/);
    assert.match(output, /orchestrator tests: blocked/);
    assert.equal(existsSync(marker), false, output);

    put("packages/orchestrator/tests/import.test.ts", fixture(", settings: { model: 'fixture' }"));
    output = "";
    const valid = await runJob(["focused check", "npm", ["--ignore-scripts", "test", "--", "tests/import.test.ts"], { cwd }], text => { output += text; });
    assert.equal(valid.code, 0, output);
    assert.ok(existsSync(marker));
    assert.match(output, /orchestrator types: passed/);
    assert.match(output, /orchestrator tests: passed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));
