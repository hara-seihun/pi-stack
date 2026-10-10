import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExecutor, checkKey, checkPolicy, toolchain } from './check-cache.mjs';
import { checkJobs } from './test.mjs';
import { runJobs } from './run-jobs.mjs';

const versions = { node: 'fixture', bun: 'fixture' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-check-cache-'));
  mkdirSync(join(root, 'tools/mail-send'), { recursive: true });
  writeFileSync(join(root, 'tools/mail-send/send.py'), 'one');
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'add', '.']);
  spawnSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  return root;
}
const job = ['mail send boundary', 'python3', ['-B', 'tools/mail-send/test_send.py']];

test('every shipping check declares inputs or an output-producing stage', () => {
  for (const job of checkJobs) assert.ok(['run', 'memo'].includes(checkPolicy(job[0], job).kind), job[0]);
  assert.throws(() => checkPolicy('new unregistered check'), /No declared/);
});

test('passed stages survive unrelated source repair; inputs, tools and commands invalidate', async () => {
  const root = fixture();
  try {
    let calls = 0;
    const directory = join(root, 'receipts');
    const execute = async ([name]) => { calls++; return { name, code: 0, outcome: 'passed', elapsedMs: 1 }; };
    const run = checkExecutor({ root, directory, versions, execute });
    assert.equal((await run(job, () => {})).code, 0);
    writeFileSync(join(root, 'unrelated'), 'change');
    assert.ok((await run(job, () => {})).reused);
    assert.equal(calls, 1);
    writeFileSync(join(root, 'tools/mail-send/send.py'), 'two');
    await run(job, () => {});
    assert.equal(calls, 2);
    assert.notEqual(checkKey(root, job, versions), checkKey(root, job, { ...versions, bun: 'changed' }));
    assert.notEqual(checkKey(root, job, versions), checkKey(root, [job[0], job[1], [...job[2], '--changed']], versions));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prompt availability receipts track the observer and its proof harness', () => {
  const root = fixture();
  try {
    const inputs = ['deploy/prompt-availability', 'scripts/prompt-availability.test.py'];
    for (const input of inputs) {
      mkdirSync(join(root, input, '..'), { recursive: true });
      writeFileSync(join(root, input), 'original');
    }
    const availability = checkJobs.find(([name]) => name === 'prompt availability');
    const key = checkKey(root, availability, versions);
    assert.match(key, /^[0-9a-f]{64}$/);
    writeFileSync(join(root, 'unrelated'), 'change');
    assert.equal(checkKey(root, availability, versions), key);
    for (const input of inputs) {
      writeFileSync(join(root, input), 'changed');
      assert.notEqual(checkKey(root, availability, versions), key, input);
      writeFileSync(join(root, input), 'original');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed or mutated stages cannot manufacture pass receipts; corrupt receipts refuse', async () => {
  const root = fixture();
  try {
    const directory = join(root, 'receipts');
    const fail = checkExecutor({ root, directory, versions, execute: async ([name]) => ({ name, code: 1, outcome: 'failed' }) });
    await fail(job, () => {});
    const mutate = checkExecutor({ root, directory, versions, execute: async ([name]) => {
      writeFileSync(join(root, 'tools/mail-send/send.py'), 'changed during run');
      return { name, code: 0, outcome: 'passed' };
    } });
    await mutate(job, () => {});
    mkdirSync(directory, { recursive: true });
    assert.deepEqual(readdirSync(directory), []);
    const path = join(directory, `${checkKey(root, job, versions)}.json`);
    writeFileSync(path, JSON.stringify({ outcome: 'passed' }));
    await assert.rejects(fail(job, () => {}), /Invalid check receipt/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('revision reconciliation always runs; cached prerequisites still obey the graph', async () => {
  const root = fixture();
  const exit = process.exitCode;
  try {
    const calls = [];
    const execute = checkExecutor({ root, directory: join(root, 'receipts'), versions, execute: async ([name]) => {
      calls.push(name); return { name, outcome: 'passed', code: 0, elapsedMs: 1 };
    } });
    const jobs = [['Remote build', 'node', ['build']], [...job, { dependsOn: ['Remote build'] }]];
    await runJobs(jobs, { execute, write: () => {} });
    await runJobs(jobs, { execute, write: () => {} });
    assert.deepEqual(calls, ['Remote build', 'mail send boundary', 'Remote build']);
  } finally { process.exitCode = exit; rmSync(root, { recursive: true, force: true }); }
});

test('Vitest result caches are outputs, not installed dependency mutation', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'node_modules/example'), { recursive: true });
    writeFileSync(join(root, 'node_modules/example/index.js'), 'export const value = 1');
    mkdirSync(join(root, 'packages/orchestrator'), { recursive: true });
    writeFileSync(join(root, 'packages/orchestrator/package.json'), JSON.stringify({ name: 'pi-orchestrator' }));
    const before = toolchain(root);
    const cache = join(root, 'packages/orchestrator/node_modules/.vite/vitest/fixture');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'results.json'), JSON.stringify({ passed: true }));
    assert.deepEqual(toolchain(root), before);
    writeFileSync(join(root, 'node_modules/example/index.js'), 'export const value = 2');
    assert.notDeepEqual(toolchain(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
