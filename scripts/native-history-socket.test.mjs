import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, lstatSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBridgeSocket } from '../deploy/native-history-bridge.mjs';
function directory(t) { const root = mkdtempSync(join(tmpdir(), 'history-socket-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('a second controller cannot unlink or orphan the live maintenance owner', async t => {
  const path = join(directory(t), 'owner.sock');
  const server = createServer((req, res) => res.end('same-owner'));
  await new Promise(resolve => server.listen(path, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const inode = lstatSync(path).ino;
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

test('positive refusal of a dead socket permits removal, while unrelated files remain untouched', async t => {
  const path = join(directory(t), 'dead.sock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'node:net'; createServer().listen(process.argv[1],()=>console.log('bound'));`, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(lstatSync(path).isSocket(), true);
  assert.deepEqual(await prepareBridgeSocket(path), { ok: true, value: 'removed-stale' });
  assert.equal(existsSync(path), false);
  writeFileSync(path, 'not a maintenance socket');
  const refused = await prepareBridgeSocket(path);
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'unrelated-file');
  assert.equal(readFileSync(path, 'utf8'), 'not a maintenance socket');
});
