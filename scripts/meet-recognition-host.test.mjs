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
  for (const name of ['prepared-components.mjs', 'host-plan.mjs', 'source-scopes.mjs', 'remote-rollback-compatible.mjs', 'release-checkout']) copyFileSync(new URL(`../deploy/${name}`, import.meta.url), join(repo, 'deploy', name));
  copyFileSync(new URL('../deploy/lib', import.meta.url), join(repo, 'deploy/release-selection-lib'));
  put('lib', `source "$(dirname "\${BASH_SOURCE[0]}")/release-selection-lib"
pi_stack_enter_deployment() { :; }
pi_stack_check_person_configs() { :; }
pi_stack_fleet_user() { echo fixture; }
pi_stack_users() { echo fixture; }
pi_stack_persons_dir() { printf '%s\\n' "$PI_REMOTE_PERSONS_DIR"; }
pi_stack_daemon_units() { :; }
pi_stack_component_releases_root() { printf '%s\\n' "$PI_STACK_RELEASES_ROOT"; }
pi_stack_as_root() { "$@"; }
pi_stack_run_as() { shift; "$@"; }`);
  put('prepare', `commit=$(git -C "$(dirname "$0")/.." rev-parse HEAD)
for name in runtime orchestrator remote tools; do
  release="$PI_STACK_RELEASES_ROOT/$name/$commit"
  mkdir -p "$release"
  printf '%s\\n' "$commit" > "$release/.pi-stack-commit"
done
printf '%s\\n' '{"version":1,"schema":"fixture-v1"}' > "$PI_STACK_RELEASES_ROOT/remote/$commit/data-contract.json"
mkdir -p "$PI_STACK_RELEASES_ROOT/runtime/$commit/node_modules/.bin"
cp "$PI_STACK_RUNTIME_DEST/node_modules/.bin/pi-model-selection-doctor" "$PI_STACK_RELEASES_ROOT/runtime/$commit/node_modules/.bin/"
node "$(dirname "$0")/prepared-components.mjs" "$PI_STACK_RELEASES_ROOT" "$commit" record
: > "$PREPARED"`);
  for (const name of ['phone', 'native-prerequisites', 'native-history-boundary', 'one-kenan-access-release', 'runtime-doctors', 'smoke']) put(name, name === 'smoke' ? 'exit "${SMOKE_EXIT:-0}"' : ':');
  put('native-history-boundary', `[[ $1 == /* && $2 == /* && $3 =~ ^[a-f0-9]{40}$ ]] || exit 64
[[ -f "$PREPARED" ]] || exit 92
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
commit=$(git -C "$(dirname "$0")/.." rev-parse HEAD)
if [[ $name == runtime ]]; then
  [[ $1 == --activate-prepared ]] || exit 64
  case \${RUNTIME_FAILURE:-} in exit) exit 23;; TERM) kill -TERM "$PPID"; exit 23;; esac
  source "$(dirname "$0")/lib"
  pi_stack_select_release "$PI_STACK_RELEASES_ROOT/runtime/$commit" "$PI_STACK_RUNTIME_DEST" "$commit"
  exit 0
fi
[[ $name != settings ]] || { : > "$ACCOUNTS_DONE"; exit 0; }
[[ \${1:-} != --links-only ]] || exit 0
key=PI_STACK_\${name^^}_DEST
destination=\${!key}
mkdir -p "$destination"
printf '%s\\n' "$commit" > "$destination/.pi-stack-commit"`;
  for (const name of ['runtime', 'orchestrator', 'remote', 'tools', 'skills', 'settings']) put(name, component);
  mkdirSync(join(repo, 'packages/runtime'), { recursive: true });
  writeFileSync(join(repo, 'packages/runtime/browser-doctor.mjs'), 'process.exit(0);');
  writeFileSync(join(dir, 'bin/systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE"
case $1 in
  is-active|is-enabled) exit "\${PRIOR_STATE:-0}";;
  list-units) exit 0;;
  show)
    if [ "$3" = -p ] && [ "$4" = ActiveState ] && [ "$5" = -p ]; then
      printf 'ActiveState=%s\\nLoadState=loaded\\nInvocationID=%s\\n' "\${OWNER_STATE:-active}" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      exit 0
    fi
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
  const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, PI_STACK_RELEASES_ROOT: join(dir, 'releases'), PREPARED: join(dir, 'prepared'), TRACE: join(dir, 'trace'), WARM_STARTED: join(dir, 'warming'), VOICE_ACTIVATED: join(dir, 'voice-activated'), RECOGNITION_SELECTED: join(dir, 'recognition-selected'), ACCOUNTS_DONE: join(dir, 'accounts'), OLD_RECOGNITION: join(dir, 'old'), NEW_RECOGNITION: join(dir, 'new'), PI_STACK_MEET_RECOGNITION_DEST: join(dir, 'meet-recognition'), PI_STACK_SERVICES: '1', PI_STACK_DEPLOY_NO_SUDO: '1', PI_STACK_ALLOW_LIVE_MEETING_RESTART: '1' };
  for (const name of ['RUNTIME', 'ORCHESTRATOR', 'REMOTE', 'TOOLS', 'SKILLS']) env[`PI_STACK_${name}_DEST`] = join(dir, name.toLowerCase());
  env.PI_REMOTE_PERSONS_DIR = join(dir, 'persons');
  mkdirSync(env.PI_REMOTE_PERSONS_DIR);
  mkdirSync(join(dir, '.pi-stack-releases'));
  mkdirSync(env.OLD_RECOGNITION); mkdirSync(env.NEW_RECOGNITION);
  symlinkSync(env.OLD_RECOGNITION, env.PI_STACK_MEET_RECOGNITION_DEST);
  const oldRuntime = join(dir, 'old-runtime');
  const doctor = join(oldRuntime, 'node_modules/.bin');
  mkdirSync(doctor, { recursive: true });
  symlinkSync(oldRuntime, env.PI_STACK_RUNTIME_DEST);
  writeFileSync(join(doctor, 'pi-model-selection-doctor'), 'process.exit(0);');
  writeFileSync(join(dir, 'host.json'), '{"version":1}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture']]) assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  const previous = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const oldRemote = join(dir, 'old-remote'); mkdirSync(oldRemote);
  env.OLD_REMOTE = oldRemote;
  writeFileSync(join(oldRemote, '.pi-stack-commit'), previous + '\n');
  writeFileSync(join(oldRemote, 'data-contract.json'), '{"version":1,"schema":"fixture-v1"}');
  symlinkSync(oldRemote, env.PI_STACK_REMOTE_DEST);
  writeFileSync(join(repo, 'release-note'), 'candidate');
  for (const args of [['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'candidate']]) assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  env.PI_STACK_RECOGNITION_TRANSITION_FILE = join(dir, 'speech-transition.json');
  return { env, run: extra => spawnSync('bash', [join(repo, 'deploy/host'), join(dir, 'host.json')], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 4000 }) };
}

test('preparation precedes native history wait without changing serving sources or services', t => {
  const f = fixture(t);
  const result = f.run({ HISTORY_BOUNDARY_BUSY: '1' });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /native history boundary waiting:/);
  assert.equal(realpathSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), f.env.OLD_RECOGNITION);
  assert.equal(existsSync(f.env.PREPARED), true);
  for (const path of [f.env.RECOGNITION_SELECTED, f.env.WARM_STARTED, f.env.VOICE_ACTIVATED]) {
    assert.equal(existsSync(path), false, path);
  }
  assert.doesNotMatch(readFileSync(f.env.TRACE, 'utf8'), /^(restart|start|stop|enable|disable) /m);
  assert.equal(JSON.parse(readFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, 'utf8')).phase, 'rolled_back');
});

test('missing recognition selection restores absence, never a pointer to its own stable name', t => {
  const f = fixture(t);
  rmSync(f.env.PI_STACK_MEET_RECOGNITION_DEST);
  const result = f.run({ PRIOR_STATE: '1', RECOGNITION_EXIT: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), false);
  assert.equal(JSON.parse(readFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, 'utf8')).previousRecognition, '');
});

test('recursive recognition selection is an explicit error before publication', t => {
  const f = fixture(t);
  rmSync(f.env.PI_STACK_MEET_RECOGNITION_DEST);
  symlinkSync(f.env.PI_STACK_MEET_RECOGNITION_DEST, f.env.PI_STACK_MEET_RECOGNITION_DEST);
  const result = f.run();
  assert.equal(result.status, 66, result.stderr);
  assert.match(result.stderr, /dangling or recursive/);
  assert.equal(existsSync(f.env.PREPARED), false);
});

for (const failure of [{}, { RECOGNITION_EXIT: '1' }, { SMOKE_EXIT: '1' }, { RUNTIME_FAILURE: 'exit' }, { RUNTIME_FAILURE: 'TERM' }]) test(`Recognition selection and concurrent activation restore on ${JSON.stringify(failure)}`, t => {
  const f = fixture(t);
  const result = f.run(failure);
  const failed = Object.keys(failure).length > 0;
  assert.equal(result.status, failure.RUNTIME_FAILURE === 'TERM' ? 143 : failure.RUNTIME_FAILURE === 'exit' ? 23 : failed ? 1 : 0, result.stderr);
  assert.equal(realpathSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), failed ? f.env.OLD_RECOGNITION : f.env.NEW_RECOGNITION);
  if (failed) assert.equal(realpathSync(f.env.PI_STACK_REMOTE_DEST), f.env.OLD_REMOTE, 'schema-compatible old Remote remains recoverable');
  assert.equal(existsSync(f.env.RECOGNITION_SELECTED), !failure.RUNTIME_FAILURE);
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
  const result = f.run({ OLD_WRITE_LOADED: 'loaded' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, 'utf8')).phase, 'accepted');
  const plan = JSON.parse(readFileSync(join(f.env.PI_STACK_RUNTIME_DEST, '..', '.pi-stack-release-plan.json'), 'utf8'));
  assert.equal(plan.state, 'accepted');
  for (const owner of ['router', 'voice', 'phone']) {
    const proof = plan.owners[owner].acceptance;
    assert.equal(proof.sourceKey, plan.owners[owner].candidateKey);
    assert.equal(proof.hostKey, plan.hostKey);
    assert.equal(proof.proof.runningCommit, plan.candidate);
    assert.equal(proof.proof.units.length, 1);
    assert.equal(proof.proof.units[0].state, 'active');
    assert.equal(proof.proof.units[0].invocationId, 'a'.repeat(32));
  }
});

test('first populated Remote transition retains an immutable rollback target rather than self-linking', t => {
  const f = fixture(t);
  rmSync(f.env.PI_STACK_REMOTE_DEST);
  mkdirSync(f.env.PI_STACK_REMOTE_DEST);
  for (const name of ['.pi-stack-commit', 'data-contract.json']) copyFileSync(join(f.env.OLD_REMOTE, name), join(f.env.PI_STACK_REMOTE_DEST, name));
  const previous = readFileSync(join(f.env.OLD_REMOTE, '.pi-stack-commit'), 'utf8').trim();
  const result = f.run({ SMOKE_EXIT: '1' });
  assert.equal(result.status, 1, result.stderr);
  const retained = join(f.env.PI_STACK_RELEASES_ROOT, 'remote', previous);
  assert.equal(realpathSync(f.env.PI_STACK_REMOTE_DEST), retained);
  assert.notEqual(retained, f.env.PI_STACK_REMOTE_DEST);
  assert.equal(readFileSync(join(retained, '.pi-stack-commit'), 'utf8').trim(), previous);
  assert.equal(realpathSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), f.env.OLD_RECOGNITION);
});

test('unknown owner activation state refuses host acceptance and retains recognition rollback', t => {
  const f = fixture(t);
  const result = f.run({ OWNER_STATE: 'unknown' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no positive activation proof/);
  assert.equal(realpathSync(f.env.PI_STACK_MEET_RECOGNITION_DEST), f.env.OLD_RECOGNITION);
  assert.equal(realpathSync(f.env.PI_STACK_REMOTE_DEST), f.env.OLD_REMOTE);
  const plan = JSON.parse(readFileSync(join(f.env.PI_STACK_RUNTIME_DEST, '..', '.pi-stack-release-plan.json'), 'utf8'));
  assert.equal(plan.state, 'prepared');
  assert.equal(plan.owners.router.acceptance, undefined);
  assert.equal(JSON.parse(readFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, 'utf8')).phase, 'rolled_back');
});

test('unresolved interrupted transition refuses another host selection', t => {
  const f = fixture(t);
  writeFileSync(f.env.PI_STACK_RECOGNITION_TRANSITION_FILE, JSON.stringify({ version: 1, phase: 'pending' }));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unresolved speech host transition/);
  assert.equal(existsSync(f.env.RECOGNITION_SELECTED), false);
});
