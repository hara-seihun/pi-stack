import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { startFleetHistory, fleetNativeCensus, nativeRunnerStatus, fleetNativeSource, fleetLegacyManifest, NativeHistoryStartupError } from '../packages/orchestrator/src/native-history-startup.ts';
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
  assert.equal(await fleetNativeSource(root, async () => ({ ok: true, value: { ok: true, historySource: 'native-jsonl-v1' } })), 'native');
  assert.equal(readFileSync(spool, 'utf8'), 'not decoded by startup');
});
test('legacy and unavailable producers never become candidate decoder custody', async t => {
  const root = directory(t), spool = control(root, 'old', 'exact old output');
  assert.equal(await fleetNativeSource(root, async () => ({ ok: true, value: { ok: true } })), 'legacy');
  const receipt = await fleetNativeCensus(root, async () => ({ ok: false, error: { code: 'timeout', message: 'owner still starting' } }));
  assert.equal(receipt.source, 'legacy');
  assert.equal(receipt.runners[0].kind, 'unverified');
  assert.equal(receipt.runners[0].attempts, 2);
  assert.deepEqual(receipt.legacySpools, [spool]);
  assert.equal(readFileSync(spool, 'utf8'), 'exact old output');
});
test('unowned retained output requires source-bound maintenance, not an empty daemon', async t => {
  const root = directory(t); mkdirSync(join(root, 'thread-sockets'));
  const spool = join(root, 'thread-sockets', 'old.thread.sock.events'); writeFileSync(spool, 'retained old output');
  assert.equal(await fleetNativeSource(root), 'legacy');
  assert.throws(() => fleetLegacyManifest(root, root), error => error instanceof NativeHistoryStartupError && error.exitCode === 75);
  assert.equal(readFileSync(spool, 'utf8'), 'retained old output');
});
async function server(t, root, generation, respond) {
  mkdirSync(join(root, 'thread-runners'), { recursive: true });
  const path = join(root, 'thread-runners', `${generation}.sock`), sockets = new Set();
  const listener = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => respond(socket, data));
  });
  listener.listen(path); await once(listener, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => listener.close(resolve)); });
  return path;
}
test('refused and disappearing sockets are unverified, never proven native and do not veto startup', async t => {
  const root = directory(t);
  control(root, 'refused'); control(root, 'missing');
  const receipt = await fleetNativeCensus(root, path => path.endsWith('missing.sock') ? nativeRunnerStatus(`${path}.gone`) : nativeRunnerStatus(path));
  assert.equal(receipt.source, 'native');
  assert.deepEqual(receipt.runners.map(row => [row.kind, row.error.code, row.attempts]), [
    ['unverified', 'missing', 1], ['unverified', 'refused', 1],
  ]);
  assert.equal(receipt.kind, 'fleet-native-census'); assert.equal(receipt.version, 1);
  assert.ok(receipt.runners.every(row => row.socket.startsWith(root) && row.latencyMs >= 0));
});
test('one stale control cannot veto a native runner or daemon start, but its output cannot cross decoder ownership', async t => {
  const root = directory(t), spool = control(root, 'stale');
  await server(t, root, 'live', socket => socket.end(JSON.stringify({ ok: true, historySource: 'native-jsonl-v1' }) + '\n'));
  const options = { socketDir: root, ledgerPath: join(root, 'ledger.sqlite3'), releaseRoot: root };
  assert.equal(await startFleetHistory(options), 'native');
  const receipt = await fleetNativeCensus(root);
  assert.deepEqual(receipt.runners.map(row => [row.generation, row.kind]), [['live', 'native'], ['stale', 'unverified']]);
  writeFileSync(spool, 'unchanged legacy output');
  await assert.rejects(startFleetHistory(options), error => error instanceof NativeHistoryStartupError &&
    error.exitCode === 75 && error.message.includes(join(root, 'thread-runners', 'stale.sock')) && error.message.includes(spool));
  assert.equal(readFileSync(spool, 'utf8'), 'unchanged legacy output');
});
test('real status timeout retries once and leaves retained output under legacy custody', async t => {
  const root = directory(t), spool = control(root, 'slow', 'exact undecoded output');
  rmSync(join(root, 'thread-runners', 'slow.sock'));
  let connections = 0;
  await server(t, root, 'slow', () => { connections++; });
  const started = performance.now(), receipt = await fleetNativeCensus(root);
  assert.equal(receipt.source, 'legacy'); assert.equal(connections, 2);
  assert.equal(receipt.runners[0].kind, 'unverified'); assert.equal(receipt.runners[0].error.code, 'timeout');
  assert.equal(receipt.runners[0].attempts, 2);
  assert.ok(receipt.runners[0].latencyMs >= 5900 && performance.now() - started < 8500);
  assert.deepEqual(receipt.legacySpools, [spool]); assert.equal(readFileSync(spool, 'utf8'), 'exact undecoded output');
});
test('a slow native runner can prove ownership on its single retry', async t => {
  const root = directory(t); let attempts = 0;
  await server(t, root, 'recover', socket => { if (++attempts === 2) socket.end(JSON.stringify({ ok: true, historySource: 'native-jsonl-v1' }) + '\n'); });
  const receipt = await fleetNativeCensus(root);
  assert.equal(receipt.source, 'native'); assert.equal(attempts, 2);
  assert.equal(receipt.runners[0].kind, 'native'); assert.equal(receipt.runners[0].attempts, 2);
});
test('bad or incomplete receipts are typed unverified observations, not native ownership', async t => {
  const root = directory(t);
  await server(t, root, 'invalid', socket => socket.end('invalid\n'));
  await server(t, root, 'rejected', socket => socket.end('{"ok":false}\n'));
  await server(t, root, 'ended', socket => socket.end());
  const receipt = await fleetNativeCensus(root);
  assert.deepEqual(receipt.runners.map(row => [row.kind, row.error.code, row.attempts]), [
    ['unverified', 'closed', 1], ['unverified', 'protocol', 1], ['unverified', 'protocol', 1],
  ]);
});
test('census observes runners concurrently within one bounded retry window', async t => {
  const root = directory(t); for (let i = 0; i < 20; i++) control(root, `runner${i}`);
  const started = performance.now();
  const receipt = await fleetNativeCensus(root, async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return { ok: true, value: { ok: true, historySource: 'native-jsonl-v1' } };
  });
  assert.equal(receipt.runners.length, 20); assert.ok(performance.now() - started < 1000);
});
test('startup retains explicit socket and spool window guards', async t => {
  const sockets = directory(t); for (let i = 0; i < 257; i++) control(sockets, `runner${i}`);
  await assert.rejects(fleetNativeCensus(sockets), /ownership census exceeds/);
  const spools = directory(t); mkdirSync(join(spools, 'thread-sockets'));
  for (let i = 0; i < 4097; i++) writeFileSync(join(spools, 'thread-sockets', `${i}.events`), '');
  await assert.rejects(fleetNativeCensus(spools), /output census exceeds/);
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
