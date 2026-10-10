import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildHostPreflight, parseHostPreflight, buildSourcePreflight, parseSourcePreflight, nativePreflightResult } from '../deploy/publication-preflight.mjs';

const requestId = 'PUB-0123456789abcdef01234567';
const source = readFileSync(resolve('deploy/publication'), 'utf8');
const runtimeCensusScript = source.match(/const runtimeCensusScript = String.raw`([\s\S]*?)`;/)[1];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'publication-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  const bin = join(root, 'bin');
  const persons = join(root, 'persons');
  for (const dir of [repository, bin, persons]) mkdirSync(dir);
  const invoke = (command, args, extra = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 5000, ...extra });
  const git = args => {
    const result = invoke('git', ['-C', repository, ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'fixture']);
  git(['config', 'user.email', 'fixture@example.test']);
  function put(name, content) {
    mkdirSync(join(repository, name, '..'), { recursive: true });
    writeFileSync(join(repository, name), content);
  }
  function commit(message) { git(['add', '.']); git(['commit', '-qm', message]); return git(['rev-parse', 'HEAD']); }
  put('base', 'fixture');
  const base = commit('base');
  put('packages/orchestrator/src/threads/contracts.ts', 'export const THREAD_EXECUTION_CONTRACT = "unified-threads-v1";\n');
  const candidate = commit('candidate');
  const hostConfig = join(root, 'host.json');
  writeFileSync(hostConfig, '{}');
  const lock = join(root, 'host.lock');
  const reservation = `${lock}.publication`;
  writeFileSync(reservation, JSON.stringify({ requestId, integrationSha: candidate }));
  const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  command('systemctl', 'exit 0');
  command('sudo', '[ "$1" != -n ] || shift; exec "$@"');
  command('curl', 'echo "${CENSUS_ROOMS:-{\\"rooms\\":[]}}"');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_STACK_HOST_LOCK_PATH: lock,
    PI_STACK_HOST_FILE: hostConfig, PI_REMOTE_PERSONS_DIR: persons, PI_STACK_DEPLOY_NO_SUDO: '1' };
  const hostInput = { requestId, integrationSha: candidate, hostId: 'fixture', releaseRepository: repository,
    hostConfig, meetings: 'all', runtimeCensusScript: runtimeCensusScript.replace('/srv/pi/pi-remote/.pi-stack-commit', join(root, 'selected-marker')) };
  const sourceInput = { repository, integrationSha: candidate, selectedCommit: base, checkoutCommit: base,
    sourceRepository: repository, hostId: 'fixture' };
  const run = (build, input, overrides = {}) => {
    const built = build(input);
    assert.equal(built.ok, true, JSON.stringify(built));
    const result = invoke('bash', ['-s', '--', ...built.value.args], { input: built.value.script, env: { ...env, ...overrides } });
    return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { root, repository, persons, git, put, commit, base, candidate, hostInput, sourceInput, reservation, command, run, env };
}

test('host batch returns explicit stages without selecting source, fetching or changing reservation custody', t => {
  const f = fixture(t);
  const before = readFileSync(f.reservation, 'utf8');
  const result = f.run(buildHostPreflight, f.hostInput);
  const parsed = parseHostPreflight(result, f.hostInput);
  assert.equal(parsed.ok, true, JSON.stringify({ result, parsed }));
  assert.equal(parsed.value.census.checkoutCommit, f.candidate);
  assert.equal(parsed.value.meetings.status, 0);
  assert.equal(parsed.value.meetings.stdout, '');
  assert.equal(parsed.value.native.status, 0);
  assert.equal(readFileSync(f.reservation, 'utf8'), before);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.candidate);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('reservation conflicts and absence do not run observation commands', t => {
  const f = fixture(t);
  const sentinel = join(f.root, 'observed');
  f.command('systemctl', `touch '${sentinel}'; exit 0`);
  writeFileSync(f.reservation, JSON.stringify({ requestId: 'PUB-ffffffffffffffffffffffff', integrationSha: f.candidate }));
  const conflict = parseHostPreflight(f.run(buildHostPreflight, f.hostInput), f.hostInput);
  assert.equal(conflict.error.kind, 'host-lock-busy');
  assert.equal(existsSync(sentinel), false);
  rmSync(f.reservation);
  assert.equal(parseHostPreflight(f.run(buildHostPreflight, f.hostInput), f.hostInput).error.kind, 'host-reservation-unavailable');
  assert.equal(existsSync(sentinel), false);
});

test('unknown native/meeting state remains failed, override remains distinguishable from an empty census', t => {
  const f = fixture(t);
  writeFileSync(join(f.persons, 'alice.json'), JSON.stringify({ user: 'alice', port: 1234 }));
  f.command('curl', 'echo unavailable >&2; exit 28');
  writeFileSync(f.hostInput.hostConfig, '{"releasePrerequisites":"unknown"}');
  const result = parseHostPreflight(f.run(buildHostPreflight, f.hostInput), f.hostInput);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.value.meetings.status, 0);
  assert.notEqual(result.value.native.status, 0);
  const input = { ...f.hostInput, meetings: 'override' };
  assert.deepEqual(parseHostPreflight(f.run(buildHostPreflight, input), input).value.meetings, { state: 'override' });
});

test('source batch retains both exact markers and distinguishes descendant adoption from omission', t => {
  const f = fixture(t);
  let result = parseSourcePreflight(f.run(buildSourcePreflight, f.sourceInput), f.sourceInput);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.ancestry.ok, true);
  assert.equal(result.value.selectedDescendsFromCandidate, false);
  assert.equal(result.value.selectedHasContract, false);
  assert.equal(f.git(['rev-parse', `refs/pi-stack-publication/selected/${f.base}`]), f.base);
  const input = { ...f.sourceInput, integrationSha: f.base, selectedCommit: f.candidate };
  result = parseSourcePreflight(f.run(buildSourcePreflight, input), input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.ancestry.ok, false);
  assert.equal(result.value.selectedDescendsFromCandidate, true);
  assert.equal(result.value.selectedHasContract, true);
});

test('source custody fetches exact absent selected object from the explicitly declared repository', t => {
  const f = fixture(t);
  const observer = join(f.root, 'observer');
  const clone = spawnSync('git', ['clone', '-q', '--no-local', f.repository, observer], { encoding: 'utf8', timeout: 3000 });
  assert.equal(clone.status, 0, clone.stderr);
  f.put('new', 'new source');
  const selected = f.commit('later selected');
  const input = { ...f.sourceInput, repository: observer, selectedCommit: selected, checkoutCommit: null };
  const result = parseSourcePreflight(f.run(buildSourcePreflight, input), input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.selectedDescendsFromCandidate, true);
  assert.equal(result.value.ancestry.ok, false);
  const retained = spawnSync('git', ['-C', observer, 'rev-parse', `refs/pi-stack-publication/selected/${selected}`], { encoding: 'utf8', timeout: 3000 });
  assert.equal(retained.stdout.trim(), selected);
});

test('native maintenance contract errors are data, never permission or an eager rejection of descendant adoption', t => {
  const f = fixture(t);
  f.put('deploy/native-history-boundary', 'boundary');
  f.put('deploy/native-history-bridge.mjs', 'export const MAINTENANCE_INTAKE = "closed";\n');
  const closed = f.commit('closed');
  const input = { ...f.sourceInput, integrationSha: closed, selectedCommit: closed };
  const result = parseSourcePreflight(f.run(buildSourcePreflight, input), input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.selectedDescendsFromCandidate, true);
  assert.equal(result.value.nativeHistory.ok, false);
  assert.equal(result.value.nativeHistory.error.code, 'closed-intake-maintenance-forbidden');
  f.put('deploy/native-history-bridge.mjs', "export const MAINTENANCE_INTAKE = 'always-open-v1';\n");
  const open = f.commit('open');
  const openInput = { ...input, integrationSha: open };
  assert.deepEqual(parseSourcePreflight(f.run(buildSourcePreflight, openInput), openInput).value.nativeHistory, { ok: true, needed: true });
  f.git(['update-ref', 'refs/pi-stack-publication/owner-source', open]);
  assert.equal(parseSourcePreflight(f.run(buildSourcePreflight, input), input).value.nativeHistory.error.code, 'obsolete-native-maintenance-source');
});

test('only the exact native prerequisite wait marker admits a wait; unknown failures remain typed errors', () => {
  const observation = { status: 75, stdout: '', stderr: `native source prerequisite fixture requires ${'a'.repeat(40)} before Pi Stack ${'b'.repeat(40)}; selected ${'c'.repeat(40)}` };
  assert.equal(nativePreflightResult(observation, 'fixture').value.ok, false);
  assert.equal(nativePreflightResult({ ...observation, status: 0 }, 'fixture').value.ok, true);
  for (const unknown of [{ ...observation, status: 1 }, { ...observation, stderr: 'unknown failure' }, { ...observation, status: 124 }]) {
    const result = nativePreflightResult(unknown, 'fixture');
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'native-source');
    assert.equal(result.error.status, unknown.status);
  }
});

test('invalid source and incomplete or wrong identity output cannot become successful admission', t => {
  const f = fixture(t);
  assert.equal(buildHostPreflight({ ...f.hostInput, meetings: undefined }).ok, false);
  assert.equal(buildSourcePreflight({ ...f.sourceInput, selectedCommit: undefined }).ok, false);
  assert.equal(buildSourcePreflight({ ...f.sourceInput, integrationSha: 'main' }).ok, false);
  const result = f.run(buildSourcePreflight, { ...f.sourceInput, integrationSha: 'f'.repeat(40) });
  assert.equal(parseSourcePreflight(result, { ...f.sourceInput, integrationSha: 'f'.repeat(40) }).ok, false);
  assert.equal(parseHostPreflight({ ok: true, stdout: '{}' }, f.hostInput).ok, false);
  assert.equal(parseSourcePreflight({ ok: true, stdout: '{"ok":true,"value":{}}' }, f.sourceInput).ok, false);
  const good = f.run(buildSourcePreflight, f.sourceInput);
  assert.equal(parseSourcePreflight(good, { ...f.sourceInput, integrationSha: f.base }).ok, false);
});
