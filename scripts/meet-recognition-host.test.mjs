import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'meet-recognition-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  const put = (name, content) => writeFileSync(join(repo, 'deploy', name), `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`, { mode: 0o755 });
  copyFileSync(new URL('../deploy/host', import.meta.url), join(repo, 'deploy/host'));
  put('lib', `pi_stack_enter_deployment() { :; }
pi_stack_check_person_configs() { :; }
pi_stack_fleet_user() { echo fixture; }
pi_stack_users() { echo fixture; }
pi_stack_daemon_units() { :; }
pi_stack_prepare_builds() {
  for i in {1..100}; do [[ ! -f "$RECOGNITION_SELECTED" ]] || return 0; sleep 0.01; done
  echo 'Recognition was not selected during publication' >&2; return 1
}
pi_stack_as_root() { "$@"; }
pi_stack_run_as() { shift; "$@"; }`);
  for (const name of ['phone', 'native-prerequisites', 'native-history-boundary', 'one-kenan-access-release', 'runtime-doctors', 'smoke']) put(name, name === 'smoke' ? 'exit "${SMOKE_EXIT:-0}"' : ':');
  put('native-history-boundary', `[[ $1 == /* && $2 == /* && $3 =~ ^[a-f0-9]{40}$ ]] || exit 64
if [[ \${HISTORY_BOUNDARY_BUSY:-0} == 1 ]]; then
  echo 'native history boundary waiting: fixture admitted errands' >&2
  exit 75
fi`);
  put('voice', `[[ $1 != --activate ]] || {
  for i in {1..100}; do
    if [[ -f "$WARM_STARTED" ]]; then : > "$VOICE_ACTIVATED"; exit 0; fi
    sleep 0.01
  done
  exit 91
}`);
  writeFileSync(join(repo, 'deploy/capacity-ready.mjs'), 'process.exit(0);');
  put('meet-recognition', `if [[ $1 == --select ]]; then
  ln -sfn "$NEW_RECOGNITION" "$PI_STACK_MEET_RECOGNITION_DEST"
  : > "$RECOGNITION_SELECTED"
else echo retained >> "$TRACE"; fi`);
  put('meet-recognition-service', `[[ $1 != --check ]] || exit 0
: > "$WARM_STARTED"
for i in {1..100}; do
  if [[ -f "$VOICE_ACTIVATED" ]]; then
    [[ \${RECOGNITION_EXIT:-0} != 0 ]] || echo 'takeover accepted' >> "$TRACE"
    exit "\${RECOGNITION_EXIT:-0}"
  fi
  sleep 0.01
done
exit 91`);
  const component = `name=$(basename "$0")
if [[ $name == runtime ]]; then
  for i in {1..100}; do [[ ! -f "$RECOGNITION_SELECTED" ]] || break; sleep 0.01; done
  case \${RUNTIME_FAILURE:-} in exit) exit 23;; TERM) kill -TERM "$PPID"; exit 23;; esac
fi
[[ $name != settings ]] || { : > "$ACCOUNTS_DONE"; exit 0; }
key=PI_STACK_\${name^^}_DEST
destination=\${!key}
mkdir -p "$destination"
git -C "$(dirname "$0")/.." rev-parse HEAD > "$destination/.pi-stack-commit"`;
  for (const name of ['runtime', 'orchestrator', 'remote', 'tools', 'skills', 'settings']) put(name, component);
  mkdirSync(join(repo, 'packages/runtime'), { recursive: true });
  writeFileSync(join(repo, 'packages/runtime/browser-doctor.mjs'), 'process.exit(0);');
  writeFileSync(join(dir, 'bin/systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE"
case $1 in
  is-active|is-enabled) exit "\${PRIOR_STATE:-0}";;
  list-units) exit 0;;
  show)
    case $4 in
      LoadState) echo "\${OLD_WRITE_LOADED:-not-found}";;
      ActiveState) echo "\${OLD_WRITE_ACTIVE:-active}";;
      UnitFileState) echo "\${OLD_WRITE_ENABLED:-enabled}";;
    esac
    ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(dir, 'bin/curl'), '#!/bin/sh\necho \'{"people":[]}\'\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, TRACE: join(dir, 'trace'), WARM_STARTED: join(dir, 'warming'), VOICE_ACTIVATED: join(dir, 'voice-activated'), RECOGNITION_SELECTED: join(dir, 'recognition-selected'), ACCOUNTS_DONE: join(dir, 'accounts'), OLD_RECOGNITION: join(dir, 'old'), NEW_RECOGNITION: join(dir, 'new'), PI_STACK_MEET_RECOGNITION_DEST: join(dir, 'meet-recognition'), PI_STACK_SERVICES: '1', PI_STACK_ALLOW_LIVE_MEETING_RESTART: '1' };
  for (const name of ['RUNTIME', 'ORCHESTRATOR', 'REMOTE', 'TOOLS', 'SKILLS']) env[`PI_STACK_${name}_DEST`] = join(dir, name.toLowerCase());
  mkdirSync(env.OLD_RECOGNITION); mkdirSync(env.NEW_RECOGNITION);
  symlinkSync(env.OLD_RECOGNITION, env.PI_STACK_MEET_RECOGNITION_DEST);
  const doctor = join(env.PI_STACK_RUNTIME_DEST, 'node_modules/.bin');
  mkdirSync(doctor, { recursive: true });
  writeFileSync(join(doctor, 'pi-model-selection-doctor'), 'process.exit(0);');
  writeFileSync(join(dir, 'host.json'), '{"version":1}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture']]) assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  env.PI_STACK_RECOGNITION_TRANSITION_FILE = join(dir, 'speech-transition.json');
  return { env, run: extra => spawnSync('bash', [join(repo, 'deploy/host'), join(dir, 'host.json')], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 4000 }) };
}

test('native history wait precedes every host source selection and service mutation', t => {
  const f = fixture(t);
  const result = f.run({ HISTORY_BOUNDARY_BUSY: '1' });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /native history boundary waiting:/);
  assert.equal(realpathSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), f.env.OLD_RECOGNITION);
  for (const path of [f.env.RECOGNITION_SELECTED, f.env.WARM_STARTED, f.env.VOICE_ACTIVATED, f.env.TRACE, f.env.PI_STACK_RECOGNITION_TRANSITION_FILE]) {
    assert.equal(existsSync(path), false, path);
  }
});

for (const failure of [{}, { RECOGNITION_EXIT: '1' }, { SMOKE_EXIT: '1' }, { RUNTIME_FAILURE: 'exit' }, { RUNTIME_FAILURE: 'TERM' }]) test(`Recognition selection and concurrent activation restore on ${JSON.stringify(failure)}`, t => {
  const f = fixture(t);
  const result = f.run(failure);
  const failed = Object.keys(failure).length > 0;
  assert.equal(result.status, failure.RUNTIME_FAILURE === 'TERM' ? 143 : failed ? 1 : 0, result.stderr);
  assert.equal(realpathSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), failed ? f.env.OLD_RECOGNITION : f.env.NEW_RECOGNITION);
  assert.equal(existsSync(f.env.RECOGNITION_SELECTED), true);
  assert.equal(existsSync(f.env.WARM_STARTED), !failure.RUNTIME_FAILURE);
  assert.equal(existsSync(f.env.VOICE_ACTIVATED), !failure.RUNTIME_FAILURE);
  const trace = readFileSync(f.env.TRACE, 'utf8');
  if (failed) {
    assert.match(trace, /restart pi-stack-meet-recognition.service/);
    assert.doesNotMatch(trace, /retained/);
  } else {
    assert.match(trace, /retained/);
    assert.equal(existsSync(f.env.ACCOUNTS_DONE), true);
  }
});

test('failed first activation restores an inactive, disabled recognition unit without restart', t => {
  const f = fixture(t);
  rmSync(f.env.PI_STACK_MEET_RECOGNITION_DEST);
  const result = f.run({ RECOGNITION_EXIT: '1', PRIOR_STATE: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), false);
  const trace = readFileSync(f.env.TRACE, 'utf8');
  assert.match(trace, /stop pi-stack-meet-recognition.service/);
  assert.match(trace, /disable pi-stack-meet-recognition.service/);
  assert.doesNotMatch(trace, /restart pi-stack-meet-recognition.service/);
});

test('later host smoke failure restores old same-port unit after accepted recognition, with durable rollback state', t => {
  const f = fixture(t);
  const result = f.run({ SMOKE_EXIT: '1', PRIOR_STATE: '1', OLD_WRITE_LOADED: 'loaded' });
  assert.equal(result.status, 1, result.stderr);
  const trace = readFileSync(f.env.TRACE, 'utf8');
  assert.match(trace, /takeover accepted/);
  assert.match(trace, /enable pi-stack-write.service/);
  assert.match(trace, /start pi-stack-write.service/);
  assert.ok(trace.indexOf('stop pi-stack-meet-recognition.service') < trace.indexOf('start pi-stack-write.service'));
  assert.equal(realpathSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), f.env.OLD_RECOGNITION);
  const journal = JSON.parse(readFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, 'utf8'));
  assert.equal(journal.phase, 'rolled_back');
  assert.equal(journal.oldWrite.loaded, 'loaded');
  assert.equal(journal.oldWrite.active, 'active');
  assert.equal(journal.oldWrite.enabled, 'enabled');
  assert.equal(typeof journal.oldWrite.selection, 'string');
});

test('outer host success closes durable speech transition only after all release phases pass', t => {
  const f = fixture(t);
  assert.equal(f.run({ OLD_WRITE_LOADED: 'loaded' }).status, 0);
  assert.equal(JSON.parse(readFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, 'utf8')).phase, 'accepted');
});

test('unresolved interrupted transition refuses another host selection', t => {
  const f = fixture(t);
  writeFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, JSON.stringify({ version: 1, phase: 'pending' }));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unresolved speech host transition/);
  assert.equal(existsSync(f.env.RECOGNITION_SELECTED), false);
});
