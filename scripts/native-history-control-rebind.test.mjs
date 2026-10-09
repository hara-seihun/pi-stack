#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const dir = mkdtempSync(join(tmpdir(), 'pi-maintenance-rebind-'));
const path = join(dir, '.native-history-0000000000000000.sock');
const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `import http from 'node:http';import fs from 'node:fs';const server=http.createServer((req,res)=>res.end('{"ok":true}'));server.listen(${JSON.stringify(path)},()=>{fs.unlinkSync(${JSON.stringify(path)});console.log('ready');});`], { stdio: ['ignore', 'pipe', 'pipe'] });
let errors = '';
child.stderr.on('data', b => { errors += b; });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic target did not start: ' + errors)), 3000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Target failed: ' + code + ' ' + errors)); });
  });
  const port = Number(errors.match(/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]);
  assert.ok(Number.isSafeInteger(port) && port > 0);
  const adapter = spawn(process.execPath, [fileURLToPath(new URL('../deploy/native-history-control-rebind.mjs', import.meta.url)), String(child.pid), String(process.getuid()), path, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', error = '';
  adapter.stdout.on('data', b => { out += b; }); adapter.stderr.on('data', b => { error += b; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { adapter.kill(); reject(new Error('Adapter timeout')); }, 6000);
    adapter.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, error);
  assert.equal(JSON.parse(out).state, 'maintenance-listener-rebound');
  process.kill(child.pid, 0);
  const body = await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path, path: '/restore', method: 'POST' }, response => {
      let data = ''; response.on('data', b => { data += b; }); response.once('end', () => resolve(data));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(JSON.parse(body).ok, true);
  const inspector = await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve('open'); });
    socket.once('error', error => { socket.destroy(); resolve(error.code); });
  });
  assert.equal(inspector, 'ECONNREFUSED');
  assert.equal(errors.includes('ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'), false);
  process.kill(child.pid, 0);
  console.log('Orphaned HTTP endpoint rebind + real restore request + inspector close preserved target PID');
} finally {
  child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
}
