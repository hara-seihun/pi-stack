import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readlinkSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hostPlan, verifyOwner, acceptOwner, ownerNeedsActivation } from '../deploy/host-plan.mjs';
import { componentCache } from '../deploy/component-cache.mjs';
import { preparedComponents } from '../deploy/prepared-components.mjs';
import { doctorKey, doctorReceipt } from '../deploy/doctor-cache.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-host-fast-'));
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', directory]); rmSync(directory, { recursive: true, force: true }); });
  const root = join(directory, 'source'); mkdirSync(root);
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  put('apps/remote/web/src/ui.ts', 'ui1'); put('packages/runtime/stack-pi.mjs', 'native1');
  put('apps/remote/server/router.ts', 'router1'); put('packages/orchestrator/src/api.ts', 'orchestrator1');
  execFileSync('git', ['init', '-q', root]);
  const commit = () => { execFileSync('git', ['-C', root, 'add', '.']); execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']); return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); };
  const host = join(directory, 'host.json'); writeFileSync(host, '{"version":1}');
  const plan = join(directory, '.pi-stack-release-plan.json');
  return { directory, root, put, commit, host, plan };
}
function accept(path) { const value = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify({ ...value, state: 'accepted' })); }

test('UI-only and identical releases keep exact source-equivalent owners; changed native source is rejected', t => {
  const f = fixture(t); const previous = f.commit();
  assert.equal(hostPlan(f.root, previous, '', f.plan, f.host).ok, true); accept(f.plan);
  f.put('apps/remote/web/src/ui.ts', 'ui2'); const candidate = f.commit();
  const start = performance.now(); const result = hostPlan(f.root, candidate, previous, f.plan, f.host);
  assert.equal(result.ok, true);
  assert.ok(Object.values(result.value.owners).every(owner => !owner.changed));
  for (const owner of Object.keys(result.value.owners)) assert.equal(verifyOwner(f.root, result.value, owner, previous).ok, true);
  accept(f.plan);
  assert.ok(Object.values(hostPlan(f.root, candidate, candidate, f.plan, f.host).value.owners).every(owner => !owner.changed));
  f.put('packages/runtime/stack-pi.mjs', 'native2'); const changed = f.commit();
  accept(f.plan); const next = hostPlan(f.root, changed, candidate, f.plan, f.host);
  assert.equal(next.value.owners.remote.changed, true);
  assert.equal(next.value.owners.root.changed, false, 'CLI launcher replacement is outside the Root process');
  assert.equal(next.value.owners.memory.changed, false, 'memory does not import the agent runtime');
  assert.equal(verifyOwner(f.root, next.value, 'remote', candidate).error.code, 'host-owner-source-stale');
  assert.equal(verifyOwner(f.root, { ...next.value, owners: { remote: { candidateKey: 'forged' } } }, 'remote', changed).error.code, 'host-plan-source-mismatch');
  console.log(`source-bound UI release plan and owner proofs: ${(performance.now() - start).toFixed(1)}ms`);
});

test('transcript and browser changes leave Root/memory serving; in-process SDK changes require only affected consumers', t => {
  const f = fixture(t); const previous = f.commit();
  hostPlan(f.root, previous, '', f.plan, f.host); accept(f.plan);
  f.put('apps/remote/server/transcript.ts', 'transcript2'); const transcript = f.commit();
  const remote = hostPlan(f.root, transcript, previous, f.plan, f.host);
  assert.equal(remote.value.owners.root.changed, false); assert.equal(remote.value.owners.memory.changed, false); assert.equal(remote.value.owners.rooms.changed, true);
  assert.equal(verifyOwner(f.root, remote.value, 'root', previous).ok, true); accept(f.plan);
  f.put('packages/runtime/patch-browser-sensitive-policy.mjs', 'browser2'); const browser = f.commit();
  const browserPlan = hostPlan(f.root, browser, transcript, f.plan, f.host);
  assert.equal(browserPlan.value.owners.root.changed, false); assert.equal(browserPlan.value.owners.memory.changed, false); accept(f.plan);
  f.put('packages/runtime/patch-anthropic-tool-schema.mjs', 'sdk2'); const sdk = f.commit();
  const sdkPlan = hostPlan(f.root, sdk, browser, f.plan, f.host);
  assert.equal(sdkPlan.value.owners.root.changed, true); assert.equal(sdkPlan.value.owners.memory.changed, false);
  assert.equal(verifyOwner(f.root, sdkPlan.value, 'root', browser).error.code, 'host-owner-source-stale');
});

test('Memory source proof follows exported timezone imports transitively and rejects unknown dynamic imports', t => {
  const f = fixture(t);
  f.put('packages/kenan-memory/src/main.ts', 'import { timezone } from "pi-orchestrator/person-timezone";');
  f.put('packages/orchestrator/package.json', JSON.stringify({ exports: { './person-timezone': { bun: './src/person-timezone.ts', default: './dist/person-timezone.js' } } }));
  f.put('packages/orchestrator/src/person-timezone.ts', 'export { timezone } from "./timezone-helper.js";');
  f.put('packages/orchestrator/src/timezone-helper.ts', 'export const timezone = "UTC";');
  const previous = f.commit(); hostPlan(f.root, previous, '', f.plan, f.host); accept(f.plan);
  f.put('packages/orchestrator/src/timezone-helper.ts', 'export const timezone = "Pacific/Auckland";'); const candidate = f.commit();
  const next = hostPlan(f.root, candidate, previous, f.plan, f.host);
  assert.equal(next.value.owners.memory.changed, true);
  assert.equal(verifyOwner(f.root, next.value, 'memory', previous).error.code, 'host-owner-source-stale');
  f.put('packages/orchestrator/src/timezone-helper.ts', 'await import(process.env.UNKNOWN_MODULE);'); const unknown = f.commit();
  assert.equal(hostPlan(f.root, unknown, candidate, f.plan, f.host).error.code, 'host-plan-unavailable');
});

test('mutable host model changes invalidate the owner plan even without a source change', t => {
  const f = fixture(t); const source = f.commit(); const models = join(f.directory, 'models.json');
  writeFileSync(models, '{"providers":{}}'); writeFileSync(f.host, JSON.stringify({ version: 1, models }));
  assert.equal(hostPlan(f.root, source, '', f.plan, f.host).ok, true); accept(f.plan);
  writeFileSync(models, '{"providers":{"new":{}}}');
  assert.ok(Object.values(hostPlan(f.root, source, source, f.plan, f.host).value.owners).every(owner => owner.changed));
});

test('Root handoff pending retains independent source-bound activation receipts across retries and successors', t => {
  const f = fixture(t); const previous = f.commit();
  hostPlan(f.root, previous, '', f.plan, f.host); accept(f.plan);
  f.put('packages/runtime/patch-anthropic-tool-schema.mjs', 'changed SDK'); const candidate = f.commit();
  const first = hostPlan(f.root, candidate, previous, f.plan, f.host);
  assert.equal(first.value.owners.daemons.changed, true); assert.equal(first.value.owners.root.changed, true);
  const invocationId = 'a'.repeat(32);
  const proof = { kind: 'activated-units', runningCommit: candidate, units: [{ unit: 'pi-orchestrator@fixture.service', state: 'active', invocationId }] };
  assert.equal(acceptOwner(f.root, f.plan, candidate, 'daemons', proof).ok, true);
  const live = () => ({ state: 'active', invocationId });
  for (let attempt = 0; attempt < 3; attempt++) {
    const retry = hostPlan(f.root, candidate, candidate, f.plan, f.host);
    assert.equal(retry.value.configurationChanged, false, 'Root pending is not host configuration mutation');
    assert.equal(ownerNeedsActivation(f.root, retry.value, 'daemons', live).value.changed, false, 'accepted daemon must not restart on Root retry');
    assert.equal(retry.value.owners.root.changed, true, 'selected candidate marker cannot prove pending Root activation');
    assert.equal(retry.value.state, 'prepared', 'partial owner receipts are not complete host acceptance');
  }
  f.put('docs/unrelated.md', 'next source'); const next = f.commit();
  const successor = hostPlan(f.root, next, candidate, f.plan, f.host);
  assert.equal(ownerNeedsActivation(f.root, successor.value, 'daemons', live).value.changed, false);
  assert.equal(successor.value.owners.root.changed, true, 'successor retains prior unaccepted owner custody');
  assert.equal(ownerNeedsActivation(f.root, successor.value, 'daemons', () => ({ state: 'active', invocationId: 'b'.repeat(32) })).value.changed, true, 'another process generation must reacquire proof');
  assert.equal(ownerNeedsActivation(f.root, successor.value, 'daemons', () => { throw new Error('systemd unavailable'); }).error.code, 'host-owner-proof-unavailable');
  assert.equal(acceptOwner(f.root, f.plan, next, 'daemons', { ...proof, runningCommit: previous }).error.code, 'host-owner-source-stale');
  assert.equal(acceptOwner(f.root, f.plan, next, 'daemons', { ...proof, units: [{ ...proof.units[0], invocationId: '' }] }).error.code, 'host-owner-proof-invalid');
  writeFileSync(f.host, '{"version":1,"packages":[],"changed":true}');
  const reconfigured = hostPlan(f.root, next, next, f.plan, f.host);
  assert.equal(reconfigured.value.owners.daemons.changed, true, 'real host changes invalidate activation custody');
  assert.equal(reconfigured.value.owners.daemons.acceptance, undefined);
});

test('component reuse changes only source metadata and pins candidate dependencies; changed artifacts cannot be recertified', t => {
  const f = fixture(t); const previous = f.commit(); const releases = join(f.directory, 'releases');
  for (const component of ['runtime', 'orchestrator', 'remote', 'tools']) {
    const directory = join(releases, component, previous); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.pi-stack-commit'), previous + '\n'); writeFileSync(join(directory, 'payload'), component);
    if (component === 'runtime') writeFileSync(join(directory, '.pi-stack-runtime-prepared.json'), JSON.stringify({ schema: 1, commit: previous, candidate: directory }));
    if (component === 'remote' || component === 'tools') {
      mkdirSync(join(directory, 'node_modules')); symlinkSync(join(releases, 'orchestrator', previous), join(directory, 'node_modules/pi-orchestrator'));
    }
    if (component === 'remote') { mkdirSync(join(directory, 'web/dist'), { recursive: true }); writeFileSync(join(directory, 'web/dist/release-revision.js'), `globalThis.__PI_STACK_RELEASE_REVISION__="${previous}";`); }
  }
  assert.equal(preparedComponents(releases, previous, 'record').ok, true);
  assert.equal(componentCache(f.root, releases, previous, 'record').ok, true);
  f.put('docs/unrelated.md', 'no runtime change'); const candidate = f.commit();
  const start = performance.now(); const reused = componentCache(f.root, releases, candidate, 'reuse');
  assert.equal(reused.ok, true, JSON.stringify(reused)); assert.ok(Object.values(reused.value.components).every(state => state === 'reused'));
  assert.equal(readFileSync(join(releases, 'remote', candidate, 'web/dist/release-revision.js'), 'utf8'), `globalThis.__PI_STACK_RELEASE_REVISION__="${candidate}";`);
  assert.equal(readlinkSync(join(releases, 'tools', candidate, 'node_modules/pi-orchestrator')), join(releases, 'orchestrator', candidate));
  assert.equal(readFileSync(join(releases, 'runtime', previous, '.pi-stack-commit'), 'utf8').trim(), previous);
  assert.equal(preparedComponents(releases, previous, 'verify').ok, true);
  assert.equal(preparedComponents(releases, candidate, 'record').ok, true);
  console.log(`four prepared components reused and rebound: ${(performance.now() - start).toFixed(1)}ms`);
  writeFileSync(join(releases, 'tools', candidate, 'payload'), 'corrupt');
  assert.equal(preparedComponents(releases, candidate, 'verify').error.code, 'prepared-artifact-changed');
});

test('doctor acceptance is bound to closure, owner settings, host additions and doctor source; no pass is invented', t => {
  const f = fixture(t); f.put('deploy/runtime-doctors', 'doctor1'); f.commit();
  const runtime = join(f.directory, 'runtime'), home = join(f.directory, 'home'), closure = join(f.directory, 'dependencies');
  mkdirSync(closure); mkdirSync(runtime); symlinkSync(closure, join(runtime, 'node_modules'));
  const packagePath = join(f.directory, 'host-package'); mkdirSync(packagePath); writeFileSync(join(packagePath, 'entry.mjs'), 'extension1');
  mkdirSync(join(home, '.pi/agent'), { recursive: true }); writeFileSync(join(home, '.pi/agent/settings.json'), JSON.stringify({ packages: [packagePath] }));
  const cache = join(f.directory, 'doctor-cache'); const key = doctorKey('browser', runtime, home, f.root);
  assert.equal(doctorReceipt(cache, key, 'verify', 'browser'), false);
  doctorReceipt(cache, key, 'record', 'browser'); assert.equal(doctorReceipt(cache, key, 'verify', 'browser'), true);
  writeFileSync(join(packagePath, 'entry.mjs'), 'extension2'); assert.notEqual(doctorKey('browser', runtime, home, f.root), key);
  writeFileSync(join(home, '.pi/agent/settings.json'), '{"packages":[]}'); assert.notEqual(doctorKey('browser', runtime, home, f.root), key);
  f.put('deploy/runtime-doctors', 'doctor2'); assert.notEqual(doctorKey('browser', runtime, home, f.root), key);
});
