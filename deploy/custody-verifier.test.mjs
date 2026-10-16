import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { custodyVerifier } from './custody-verifier.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'custody-verifier-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source.ts'), path = join(root, 'published.ts');
  writeFileSync(source, '#!/usr/local/bin/bun\nconsole.log("fixture");\n');
  copyFileSync(source, path); chmodSync(path, 0o755);
  return { root, source, path };
}
test('publication owns exact verifier bytes as root555 and cached verification never repairs', { skip: process.getuid() !== 0 }, t => {
  const f = fixture(t), bytes = readFileSync(f.path);
  assert.equal(custodyVerifier(f.path, f.source, 'verify').error.code, 'custody-verifier-custody-invalid');
  assert.equal(custodyVerifier(f.path, f.source, 'prepare').ok, true);
  const metadata = statSync(f.path);
  assert.equal(metadata.uid, 0); assert.equal(metadata.gid, 0); assert.equal(metadata.mode & 0o777, 0o555);
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(custodyVerifier(f.path, f.source, 'verify').ok, true);
  chmodSync(f.path, 0o755);
  assert.equal(custodyVerifier(f.path, f.source, 'verify').error.code, 'custody-verifier-custody-invalid');
  assert.equal(statSync(f.path).mode & 0o777, 0o755);
});
test('publication refuses substituted, symlink and unknown verifier contracts before chmod', t => {
  const f = fixture(t);
  writeFileSync(f.path, '#!/bin/sh\nexit 0\n');
  assert.equal(custodyVerifier(f.path, f.source, 'prepare').error.code, 'custody-verifier-source-invalid');
  assert.equal(statSync(f.path).mode & 0o777, 0o755);
  const link = join(f.root, 'alias'); symlinkSync(f.source, link);
  assert.equal(custodyVerifier(link, f.source, 'prepare').error.code, 'custody-verifier-file-invalid');
  assert.equal(custodyVerifier(f.path, f.source, 'unknown').error.code, 'custody-verifier-action-invalid');
});
test('Remote publication applies root555 while still in its unpublished root stage', () => {
  const lib = readFileSync(new URL('./lib', import.meta.url), 'utf8');
  const publish = lib.slice(lib.indexOf('pi_stack_publish_release()'), lib.indexOf('pi_stack_select_release()'));
  assert.ok(publish.indexOf('custody-verifier.mjs') > publish.indexOf('rsync -a'));
  assert.ok(publish.indexOf('custody-verifier.mjs') < publish.indexOf('mv -T "$root_stage" "$release"'));
});
