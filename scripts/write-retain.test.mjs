import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('accepted Write retention keeps rollback and mapped entries with their transitive runtime/model custody', t => {
  const dir = mkdtempSync(join(tmpdir(), 'write-retain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = join(dir, '.pi-write');
  for (const name of ['current', 'previous', 'mapped', 'runtime', 'model', 'venv', 'python-process', 'unused']) {
    mkdirSync(join(store, name), { recursive: true });
  }
  symlinkSync(join(store, 'current'), join(dir, 'write-engine'));
  symlinkSync(join(store, 'previous'), join(dir, 'write-engine.previous'));
  symlinkSync(join(store, 'venv'), join(store, 'previous/venv'));
  symlinkSync(join(store, 'runtime'), join(store, 'mapped/rewrite-runtime'));
  symlinkSync(join(store, 'model'), join(store, 'runtime/model'));
  const proc = join(dir, 'proc');
  mkdirSync(join(proc, '123'), { recursive: true });
  writeFileSync(join(proc, '123/cmdline'), `python\0${store}/python-process/server.py\0`);
  writeFileSync(join(proc, '123/maps'), `123-456 r--p 0 00:00 0 ${store}/mapped/library.so\n`);
  const result = spawnSync('python3', [new URL('../deploy/write-retain', import.meta.url).pathname, join(dir, 'write-engine'), proc], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(store, 'unused')), false);
  for (const name of ['current', 'previous', 'mapped', 'runtime', 'model', 'venv', 'python-process']) assert.equal(existsSync(join(store, name)), true, name);
  mkdirSync(join(store, 'unused'));
  rmSync(join(proc, '123/maps'));
  mkdirSync(join(proc, '123/maps'));
  const unreadable = spawnSync('python3', [new URL('../deploy/write-retain', import.meta.url).pathname, join(dir, 'write-engine'), proc], { encoding: 'utf8', timeout: 3000 });
  assert.notEqual(unreadable.status, 0);
  assert.equal(existsSync(join(store, 'unused')), true, 'a failed live census removes nothing');
});
