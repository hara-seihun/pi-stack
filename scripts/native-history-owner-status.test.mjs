import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BRIDGE_PROTOCOL } from '../deploy/native-history-bridge.mjs';

function fixture(t, defect) {
  const root = mkdtempSync(join(tmpdir(), 'owner-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owners = Array.from({ length: 10 }, (_, i) => ({ user: `owner${i}`, uid: 1000 + i,
    dataDir: join(root, `data${i}`), unit: `owner${i}.service`, socket: join(root, `socket${i}`) }));
  writeFileSync(join(root, 'systemctl'), `#!${process.execPath}
if(process.argv[3]==='owner0.service' && ${JSON.stringify(defect)}==='inspection')process.exit(1);
console.log('1234');`, { mode: 0o755 });
  writeFileSync(join(root, 'nsenter'), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2), owners=${JSON.stringify(owners)};
const item=owners.find(item=>item.socket===args[args.indexOf('--unix-socket')+1]);
if(!item || args.slice(0,8).join(' ')!=='--target 1234 --mount -- runuser -u '+item.user+' --')process.exit(2);
appendFileSync(${JSON.stringify(join(root, 'calls'))},JSON.stringify(args)+'\\n');
setTimeout(()=>{
 if(item.user==='owner1' && ${JSON.stringify(defect)}==='unavailable'){console.error('controller absent');process.exit(7);}
 const value={protocol:${JSON.stringify(BRIDGE_PROTOCOL)},uid:item.uid,dataDir:item.dataDir,phase:'draining',ready:item.user!=='owner9'};
 if(item.user==='owner2' && ${JSON.stringify(defect)}==='identity')value.uid=0;
 console.log(JSON.stringify(value));
},250);`, { mode: 0o755 });
  const module = pathToFileURL(join(process.cwd(), 'deploy/native-history-coordinator.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import {ownerStatuses,allOwnersReady} from ${JSON.stringify(module)};
const owners=${JSON.stringify(owners)}, start=performance.now();
try {
 const first=await ownerStatuses(owners), second=await ownerStatuses(owners);
 console.log(JSON.stringify({first,second,ready:allOwnersReady(second),elapsedMs:performance.now()-start}));
} catch(error) { console.error(error.message); process.exitCode=1; }
`], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { root, child };
}
async function outcome(child) {
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
}
test('two ten-owner censuses fit one control round trip each, preserve namespace/UID and never hide a busy owner', async t => {
  const f = fixture(t, 'none'), result = await outcome(f.child);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.first.length, 10); assert.equal(value.second.length, 10);
  assert.equal(value.ready, false);
  assert.ok(value.elapsedMs < 2000, `Serial fanout exhausted the probe budget: ${value.elapsedMs}ms`);
  assert.deepEqual(value.second.map(status => status.value.uid), Array.from({ length: 10 }, (_, i) => 1000 + i));
  assert.equal(readFileSync(join(f.root, 'calls'), 'utf8').trim().split('\n').length, 20);
});
test('an unavailable owner stays pending while every other owner is observed', async t => {
  const f = fixture(t, 'unavailable'), result = await outcome(f.child);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ready, false);
  assert.deepEqual(value.second[1], { available: false, error: 'controller absent' });
  assert.equal(value.second.filter(status => status.available).length, 9);
});
for (const [defect, error] of [['inspection', /namespace inspection failed/], ['identity', /owner identity mismatch/]]) {
  test(`parallel census rejects ${defect} failures rather than declaring a deployment wait`, async t => {
    const f = fixture(t, defect), result = await outcome(f.child);
    assert.equal(result.code, 1); assert.match(result.stderr, error);
  });
}
