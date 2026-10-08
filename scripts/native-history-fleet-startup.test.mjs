import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetNativeSource, fleetLegacyManifest, NativeHistoryStartupError } from '../packages/orchestrator/src/native-history-startup.ts';
const candidate = 'b'.repeat(40), old = 'a'.repeat(40);
function directory(t) { const root = mkdtempSync(join(tmpdir(), 'fleet-first-start-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function control(root, generation, body = '') {
  mkdirSync(join(root, 'thread-runners'), { recursive: true }); mkdirSync(join(root, 'thread-sockets'), { recursive: true });
  writeFileSync(join(root, 'thread-runners', `${generation}.sock`), 'control');
  const spool = join(root, 'thread-sockets', `${generation}.thread.sock.events`); writeFileSync(spool, body); return spool;
}
test('fresh and native first starts retain current custody without decoding output bodies', async t => {
  const root = directory(t); assert.equal(await fleetNativeSource(root), 'native');
  const spool = control(root, 'native', 'not decoded by startup');
  assert.equal(await fleetNativeSource(root, async () => ({ ok: true, historySource: 'native-jsonl-v1' })), 'native');
  assert.equal(readFileSync(spool, 'utf8'), 'not decoded by startup');
});
test('legacy and unavailable producers never become candidate decoder custody', async t => {
  const root = directory(t), spool = control(root, 'old', 'exact old output');
  assert.equal(await fleetNativeSource(root, async () => ({ ok: true })), 'legacy');
  await assert.rejects(fleetNativeSource(root, async () => { throw new Error('owner still starting'); }), error => error instanceof NativeHistoryStartupError && error.exitCode === 75);
  assert.equal(readFileSync(spool, 'utf8'), 'exact old output');
});
test('unowned retained output requires source-bound maintenance, not an empty daemon', async t => {
  const root = directory(t); mkdirSync(join(root, 'thread-sockets'));
  const spool = join(root, 'thread-sockets', 'old.thread.sock.events'); writeFileSync(spool, 'retained old output');
  assert.equal(await fleetNativeSource(root), 'legacy');
  assert.throws(() => fleetLegacyManifest(root, root), error => error instanceof NativeHistoryStartupError && error.exitCode === 75);
  assert.equal(readFileSync(spool, 'utf8'), 'retained old output');
});
test('first-start maintenance validates candidate and immutable old source stamps', t => {
  const root = directory(t), release = join(root, 'candidate'), manifestRoot = join(root, 'maintenance');
  const legacyRemote = join(root, 'remote'), legacyOrchestrator = join(root, 'orchestrator');
  mkdirSync(release); writeFileSync(join(release, '.pi-stack-commit'), candidate);
  mkdirSync(legacyRemote); mkdirSync(join(legacyOrchestrator, 'dist'), { recursive: true });
  for (const directory of [legacyRemote, legacyOrchestrator]) writeFileSync(join(directory, '.pi-stack-commit'), old);
  writeFileSync(join(legacyOrchestrator, 'dist/api.js'), 'exact API'); writeFileSync(join(legacyOrchestrator, 'dist/cli.js'), 'exact CLI');
  const bridgeModule = join(root, 'bridge.mjs'), migrator = join(root, 'migrate.mjs'); writeFileSync(bridgeModule, 'source'); writeFileSync(migrator, 'source');
  mkdirSync(join(manifestRoot, candidate), { recursive: true });
  const manifest = { version: 1, candidate, legacySource: old, legacyRemote, legacyOrchestrator, bridgeModule, migrator, node: process.execPath };
  writeFileSync(join(manifestRoot, candidate, 'legacy.json'), JSON.stringify(manifest));
  for (const path of [legacyRemote, legacyOrchestrator]) chmodSync(path, 0o700);
  for (const path of [bridgeModule, migrator, join(manifestRoot, candidate, 'legacy.json'), join(legacyOrchestrator, 'dist/api.js'), join(legacyOrchestrator, 'dist/cli.js')]) chmodSync(path, 0o600);
  assert.equal(fleetLegacyManifest(release, manifestRoot).legacySource, old);
  writeFileSync(join(legacyOrchestrator, '.pi-stack-commit'), 'c'.repeat(40));
  assert.throws(() => fleetLegacyManifest(release, manifestRoot), error => error instanceof NativeHistoryStartupError && error.exitCode === 75);
});
