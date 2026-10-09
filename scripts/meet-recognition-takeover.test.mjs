import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function fixture(t, old = { loaded: 'loaded', active: 'active', enabled: 'enabled' }) {
  const dir = mkdtempSync(join(tmpdir(), 'recognition-takeover-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const runtime = join(dir, 'runtime');
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(join(runtime, 'venv/bin'), { recursive: true });
  mkdirSync(join(runtime, 'model'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync(new URL('../deploy/meet-recognition-service', import.meta.url), join(repo, 'deploy/meet-recognition-service'));
  writeFileSync(join(repo, 'deploy/lib'), 'pi_stack_enter_deployment() { :; }\npi_stack_as_root() { "$@"; }\n');
  for (const file of ['ready', 'server.py', 'model/ready']) writeFileSync(join(runtime, file), 'prepared');
  writeFileSync(join(runtime, 'venv/bin/python'), `#!/usr/bin/env bash
printf '%s\n' "$2" >> "$TRACE"
case $2 in preflight) exit "\${PREFLIGHT_EXIT:-0}";; endpoint) exit "\${ENDPOINT_EXIT:-0}";; *) exit 64;; esac
`, { mode: 0o755 });
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ old, current: { loaded: 'loaded', active: 'inactive', enabled: 'disabled' } }));
  writeFileSync(join(dir, 'bin/systemctl'), `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
with Path(os.environ['TRACE']).open('a') as log: log.write(' '.join(args)+'\\n')
p=Path(os.environ['STATE']); state=json.loads(p.read_text()); unit=args[1]
record=state['old' if unit=='pi-stack-write.service' else 'current']
if args[0]=='show':
 key={'LoadState':'loaded','ActiveState':'active','UnitFileState':'enabled'}[args[3]]
 print(record[key]); sys.exit(0)
if args[0]=='is-active': sys.exit(0 if record['active']=='active' else 3)
if args[0]=='stop': record['active']='inactive'
elif args[0] in ('start','restart'): record['active']='active'
elif args[0]=='enable': record['enabled']='enabled'
elif args[0]=='disable': record['enabled']='disabled'
else: sys.exit(64)
p.write_text(json.dumps(state))
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, TRACE: join(dir, 'trace'), STATE: statePath, PI_STACK_MEET_RECOGNITION_DEST: runtime };
  return {
    run: extra => spawnSync('bash', [join(repo, 'deploy/meet-recognition-service'), '--activate'], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 4000 }),
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    trace: () => readFileSync(env.TRACE, 'utf8'),
  };
}

test('accepted takeover proves the prepared decoder before stopping old and disables old only after wire readiness', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const trace = f.trace();
  assert.ok(trace.indexOf('preflight') < trace.indexOf('stop pi-stack-write.service'));
  assert.ok(trace.indexOf('stop pi-stack-write.service') < trace.indexOf('restart pi-stack-meet-recognition.service'));
  assert.ok(trace.indexOf('endpoint') < trace.indexOf('disable pi-stack-write.service'));
  assert.deepEqual(f.state().old, { loaded: 'loaded', active: 'inactive', enabled: 'disabled' });
  assert.equal(f.state().current.active, 'active');
});

test('candidate preflight failure does not disturb the live old engine', t => {
  const f = fixture(t);
  const result = f.run({ PREFLIGHT_EXIT: '13' });
  assert.equal(result.status, 13, result.stderr);
  assert.equal(f.state().old.active, 'active');
  assert.doesNotMatch(f.trace(), /stop|restart|disable|enable/);
});

for (const enabled of ['enabled', 'disabled']) test(`wire readiness failure restores old active/${enabled} and original new inactive/disabled`, t => {
  const f = fixture(t, { loaded: 'loaded', active: 'active', enabled });
  const result = f.run({ ENDPOINT_EXIT: '13' });
  assert.equal(result.status, 13, result.stderr);
  assert.deepEqual(f.state().old, { loaded: 'loaded', active: 'active', enabled });
  assert.equal(f.state().current.active, 'inactive');
  assert.equal(f.state().current.enabled, 'disabled');
  const trace = f.trace();
  assert.ok(trace.lastIndexOf('stop pi-stack-meet-recognition.service') < trace.lastIndexOf('start pi-stack-write.service'));
});

test('unsettled old lifecycle refuses takeover before any service mutation', t => {
  const f = fixture(t, { loaded: 'loaded', active: 'activating', enabled: 'enabled' });
  assert.equal(f.run().status, 75);
  assert.doesNotMatch(f.trace(), /stop|restart|disable|enable|preflight/);
});

test('absent old product is an explicit first activation state', t => {
  const f = fixture(t, { loaded: 'not-found', active: 'inactive', enabled: 'disabled' });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(f.trace(), /(stop|disable) pi-stack-write/);
});
