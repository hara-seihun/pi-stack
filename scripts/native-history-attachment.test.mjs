import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachLegacyRuntime, reconcileLegacyRuntime, installLegacyMaintenance } from '../deploy/native-history-bridge.mjs';

function service(state) {
  const runtime = { busy: true, waiters: new Map(), commandRunning: false };
  const calls = [];
  return {
    runtime, calls, runtimes: new Map([['thread', runtime]]), opening: new Map(), operations: new Map(), halts: new Map(),
    attach: async () => runtime, rpc: async () => state, execution: () => undefined,
    adoptReference: (...args) => calls.push(['adopt', ...args]),
    busy: value => value.isStreaming || value.isCompacting || value.localTools > 0 || value.pendingCommandCount > 0,
    wake: id => calls.push(['wake', id]),
  };
}
const idle = { isStreaming: false, isCompacting: false, localTools: 0, pendingCommandCount: 0 };

test('concurrent and repeated legacy attachment retains exactly one socket/runtime', async () => {
  const owner = { runtimes: new Map() };
  let release, count = 0;
  const gate = new Promise(resolve => release = resolve);
  const runtime = { busy: true };
  async function original(id) { count++; this.runtimes.set(id, runtime); await gate; return runtime; }
  const first = attachLegacyRuntime(owner, original, 'thread');
  await Promise.resolve();
  const second = attachLegacyRuntime(owner, original, 'thread');
  release();
  assert.equal(await first, runtime);
  assert.equal(await second, runtime);
  assert.equal(await attachLegacyRuntime(owner, original, 'thread'), runtime);
  assert.equal(count, 1);
});

test('positive native state repairs false busy without clearing actual native work', async () => {
  const owner = service(idle);
  await reconcileLegacyRuntime(owner, 'thread');
  assert.equal(owner.runtime.busy, false);
  assert.equal(owner.calls[1][0], 'wake');
  const running = service({ ...idle, localTools: 1 });
  await reconcileLegacyRuntime(running, 'thread');
  assert.equal(running.runtime.busy, true);
  assert.deepEqual(running.calls.map(call => call[0]), ['adopt']);
});

test('accepted execution stays with its controller without maintenance attachment or state RPC', async () => {
  const owner = service(idle);
  owner.execution = () => ({ id: 'accepted-execution' });
  owner.attach = async () => { throw new Error('Maintenance must not attach accepted execution'); };
  owner.rpc = async () => { throw new Error('Maintenance must not query accepted execution'); };
  await reconcileLegacyRuntime(owner, 'thread');
  assert.equal(owner.runtime.busy, true);
  assert.deepEqual(owner.calls, []);
});

test('execution or dispatch beginning during attachment defers idle reconciliation', async () => {
  for (const race of ['execution', 'dispatch', 'opening', 'halt']) {
    const owner = service(idle);
    owner.attach = async () => {
      if (race === 'execution') owner.execution = () => ({ id: 'raced-execution' });
      if (race === 'dispatch') owner.operations.set('thread', Promise.resolve());
      if (race === 'opening') owner.opening.set('thread', Promise.resolve());
      if (race === 'halt') owner.halts.set('thread', Promise.resolve());
      return owner.runtime;
    };
    owner.rpc = async () => { throw new Error('Maintenance must not overlap raced ownership'); };
    await reconcileLegacyRuntime(owner, 'thread');
    assert.equal(owner.runtime.busy, true);
    assert.deepEqual(owner.calls, []);
  }
});

test('incomplete state, replacement race and pending commands never fabricate idle', async () => {
  const unknown = service({ isStreaming: false });
  await assert.rejects(reconcileLegacyRuntime(unknown, 'thread'), /incomplete execution-state proof/);
  assert.equal(unknown.runtime.busy, true);
  assert.deepEqual(unknown.calls, []);
  const raced = service(idle);
  raced.rpc = async () => { raced.runtimes.set('thread', {}); return idle; };
  await assert.rejects(reconcileLegacyRuntime(raced, 'thread'), /changed during state reconciliation/);
  assert.deepEqual(raced.calls, []);
  const pending = service(idle);
  pending.runtime.waiters.set('command', {});
  pending.rpc = async () => { throw new Error('Must not overlap command custody'); };
  await reconcileLegacyRuntime(pending, 'thread');
  assert.equal(pending.runtime.busy, true);
});

test('restored receipt survives restart without reentering old maintenance or importing its decoder', async t => {
  const root = mkdtempSync(join(tmpdir(), 'history-restored-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = { version: 1, protocol: 'native-history-maintenance-v1', uid: process.getuid(), dataDir: root,
    candidate: 'b'.repeat(40), legacySource: 'a'.repeat(40), phase: 'restored', databases: [] };
  const path = join(root, 'native-history-maintenance.json');
  const bytes = JSON.stringify(receipt);
  writeFileSync(path, bytes);
  assert.equal(await installLegacyMaintenance({ ...receipt, mode: 'remote', oldApi: '/unavailable-decoder' }), true);
  assert.equal(readFileSync(path, 'utf8'), bytes);
});
