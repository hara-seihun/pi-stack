import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originalEntryProof } from '../deploy/native-history-closed-owner.mjs';

test('serving census counts Node/Bun execution, not a launcher mentioning the same entry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'history-serving-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'a'.repeat(40)); mkdirSync(join(source, 'server'), { recursive: true });
  const entry = join(source, 'server/main.ts');
  writeFileSync(entry, "process.stdout.write('serving\\n');setInterval(()=>{},1000);");
  const main = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  const launcher = spawn('/bin/sh', ['-c', "printf 'launcher\\n'; read hold", entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    for (const child of [main, launcher]) if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
    }
  });
  await Promise.all([once(main.stdout, 'data'), once(launcher.stdout, 'data')]);
  const cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim().slice(3);
  const proof = originalEntryProof({ mode: 'remote', uid: process.getuid() }, source, cgroup, readlinkSync('/proc/self/ns/mnt'));
  assert.equal(proof.pid, main.pid);
  assert.equal(proof.selection.kind, 'literal-immutable-entry');
});
