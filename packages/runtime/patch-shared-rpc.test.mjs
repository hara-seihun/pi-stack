import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
