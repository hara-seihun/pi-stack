import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createControlServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtempSync, lstatSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBridgeSocket, probeBridgeSocket, runnerRequest, observeLegacyRunner } from '../deploy/native-history-bridge.mjs';
function directory(t) { const root = mkdtempSync(join(tmpdir(), 'history-socket-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('Node eval library import does not run the socket probe CLI even when argv names the module', () => {
  const module = fileURLToPath(new URL('../deploy/native-history-bridge.mjs', import.meta.url));
  const loaded = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m=await import(process.argv[1]); if(typeof m.legacyFleetLedger!=='function')process.exit(1); console.log('imported');`, module],
    { encoding: 'utf8', timeout: 2000 });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout.trim(), 'imported');
  const cli = spawnSync(process.execPath, [module, '--probe-socket', '/tmp/pi-history-definitely-absent.sock'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).value.kind, 'absent');
});
test('a second controller cannot unlink or orphan the live maintenance owner', async t => {
  const path = join(directory(t), 'owner.sock');
  const server = createServer((req, res) => res.end('same-owner'));
  await new Promise(resolve => server.listen(path, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const inode = lstatSync(path).ino;
  const live = await probeBridgeSocket(path);
  assert.equal(live.ok, true); assert.equal(live.value.kind, 'live');
  const result = await prepareBridgeSocket(path);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'live-owner');
  assert.equal(lstatSync(path).ino, inode);
  const response = await new Promise((resolve, reject) => {
    const req = request({ socketPath: path, path: '/' }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve(text)); });
    req.on('error', reject); req.end();
  });
  assert.equal(response, 'same-owner');
});

test('retirement timeout stays a command failure; empty and malformed census replies are preservation errors', async t => {
  const root = directory(t), path = join(root, 'runner.sock');
  let mode = 'unresponsive';
  const server = createControlServer(socket => socket.on('data', () => {
    if (mode === 'empty') socket.end();
    if (mode === 'malformed') socket.end('not-json\n');
  }));
  await new Promise(resolve => server.listen(path, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(runnerRequest(path, { type: 'drain' }, 20), error => error.code === 'LEGACY_CONTROL_TIMEOUT' && error.operation === 'drain' && error.control === path);
  for (mode of ['empty', 'malformed']) {
    const result = await observeLegacyRunner(path);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'runner-control-failed');
  }
  assert.deepEqual(await observeLegacyRunner(join(root, 'absent.sock')), { ok: true, value: { kind: 'absent' } });
});

test('positive refusal of a dead socket permits removal, while unrelated files remain untouched', async t => {
  const path = join(directory(t), 'dead.sock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'node:net'; createServer().listen(process.argv[1],()=>console.log('bound'));`, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(lstatSync(path).isSocket(), true);
  const inode = lstatSync(path).ino;
  const stale = await probeBridgeSocket(path);
  assert.equal(stale.ok, true); assert.equal(stale.value.kind, 'stale');
  assert.equal(lstatSync(path).ino, inode, 'readonly proof preserves even a stale endpoint');
  assert.deepEqual(await prepareBridgeSocket(path), { ok: true, value: 'removed-stale' });
  assert.equal(existsSync(path), false);
  writeFileSync(path, 'not a maintenance socket');
  const refused = await prepareBridgeSocket(path);
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'unrelated-file');
  assert.equal(readFileSync(path, 'utf8'), 'not a maintenance socket');
});
