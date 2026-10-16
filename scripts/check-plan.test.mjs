import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inputGraph, planCheck, testFiles } from './check-plan.mjs';
import { checkExecutor, checkKey, fingerprintTree } from './check-cache.mjs';
import { checkJobs } from './test.mjs';
import { runJob } from './run-jobs.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-check-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  put('package.json', JSON.stringify({ type: 'module', workspaces: ['packages/*'] }));
  put('packages/one/package.json', JSON.stringify({ name: 'one', exports: { './api': { bun: './src/api.ts', default: './dist/api.js' } } }));
  put('packages/one/src/api.ts', 'export { value } from "./leaf.js";');
  put('packages/one/src/leaf.ts', 'export const value = 1;');
  put('packages/one/tests/contract.test.ts', 'import { value } from "one/api"; console.log(value);');
  put('apps/unrelated/source.ts', 'export const unrelated = 1;');
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'add', '.']);
  spawnSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  return { root, put };
}
const versions = { node: 'fixture-exact-tool-content' };
const job = ['orchestrator test: fixture', 'node', ['-e', 'process.exit(0)'], { checkInputs: ['packages/one/tests/contract.test.ts'] }];

test('workspace exports, .js-to-TypeScript resolution and transitive imports define the verdict, not unrelated apps', t => {
  const { root, put } = fixture(t);
  const plan = planCheck(root, job, inputGraph(root));
  assert.equal(plan.coverage, 'declared-import-closure');
  assert.ok(plan.files.includes('packages/one/package.json'));
  assert.ok(plan.files.includes('packages/one/src/leaf.ts'));
  assert.ok(!plan.files.includes('apps/unrelated/source.ts'));
  const before = checkKey(root, job, versions);
  put('apps/unrelated/source.ts', 'export const unrelated = 2;');
  assert.equal(checkKey(root, job, versions), before);
  put('packages/one/src/leaf.ts', 'export const value = 2;');
  assert.notEqual(checkKey(root, job, versions), before);
});

test('an unknown dynamic import requires a fresh full-source proof; new untracked inputs cannot inherit a pass', async t => {
  const { root, put } = fixture(t);
  put('packages/one/tests/contract.test.ts', 'await import(process.env.MODULE);');
  const plan = planCheck(root, job);
  assert.equal(plan.coverage, 'full-source-proof');
  assert.match(plan.reasons.join('\n'), /dynamic import/);
  const key = checkKey(root, job, versions);
  put('apps/unrelated/new.ts', 'export const added = 1;');
  assert.notEqual(checkKey(root, job, versions), key);
  let calls = 0;
  const run = checkExecutor({ root, directory: join(root, 'receipts'), versions, execute: async ([name]) => { calls++; return { name, outcome: 'passed', code: 0 }; } });
  await run(job, () => {});
  await run(job, () => {});
  assert.equal(calls, 2);
  assert.equal(run.inspect(job).state, 'requires-cold-proof');
});

test('a changed import graph, including newly created modules, reruns the check and its newly imported dependency', async t => {
  const { root, put } = fixture(t);
  let calls = 0;
  const execute = checkExecutor({ root, directory: join(root, 'receipts'), versions, execute: async ([name]) => {
    calls++; return { name, outcome: 'passed', code: 0, elapsedMs: 1 };
  } });
  await execute(job, () => {});
  assert.ok((await execute(job, () => {})).reused);
  put('packages/one/src/api.ts', 'export { value } from "./new.js";');
  put('packages/one/src/new.ts', 'export const value = 3;');
  await execute(job, () => {});
  put('packages/one/src/new.ts', 'export const value = 4;');
  await execute(job, () => {});
  assert.equal(calls, 3);
});

test('build verdict reuse requires intact products, and a product repair does not counterfeit check input custody', async t => {
  const { root, put } = fixture(t);
  const build = ['orchestrator memory build', 'node', ['build']];
  put('packages/kenan-memory/src/client.ts', 'export const value = 1;');
  let calls = 0;
  const run = checkExecutor({ root, directory: join(root, 'receipts'), versions, execute: async ([name]) => {
    calls++;
    for (const owner of ['orchestrator', 'kenan-memory', 'kenan-root']) put(`packages/${owner}/dist/client.js`, 'compiled');
    return { name, outcome: 'passed', code: 0, elapsedMs: 1 };
  } });
  await run(build, () => {});
  assert.ok((await run(build, () => {})).reused);
  put('packages/kenan-memory/dist/client.js', 'corrupt');
  assert.equal((await run(build, () => {})).reused, undefined);
  rmSync(join(root, 'packages/kenan-memory/dist'), { recursive: true });
  await run(build, () => {});
  assert.equal(calls, 3);
});

test('content indexes observe in-place tool edits even when byte length and mtime are unchanged', t => {
  const { root, put } = fixture(t);
  const target = join(root, 'installed');
  put('installed/tool.js', 'one');
  const timestamp = new Date('2026-01-01T00:00:00Z');
  utimesSync(join(root, 'installed/tool.js'), timestamp, timestamp);
  const first = fingerprintTree(target, { indexPath: join(root, 'index.json') });
  put('installed/tool.js', 'two');
  utimesSync(join(root, 'installed/tool.js'), timestamp, timestamp);
  const second = fingerprintTree(target, { indexPath: join(root, 'index.json') });
  assert.notEqual(first.digest, second.digest);
});

test('successful stage receipts acquire custody only after the actual toolchain remains unchanged', async t => {
  const { root, put } = fixture(t);
  put('node_modules/tool.js', 'original external dependency');
  const directory = mkdtempSync(join(tmpdir(), 'pi-check-custody-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const execute = checkExecutor({ root, directory });
  const result = await execute(job, () => {});
  assert.equal(result.outcome, 'passed');
  const path = join(directory, `${result.key}.json`);
  assert.equal(existsSync(path), false);
  put('node_modules/tool.js', 'changed external dependency');
  assert.equal(execute.finalize().state, 'changed-toolchain');
  assert.equal(existsSync(path), false);
  const stable = checkExecutor({ root, directory });
  const stableResult = await stable(job, () => {});
  assert.equal(stable.finalize().state, 'validated');
  assert.ok(existsSync(join(directory, `${stableResult.key}.json`)));
  assert.ok((await stable(job, () => {})).reused);
});

test('distinct service invocations reuse reset/write-only environment, while a meaningful read still invalidates and fails', async t => {
  const { root, put } = fixture(t);
  put('packages/one/tests/environment.mjs', `import assert from 'node:assert/strict';
for (const key of Object.keys(process.env)) if (key.startsWith('PI_ORCHESTRATOR_')) delete process.env[key];
process.env.WRITE_ONLY = 'fixed';
delete process.env.RESET_ONLY;
assert.equal(process.env.MEANINGFUL, 'correct');\n`);
  const directory = join(root, 'receipts');
  let calls = 0;
  const run = checkExecutor({ root, directory, versions, execute: async (input, write) => { calls++; return runJob(input, write); } });
  const invocation = (id, pid, meaningful = 'correct') => ['orchestrator test: environment fixture', process.execPath, ['packages/one/tests/environment.mjs'], {
    cwd: root, checkInputs: ['packages/one/tests/environment.mjs'], checkEnvironment: {}, env: {
      ...process.env, INVOCATION_ID: id, SYSTEMD_EXEC_PID: pid, MEANINGFUL: meaningful,
    },
  }];
  const first = invocation('d07da92b56df4e35aeee1ac248750c42', '3507137');
  const second = invocation('bb94a93461d049ef8806a127318fbd68', '2324');
  const plan = planCheck(root, first);
  assert.equal(plan.fullEnvironment, false);
  assert.deepEqual(plan.environment, ['MEANINGFUL']);
  assert.equal(checkKey(root, first, versions), checkKey(root, second, versions));
  assert.equal((await run(first, () => {})).outcome, 'passed');
  assert.ok((await run(second, () => {})).reused);
  const changed = invocation('bb94a93461d049ef8806a127318fbd68', '2324', 'wrong');
  assert.notEqual(checkKey(root, second, versions), checkKey(root, changed, versions));
  assert.equal((await run(changed, () => {})).outcome, 'failed');
  assert.equal(calls, 2);
});

test('compound environment updates and unknown computed reads retain their input dependence', async t => {
  const { root, put } = fixture(t);
  put('packages/one/tests/contract.test.ts', 'process.env.COUNTER += "suffix"; const name = external(); console.log(process.env[name]);');
  const plan = planCheck(root, job);
  assert.ok(plan.environment.includes('COUNTER'));
  assert.equal(plan.coverage, 'full-environment-proof');
  assert.equal(plan.memoizable, false);
  let calls = 0;
  const run = checkExecutor({ root, directory: join(root, 'receipts'), versions, execute: async ([name]) => { calls++; return { name, outcome: 'passed', code: 0 }; } });
  await run(job, () => {});
  await run(job, () => {});
  assert.equal(calls, 2);
  assert.equal(run.inspect(job).state, 'requires-cold-proof');
});

test('synthetic fixture write destinations do not import the coincidentally named real module or its environment', t => {
  const { root, put } = fixture(t);
  put('scripts/deploy-build.test.mjs', `import { writeFileSync } from 'node:fs';
const put = (path, value) => writeFileSync(path, value);
put('packages/one/src/ambient.ts', 'synthetic source');\n`);
  put('packages/one/src/ambient.ts', 'const field = external(); console.log(process.env[field]);');
  const proof = ['orchestrator test: generated destination fixture', 'node', ['scripts/deploy-build.test.mjs'], { checkInputs: ['scripts/deploy-build.test.mjs'] }];
  const plan = planCheck(root, proof);
  assert.equal(plan.fullEnvironment, false);
  assert.ok(!plan.files.includes('packages/one/src/ambient.ts'));
  put('scripts/deploy-build.test.mjs', `import { readFileSync } from 'node:fs';
readFileSync('packages/one/src/ambient.ts', 'utf8');\n`);
  assert.equal(planCheck(root, proof).coverage, 'full-environment-proof');
});

test('shipping plans cover every test file once and do not hide a second Remote build in npm test', () => {
  const root = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
  for (const [prefix, area, pattern] of [
    ['orchestrator test: ', 'packages/orchestrator/tests', /\.test\.tsx?$/],
    ['runtime test: ', 'packages/runtime', /\.test\.mjs$/],
    ['memory test: ', 'packages/kenan-memory/tests', /\.test\.tsx?$/],
    ['root test: ', 'packages/kenan-root/tests', /\.test\.tsx?$/],
    ['remote test: ', 'apps/remote', /\/(?:server|web|shared)\/.*\.test\.tsx?$/],
  ]) {
    const files = checkJobs.filter(job => job[0].startsWith(prefix)).map(job => job[3].checkInputs[0]);
    assert.deepEqual(files.sort(), testFiles(root, area, pattern).sort(), prefix);
    assert.equal(new Set(files).size, files.length);
  }
  assert.equal(checkJobs.filter(([name]) => name === 'Remote build').length, 1);
  assert.equal(checkJobs.some(([, command, args]) => command === 'npm' && args.includes('--workspace=pi-remote') && args.includes('test')), false);
});
