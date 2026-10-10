import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { preparedComponents } from '../deploy/prepared-components.mjs';

const commit = 'a'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prepared-components-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const component of ['runtime', 'orchestrator', 'remote', 'tools']) {
    const directory = join(root, component, commit);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.pi-stack-commit'), commit + '\n');
    writeFileSync(join(directory, 'artifact'), component);
  }
  return root;
}
test('preparation proofs retain exact candidates and reject missing or changed artifacts', t => {
  const root = fixture(t);
  assert.equal(preparedComponents(root, commit, 'verify').ok, false);
  assert.equal(preparedComponents(root, commit, 'record').ok, true);
  assert.equal(preparedComponents(root, commit, 'verify').ok, true);
  writeFileSync(join(root, 'remote', commit, 'artifact'), 'corrupt');
  assert.equal(preparedComponents(root, commit, 'verify').error.code, 'prepared-artifact-changed');
  assert.equal(preparedComponents(root, 'unset', 'record').error.code, 'prepared-input-invalid');
});
test('record is immutable: identical preparation reuses custody and changed bytes require a new source generation', t => {
  const root = fixture(t);
  const recorded = preparedComponents(root, commit, 'record');
  assert.equal(recorded.ok, true);
  const receipt = recorded.value.receipt;
  const original = readFileSync(receipt, 'utf8');
  assert.equal(preparedComponents(root, commit, 'record').ok, true);
  writeFileSync(join(root, 'remote', commit, 'artifact'), 'retained phone repair');
  assert.equal(preparedComponents(root, commit, 'record').error.code, 'prepared-artifact-changed');
  assert.equal(readFileSync(receipt, 'utf8'), original, 'record must not recertify modified bytes under the old source');
  assert.equal(preparedComponents(root, commit, 'verify').error.code, 'prepared-artifact-changed');

  const next = 'b'.repeat(40);
  for (const component of ['runtime', 'orchestrator', 'remote', 'tools']) {
    const directory = join(root, component, next);
    mkdirSync(directory);
    writeFileSync(join(directory, '.pi-stack-commit'), next + '\n');
    copyFileSync(join(root, component, commit, 'artifact'), join(directory, 'artifact'));
  }
  assert.equal(preparedComponents(root, next, 'record').ok, true);
  assert.equal(preparedComponents(root, next, 'verify').ok, true);
  assert.equal(readFileSync(receipt, 'utf8'), original);
});
test('scratch publication and final selection are separate effects', t => {
  const root = fixture(t);
  const stage = join(root, 'stage'); mkdirSync(stage);
  writeFileSync(join(stage, '.pi-stack-commit'), commit + '\n');
  const live = join(root, 'live'); const old = join(root, 'old'); mkdirSync(old);
  writeFileSync(join(old, '.pi-stack-commit'), 'b'.repeat(40) + '\n'); symlinkSync(old, live);
  const script = `set -euo pipefail
source "$1/deploy/lib"
pi_stack_as_root() { "$@"; }
pi_stack_select_release "$2/remote/$3" "$2/scratch" "$3"
[[ $(readlink -f "$2/live") == "$2/old" ]]
pi_stack_select_release "$2/remote/$3" "$2/live" "$3"
[[ $(readlink -f "$2/live") == "$2/remote/$3" ]]
`;
  const result = spawnSync('bash', ['-c', script, 'fixture', new URL('..', import.meta.url).pathname, root, commit], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(old, '.pi-stack-commit'), 'utf8').trim(), 'b'.repeat(40));
});
