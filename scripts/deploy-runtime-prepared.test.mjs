import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const commit = 'a'.repeat(40);
const dependency = 'b'.repeat(64);
const runtime = new URL('../deploy/runtime', import.meta.url);

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'runtime-prepared-'));
  const root = join(directory, 'source');
  const commands = join(directory, 'commands');
  const selected = join(directory, 'runtime');
  const releases = join(directory, 'releases');
  const candidate = join(releases, 'runtime', commit);
  const dependencies = join(directory, 'dependencies');
  const tree = join(dependencies, dependency);
  const home = join(directory, 'home');
  const log = join(directory, 'calls');
  const proof = join(candidate, '.pi-stack-runtime-prepared.json');
  function write(path, text, mode = 0o644) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, text, { mode });
  }
  function command(name, body) {
    write(join(commands, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, 0o755);
  }
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+w', directory]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(home);
  write(join(root, 'deploy/runtime'), fs.readFileSync(runtime), 0o755);
  write(join(root, 'deploy/lib'), `
pi_stack_enter_deployment() { :; }
pi_stack_as_root() { "$@"; }
pi_stack_users() { id -un; }
pi_stack_home() { printf '%s\\n' "$TEST_HOME"; }
pi_stack_require_release() { [[ $(<"$1/.pi-stack-commit") == "$2" ]]; }
pi_stack_prepare_dependencies() { echo dependency-install >> "$TEST_LOG"; exit 99; }
pi_stack_publish_release() {
  echo select >> "$TEST_LOG"
  ln -s "$2" "$3.next"
  mv -Tf "$3.next" "$3"
}
`);
  write(join(root, 'package-lock.json'), '{}');
  write(join(root, 'config/packages.json'), '{"packages":[]}');
  for (const directory of ['runtime', 'orchestrator/src', 'kenan-memory/src', 'kenan-root/src']) {
    fs.mkdirSync(join(root, 'packages', directory), { recursive: true });
  }
  for (const name of ['stack-pi.mjs', 'native-host.mjs', 'native-recovery.mjs', 'native-guardian.mjs', 'managed-agent.mjs']) {
    write(join(tree, name), '// prepared fixture\n', 0o755);
  }
  write(join(tree, 'capacity/native-session.js'), '// owner\n');
  for (const [name, output] of [['pi', '0.87.1'], ['agent-browser', 'agent-browser 1.2.3'], ['pi-agent-browser-doctor', 'ok'], ['pi-model-selection-doctor', 'ok']]) {
    write(join(tree, 'node_modules/.bin', name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, 0o755);
  }
  const old = join(directory, 'serving');
  write(join(old, 'state'), 'old agents keep serving');
  fs.symlinkSync(old, selected);
  write(join(home, '.local/bin/pi'), 'unchanged user launcher', 0o755);
  command('git', `printf '%s\\n' '${commit}'`);
  command('sha256sum', `if (( $# == 0 )); then /bin/cat >/dev/null; fi; printf '%s  fixture\\n' '${dependency}'`);
  // The lifecycle is real; expensive dependency/patch contract commands are fakes.
  command('grep', `
if [[ $* == */dist/bundle/chunks* ]]; then
  echo 'Unmanaged bundled CLI is not part of this SDK runtime' >&2
  exit 66
fi
if [[ -n \${TEST_MISSING_CONTRACT:-} && $* == *"$TEST_MISSING_CONTRACT"* ]]; then exit 1; fi
exit 0`);
  command('cmp', 'exit 0');
  command('node', `
printf '%s\\n' "$*" >> "$TEST_LOG"
if [[ $1 == --input-type=module && $2 == - && \${3:-} =~ ^(write|verify)$ ]]; then
  exec '${process.execPath}' "$@"
elif [[ $1 == -p ]]; then
  printf '%s\\n' '1.2.3'
elif [[ $1 == --test && \${TEST_PROOF_FAIL:-0} == 1 ]]; then
  exit 70
fi
`);
  const env = {
    ...process.env, PATH: `${commands}:${process.env.PATH}`,
    PI_STACK_RUNTIME_DEST: selected, PI_STACK_RELEASES_ROOT: releases,
    PI_STACK_DEPENDENCIES_ROOT: dependencies,
    TEST_HOME: home, TEST_LOG: log,
  };
  return {
    candidate, proof, selected, home, old, tree, log,
    run(mode, extra = {}) {
      return spawnSync('bash', [join(root, 'deploy/runtime'), ...mode], {
        env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
      });
    },
    calls() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''; },
    resetCalls() { fs.writeFileSync(log, ''); },
  };
}

function success(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function unchanged(f) {
  assert.equal(fs.readlinkSync(f.selected), f.old);
  assert.equal(fs.readFileSync(join(f.home, '.local/bin/pi'), 'utf8'), 'unchanged user launcher');
}

test('prepare proves and seals a candidate without selecting, linking, or cleaning live spills; activation consumes only that proof', t => {
  const f = fixture(t);
  success(f.run(['--prepare']));
  unchanged(f);
  const proof = JSON.parse(fs.readFileSync(f.proof, 'utf8'));
  assert.equal(proof.state, 'prepared');
  assert.equal(proof.commit, commit);
  assert.equal(proof.candidate, f.candidate);
  assert.equal(proof.dependencyRelease, f.tree);
  assert.equal(fs.statSync(f.candidate).mode & 0o222, 0);
  assert.equal(fs.statSync(f.proof).mode & 0o222, 0);
  assert.match(f.calls(), /--test/);
  assert.doesNotMatch(f.calls(), /select|clean-shell-spills|dependency-install/);

  f.resetCalls();
  success(f.run(['--prepare']));
  unchanged(f);
  assert.doesNotMatch(f.calls(), /--test|--check|select|clean-shell-spills|dependency-install/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.proof, 'utf8')), proof);

  f.resetCalls();
  success(f.run(['--activate-prepared']));
  assert.equal(fs.readlinkSync(f.selected), f.candidate);
  assert.equal(fs.readlinkSync(join(f.home, '.local/bin/pi')), join(f.selected, 'stack-pi.mjs'));
  assert.match(f.calls(), /^select$/m);
  assert.doesNotMatch(f.calls(), /--test|--check|clean-shell-spills|dependency-install/);
});

test('activation rejects absent and mismatched positive proof before changing any live selection', t => {
  const f = fixture(t);
  assert.equal(f.run(['--activate-prepared']).status, 66);
  unchanged(f);
  success(f.run(['--prepare']));
  fs.chmodSync(f.proof, 0o644);
  const proof = JSON.parse(fs.readFileSync(f.proof, 'utf8'));
  proof.commit = 'c'.repeat(40);
  fs.writeFileSync(f.proof, JSON.stringify(proof));
  fs.chmodSync(f.proof, 0o444);
  f.resetCalls();
  const result = f.run(['--activate-prepared']);
  assert.equal(result.status, 66, result.stderr);
  assert.match(result.stderr, /commit mismatch/);
  unchanged(f);
  assert.doesNotMatch(f.calls(), /select|--test|dependency-install/);
});

test('missing managed SDK durability refuses preparation with a named contract, leaving serving state unchanged', t => {
  const f = fixture(t);
  const result = f.run(['--prepare'], { TEST_MISSING_CONTRACT: 'replaceSessionFileDurably(this.sessionFile' });
  assert.equal(result.status, 66, result.stderr);
  assert.match(result.stderr, /runtime contract missing: durable SDK session rewrite/);
  assert.equal(fs.existsSync(f.candidate), false);
  assert.equal(fs.existsSync(f.proof), false);
  unchanged(f);
});

test('failed preparation cannot leave a selectable candidate or positive proof', t => {
  const f = fixture(t);
  const result = f.run(['--prepare'], { TEST_PROOF_FAIL: '1' });
  assert.equal(result.status, 70, result.stderr);
  assert.equal(fs.existsSync(f.candidate), false);
  assert.equal(fs.existsSync(f.proof), false);
  unchanged(f);
  assert.equal(f.run(['--activate-prepared']).status, 66);
  unchanged(f);
});
