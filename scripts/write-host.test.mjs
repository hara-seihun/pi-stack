import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'write-host-'));
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
  for i in {1..100}; do [[ ! -f "$WARM_STARTED" ]] || return 0; sleep 0.01; done
  echo 'Write did not warm concurrently with builds' >&2; return 1
}
pi_stack_as_root() { "$@"; }
pi_stack_run_as() { shift; "$@"; }`);
  for (const name of ['voice', 'phone', 'native-prerequisites', 'one-kenan-access-release', 'smoke']) put(name, name === 'smoke' ? 'exit "${SMOKE_EXIT:-0}"' : ':');
  put('write-engine', `if [[ $1 == --select ]]; then ln -sfn "$NEW_WRITE" "$PI_STACK_WRITE_ENGINE_DEST"; else echo retained >> "$TRACE"; fi`);
  put('write-service', `[[ $1 != --check ]] || exit 0
: > "$WARM_STARTED"
for i in {1..100}; do
  if [[ -f "$ACCOUNTS_DONE" ]]; then exit "\${WRITE_EXIT:-0}"; fi
  sleep 0.01
done
exit 91`);
  const component = `name=$(basename "$0")
if [[ $name == runtime ]]; then
  for i in {1..100}; do [[ ! -f "$WARM_STARTED" ]] || break; sleep 0.01; done
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
case $1 in is-active|is-enabled) exit "\${PRIOR_STATE:-0}";; list-units) exit 0;; esac
exit 0
`, { mode: 0o755 });
  // No live Remote selection: the unchanged marker check is satisfied through an empty router census.
  writeFileSync(join(dir, 'bin/curl'), '#!/bin/sh\necho \'{"people":[]}\'\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, TRACE: join(dir, 'trace'), WARM_STARTED: join(dir, 'warming'), ACCOUNTS_DONE: join(dir, 'accounts'), OLD_WRITE: join(dir, 'old'), NEW_WRITE: join(dir, 'new'), PI_STACK_WRITE_ENGINE_DEST: join(dir, 'write-engine'), PI_STACK_SERVICES: '1', PI_STACK_ALLOW_LIVE_MEETING_RESTART: '1' };
  for (const name of ['RUNTIME', 'ORCHESTRATOR', 'REMOTE', 'TOOLS', 'SKILLS']) env[`PI_STACK_${name}_DEST`] = join(dir, name.toLowerCase());
  mkdirSync(env.OLD_WRITE); mkdirSync(env.NEW_WRITE);
  symlinkSync(env.OLD_WRITE, env.PI_STACK_WRITE_ENGINE_DEST);
  const doctor = join(env.PI_STACK_RUNTIME_DEST, 'node_modules/.bin');
  mkdirSync(doctor, { recursive: true });
  writeFileSync(join(doctor, 'pi-model-selection-doctor'), 'process.exit(0);');
  writeFileSync(join(dir, 'host.json'), '{"version":1}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture']]) assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  return { env, run: extra => spawnSync('bash', [join(repo, 'deploy/host'), join(dir, 'host.json')], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 4000 }) };
}

for (const failure of [{}, { WRITE_EXIT: '1' }, { SMOKE_EXIT: '1' }, { RUNTIME_FAILURE: 'exit' }, { RUNTIME_FAILURE: 'TERM' }]) test(`Write release overlaps warmup and restores on ${JSON.stringify(failure)}`, t => {
  const f = fixture(t);
  const result = f.run(failure);
  const failed = Object.keys(failure).length > 0;
  assert.equal(result.status, failure.RUNTIME_FAILURE === 'TERM' ? 143 : failed ? 1 : 0, result.stderr);
  assert.equal(realpathSync(f.env.PI_STACK_WRITE_ENGINE_DEST), failed ? f.env.OLD_WRITE : f.env.NEW_WRITE);
  assert.equal(existsSync(f.env.WARM_STARTED), true);
  const trace = readFileSync(f.env.TRACE, 'utf8');
  if (failed) {
    assert.match(trace, /restart --no-block pi-stack-write.service/);
    assert.doesNotMatch(trace, /retained/);
  } else {
    assert.match(trace, /retained/);
    assert.equal(existsSync(f.env.ACCOUNTS_DONE), true);
  }
});

test('failed first activation restores an inactive, disabled Write unit without queuing a restart', t => {
  const f = fixture(t);
  rmSync(f.env.PI_STACK_WRITE_ENGINE_DEST);
  const result = f.run({ WRITE_EXIT: '1', PRIOR_STATE: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(f.env.PI_STACK_WRITE_ENGINE_DEST), false);
  const trace = readFileSync(f.env.TRACE, 'utf8');
  assert.match(trace, /stop --no-block pi-stack-write.service/);
  assert.match(trace, /disable pi-stack-write.service/);
  assert.doesNotMatch(trace, /restart --no-block/);
});
