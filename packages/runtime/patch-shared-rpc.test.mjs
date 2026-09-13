import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {sharedRpcSource} from './patch-shared-rpc.mjs';
test('shared RPC retains upstream commands without process-owned input or exit',()=>{
  const source=sharedRpcSource(readFileSync(join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),'modes/rpc/rpc-mode.js'),'utf8'));
  assert.ok(source.includes('export async function runSharedRpcMode(runtimeHost, io)'));
  assert.ok(source.includes('case "fork":'));
  assert.ok(source.includes('case "compact":'));
  assert.ok(source.includes('preflightResult:'));
  assert.ok(!source.includes('process.exit('));
  assert.ok(!source.includes('process.stdin.'));
  assert.ok(!source.includes('    registerSignalHandlers();'));
});
test('changed upstream layouts fail closed',()=>assert.throws(()=>sharedRpcSource('export function changed() {}')));
test('parallel consumers prepare one complete module and unchanged setup preserves it',async()=>{
  const root=mkdtempSync(join(tmpdir(),'shared-rpc-setup-'));
  const directory=join(root,'@earendil-works/pi-coding-agent/dist/modes/rpc');
  const source=readFileSync(join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),'modes/rpc/rpc-mode.js'),'utf8');
  const run=()=>promisify(execFile)(process.execPath,[fileURLToPath(new URL('./patch-shared-rpc.mjs',import.meta.url)),root],{timeout:5000});
  try{
    mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'rpc-mode.js'),source);
    await Promise.all(Array.from({length:4},run));
    const destination=join(directory,'shared-rpc-mode.js'),before=statSync(destination);
    assert.equal(readFileSync(destination,'utf8'),sharedRpcSource(source));
    await run();
    assert.equal(statSync(destination).ino,before.ino);
    assert.equal(statSync(destination).mtimeMs,before.mtimeMs);
    assert.deepEqual(readdirSync(directory).sort(),['rpc-mode.js','shared-rpc-mode.js']);
  }finally{rmSync(root,{recursive:true,force:true});}
});
