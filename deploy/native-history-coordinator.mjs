import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, readlinkSync, symlinkSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, bridgeSocket, BRIDGE_PROTOCOL } from './native-history-bridge.mjs';

export function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15000, ...options });
  if (result.status !== 0) throw new Error(`${binary} ${args[0]}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return result.stdout.trim();
}
export function selectPointer(path, target) {
  const temporary = `${path}.native-history.${process.pid}`;
  symlinkSync(target, temporary); renameSync(temporary, path);
}
function marker(path) {
  const value = readFileSync(join(path, '.pi-stack-commit'), 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`Selected source has no immutable identity: ${path}`);
  return value;
}
function links(source, target, skipped) {
  mkdirSync(target, { recursive: true }); chmodSync(target, 0o755);
  for (const name of readdirSync(source)) if (!skipped.includes(name)) {
    const path = join(target, name), expected = join(source, name);
    try { symlinkSync(expected, path); }
    catch (error) { if (error.code !== 'EEXIST' || readlinkSync(path) !== expected) throw error; }
  }
}
export function stageRemote(legacy, target, manifest) {
  links(legacy, target, ['server']); links(join(legacy, 'server'), join(target, 'server'), ['main.ts', 'rooms-main.ts']);
  writeFileSync(join(target, 'server/main.ts'), `import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url';
const m=JSON.parse(readFileSync(${JSON.stringify(manifest)},'utf8'));
const c=JSON.parse(readFileSync(process.env.PI_REMOTE_CONFIG,'utf8'));
const dataDir=process.env.PI_REMOTE_DATA??c.environment.PI_REMOTE_DATA;
const {installLegacyMaintenance}=await import(pathToFileURL(m.bridgeModule).href);
if(await installLegacyMaintenance({...m,dataDir,oldApi:m.legacyRemote+'/node_modules/pi-orchestrator/src/api.ts'})) await import(pathToFileURL(m.legacyRemote+'/server/main.ts').href);
`, { mode: 0o644 });
  if (existsSync(join(legacy, 'server/rooms-main.ts'))) writeFileSync(join(target, 'server/rooms-main.ts'), `import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url';
const m=JSON.parse(readFileSync(${JSON.stringify(manifest)},'utf8'));
const c=JSON.parse(readFileSync(process.env.PI_REMOTE_CONFIG??'/etc/pi-stack/rooms.json','utf8'));
const dataDir=process.env.PI_REMOTE_DATA??c.environment.PI_REMOTE_DATA;
const {installLegacyMaintenance}=await import(pathToFileURL(m.bridgeModule).href);
if(await installLegacyMaintenance({...m,dataDir,oldApi:m.legacyRemote+'/node_modules/pi-orchestrator/src/api.ts'})) await import(pathToFileURL(m.legacyRemote+'/server/rooms-main.ts').href);
`, { mode: 0o644 });
}
export function stageFleet(legacy, target, manifest) {
  links(legacy, target, ['dist']); links(join(legacy, 'dist'), join(target, 'dist'), ['cli.js']);
  writeFileSync(join(target, 'dist/cli.js'), `import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url'; import {dirname,join} from 'node:path';
const m=JSON.parse(readFileSync(${JSON.stringify(manifest)},'utf8'));
const dataDir=dirname(process.env.PI_ORCHESTRATOR_LEDGER??join(process.env.HOME,'.local/share/pi-orchestrator/ledger.sqlite3'));
const {installLegacyMaintenance}=await import(pathToFileURL(m.bridgeModule).href);
if(await installLegacyMaintenance({...m,dataDir,mode:'fleet',ledgerPath:process.env.PI_ORCHESTRATOR_LEDGER??join(process.env.HOME,'.local/share/pi-orchestrator/ledger.sqlite3'),oldApi:m.legacyOrchestrator+'/dist/api.js'})) await import(pathToFileURL(m.legacyOrchestrator+'/dist/cli.js').href);
`, { mode: 0o644 });
}
function owner(user, dataDir, unit, mode) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || typeof dataDir !== 'string' || !dataDir.startsWith('/')) throw new Error('Invalid native history owner configuration');
  const uid = Number(command('id', ['-u', user]));
  if (!Number.isSafeInteger(uid)) throw new Error('Invalid native history owner UID');
  return { user, uid, dataDir, unit, mode, socket: bridgeSocket(uid, dataDir) };
}
function ownerStatus(item, method = 'GET', path = '/status') {
  const pid = command('systemctl', ['show', item.unit, '-p', 'MainPID', '--value']);
  if (!/^[1-9][0-9]*$/.test(pid)) return { available: false, error: 'Owning namespace launcher is not active' };
  const result = spawnSync('nsenter', ['--target', pid, '--mount', '--', 'runuser', '-u', item.user, '--', 'curl', '-sS', '--max-time', '5', '--unix-socket', item.socket, '-X', method, `http://localhost${path}`], { encoding: 'utf8', timeout: 7000 });
  if (result.status !== 0) return { available: false, error: result.stderr?.trim() ?? result.error?.message ?? 'Maintenance controller not yet available' };
  const value = JSON.parse(result.stdout);
  if (value.protocol !== BRIDGE_PROTOCOL || value.uid !== item.uid || value.dataDir !== resolve(item.dataDir)) throw new Error(`Maintenance owner identity mismatch: ${item.user}`);
  return { available: true, value };
}
function fleetAdmission(item, root, identity, action = 'prepare') {
  const pid = command('systemctl', ['show', item.unit, '-p', 'MainPID', '--value']);
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('Fleet admission owner namespace is unavailable');
  if (typeof item.ledgerPath !== 'string' || !item.ledgerPath.startsWith('/')) throw new Error('Fleet admission requires its exact ledger path');
  const result = command('nsenter', ['--target', pid, '--mount', '--', 'runuser', '-u', item.user, '--', '/usr/local/bin/node', '--input-type=module', '-e',
    `const {legacyFleetLedger}=await import(process.argv[1]); console.log(JSON.stringify(await legacyFleetLedger(process.argv[2],JSON.parse(process.argv[3]),process.argv[4])));`,
    join(root, 'deploy/native-history-bridge.mjs'), item.ledgerPath, JSON.stringify(identity), action]);
  const value = JSON.parse(result);
  if (action === 'restore' && value.ready !== true) throw new Error('Fleet admission fence restoration remains pending');
  return value;
}
export function allOwnersReady(owners) { return owners.every(item => item.available && (item.value.phase === 'migrated' || item.value.ready === true)); }

export async function boundary({ hostFile, root, candidate, mode = 'advance', stateRoot = '/srv/pi/.pi-stack-maintenance/native-history', remotePointer = '/srv/pi/pi-remote', orchestratorPointer = '/srv/pi/pi-orchestrator', personsDir = '/var/lib/pi-remote/persons' }) {
  if (process.getuid() !== 0) throw new Error('Native history boundary requires the host deployment administrator');
  if (!/^[0-9a-f]{40}$/.test(candidate)) throw new Error('Invalid native history candidate');
  const stateDir = join(stateRoot, candidate), statePath = join(stateDir, 'state.json');
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const rootBoundary = action => {
    const host = JSON.parse(readFileSync(hostFile, 'utf8'));
    if (host.oneKenan !== true) return { ready: true, state: 'disabled' };
    const script = join(root, 'deploy/native-history-root-boundary');
    if (!existsSync(script)) throw new Error('Root native history maintenance adapter is missing from this source bundle');
    const result = spawnSync('/usr/bin/python3', [script, hostFile, candidate, ...(action ? [action] : [])], { encoding: 'utf8', timeout: 35000 });
    if (result.status === 75 && result.stderr.includes('native history boundary waiting:')) return { ready: false, state: 'root-busy', reason: result.stderr.trim() };
    if (result.status !== 0) throw new Error(`Root native history boundary failed: ${result.error?.message ?? result.stderr}`);
    const value = JSON.parse(result.stdout);
    if (value.ready !== true) throw new Error('Root native history adapter returned an invalid readiness proof');
    if (action === undefined && !((value.state === 'gated-idle' && value.admissionGated === true)
      || (value.state === 'inactive' && value.escapedNativeProcesses === 0) || value.state === 'not-enabled')) {
      throw new Error('Root native history migration requires an actual admission gate or absent native producer');
    }
    return value;
  };
  if (!state) {
    const selected = realpathSync(remotePointer);
    if (!existsSync(join(selected, 'server/context-mirror.ts'))) return { ready: true, state: 'native-source' };
    if (mode === 'probe') return { ready: false, state: 'legacy-owner', reason: 'Old source requires maintenance adoption' };
    if (mode === 'restore') return { ready: true, state: 'absent' };
    const host = JSON.parse(readFileSync(hostFile, 'utf8'));
    const legacyOrchestrator = realpathSync(orchestratorPointer), legacySource = marker(selected);
    const owners = [];
    if (existsSync(personsDir)) for (const file of readdirSync(personsDir).filter(name => name.endsWith('.json'))) {
      const person = JSON.parse(readFileSync(join(personsDir, file), 'utf8'));
      const unit = `pi-remote@${person.user}.service`;
      const active = spawnSync('systemctl', ['is-active', '--quiet', unit]).status === 0;
      if (active) owners.push(owner(person.user, person.environment.PI_REMOTE_DATA, unit, 'remote'));
    }
    if (host.oneKenan === true && spawnSync('systemctl', ['is-active', '--quiet', 'pi-rooms.service']).status === 0) {
      const configured = command('systemctl', ['show', 'pi-rooms.service', '-p', 'User', '--value']);
      const user = command('getent', ['passwd', configured]).split(':')[0];
      const config = JSON.parse(readFileSync('/etc/pi-stack/rooms.json', 'utf8'));
      owners.push(owner(user, config.environment.PI_REMOTE_DATA, 'pi-rooms.service', 'rooms'));
    }
    if (host.fleetUser) {
      const unit = `pi-orchestrator@${host.fleetUser}.service`;
      if (spawnSync('systemctl', ['is-active', '--quiet', unit]).status === 0) {
        const pid = command('systemctl', ['show', unit, '-p', 'MainPID', '--value']);
        const environment = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const get = name => environment.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
        const home = get('HOME'); if (!home) throw new Error('Fleet owner has no HOME custody');
        const ledgerPath = get('PI_ORCHESTRATOR_LEDGER') ?? join(home, '.local/share/pi-orchestrator/ledger.sqlite3');
        owners.push({ ...owner(host.fleetUser, dirname(ledgerPath), unit, 'fleet'), ledgerPath });
      }
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o755 }); chmodSync(stateDir, 0o755);
    const manifestPath = join(stateDir, 'legacy.json');
    if (marker(legacyOrchestrator) !== legacySource) throw new Error('Selected Remote and Orchestrator source identities differ before maintenance');
    const manifest = { version: 1, candidate, legacySource, legacyRemote: selected, legacyOrchestrator, bridgeModule: join(root, 'deploy/native-history-bridge.mjs'), migrator: join(root, 'scripts/migrate-native-history.mjs'), node: '/usr/local/bin/node' };
    atomicJson(manifestPath, manifest); command('chmod', ['644', manifestPath]);
    state = { version: 1, protocol: BRIDGE_PROTOCOL, candidate, legacySource, legacyRemote: selected, legacyOrchestrator, remotePointer, orchestratorPointer, remoteStage: join(stateDir, 'remote'), fleetStage: join(stateDir, 'orchestrator'), manifestPath, owners, prerequisites: host.nativeHistoryPrerequisites, phase: 'planned', adopted: [], createdAt: new Date().toISOString() };
    atomicJson(statePath, state);
  }
  if (state.candidate !== candidate || state.protocol !== BRIDGE_PROTOCOL) throw new Error('Native history boundary custody mismatch');
  if (mode === 'restore') {
    if (state.phase === 'restored') return { ready: true, state: 'restored' };
    if (realpathSync(remotePointer) !== state.remoteStage && !existsSync(join(realpathSync(remotePointer), 'server/context-mirror.ts'))
      && marker(realpathSync(remotePointer)) !== state.legacySource) {
      const selected = marker(realpathSync(remotePointer));
      for (const item of state.owners) if (item.mode !== 'fleet') {
        const config = JSON.parse(readFileSync(item.mode === 'rooms' ? '/etc/pi-stack/rooms.json' : join(personsDir, `${item.user}.json`), 'utf8'));
        const port = Number(config.port ?? config.environment.PI_REMOTE_PORT);
        if (!Number.isSafeInteger(port) || port <= 0 || port >= 65536) throw new Error('Selected supervisor has no health endpoint');
        const health = JSON.parse(command('runuser', ['-u', item.user, '--', 'curl', '-fsS', '--max-time', '2', `http://127.0.0.1:${port}/v1/health`]));
        if (health.releaseCommit !== selected) throw new Error('Candidate source is selected but has not acquired serving custody');
      }
      if (state.rootBoundary === 'restore-required') rootBoundary('--restore');
      state.phase = 'released'; atomicJson(statePath, state); return { ready: true, state: 'candidate-selected' };
    }
    const statuses = state.owners.map(item => ownerStatus(item));
    if (statuses.some(item => item.available && ['closing','migrated','owners-closed','migration-pending'].includes(item.value.phase)) || state.phase === 'ready') throw new Error('Native history is already preserved/migrated; prior capture source restoration is not allowed. Resume the candidate.');
    if (state.rootBoundary === 'restore-required') rootBoundary('--restore');
    for (const item of state.owners) {
      if (item.mode === 'fleet' && !state.adopted.includes(item.unit)) {
        fleetAdmission(item, root, { candidate, legacySource: state.legacySource }, 'restore'); continue;
      }
      const status = ownerStatus(item, 'POST', '/restore');
      if ((!status.available && state.adopted.includes(item.unit)) || (status.available && (status.value.error || status.value.phase !== 'restored'))) throw new Error(`Cannot restore admission for ${item.unit}: ${status.value?.error ?? status.error ?? 'owner did not acknowledge restoration'}`);
    }
    if (realpathSync(remotePointer) === state.remoteStage) selectPointer(remotePointer, state.legacyRemote);
    if (realpathSync(orchestratorPointer) === state.fleetStage) selectPointer(orchestratorPointer, state.legacyOrchestrator);
    for (const item of state.owners) if (state.adopted.includes(item.unit)) command('systemctl', [item.mode === 'fleet' ? 'restart' : 'reload', item.unit]);
    state.phase = 'restored'; atomicJson(statePath, state); return { ready: true, state: 'restored' };
  }
  if (state.phase === 'ready' || state.phase === 'released') return { ready: true, state: state.phase };
  if (mode === 'probe' && state.phase === 'planned') {
    for (const item of state.owners) if (item.mode === 'fleet') {
      const admission = fleetAdmission(item, root, { candidate, legacySource: state.legacySource }, 'probe');
      if (admission.ready !== true) return { ready: false, state: 'fleet-completions', reason: 'Accepted old fleet completions are still running', pendingCompletions: admission.pendingCompletions };
    }
    return { ready: true, state: 'awaiting-adoption', reason: 'The publication can adopt the preserved old native owners' };
  }
  if (mode !== 'probe') {
    if (state.phase === 'restored') throw new Error('Restored native history attempt needs a new publication identity');
    // The old daemon aborts tool-free providers on restart. Fence fresh ledger
    // admission first, then let every already accepted completion finish naturally.
    for (const item of state.owners) if (item.mode === 'fleet' && !state.adopted.includes(item.unit)) {
      const admission = fleetAdmission(item, root, { candidate, legacySource: state.legacySource });
      if (admission.ready !== true) return { ready: false, state: 'fleet-completions', reason: 'Accepted old fleet completions must settle before controller adoption', pendingCompletions: admission.pendingCompletions };
    }
    stageRemote(state.legacyRemote, state.remoteStage, state.manifestPath);
    stageFleet(state.legacyOrchestrator, state.fleetStage, state.manifestPath);
    if (state.phase === 'planned') {
      // Only transient OLD-source wrappers are selected. Candidate artifacts have not changed.
      selectPointer(remotePointer, state.remoteStage); selectPointer(orchestratorPointer, state.fleetStage);
      state.phase = 'adopting'; atomicJson(statePath, state);
    }
    for (const item of state.owners) if (!state.adopted.includes(item.unit)) {
      command('systemctl', [item.mode === 'fleet' ? 'restart' : 'reload', '--no-block', item.unit]);
      state.adopted.push(item.unit); atomicJson(statePath, state);
    }
  }
  const statuses = state.owners.map(item => ownerStatus(item));
  for (const item of statuses) if (item.available) {
    if (item.value.candidate !== state.candidate || item.value.legacySource !== state.legacySource) throw new Error('Maintenance controller selected a different source');
    if (item.value.error) throw new Error(`Private native history maintenance failed: ${item.value.error}`);
  }
  if (!allOwnersReady(statuses)) return { ready: false, state: state.phase, owners: statuses, reason: 'Old accepted work or output remains with its legacy owner' };
  if (mode !== 'probe') { state.rootBoundary = 'restore-required'; atomicJson(statePath, state); }
  const privileged = rootBoundary(mode === 'probe' ? '--probe' : undefined);
  if (!privileged.ready) return privileged;
  if (mode === 'probe') return { ready: true, state: 'drained', reason: 'Owners are drained; the publication can perform close/migration' };
  for (const item of state.owners) {
    const status = ownerStatus(item);
    if (status.value.phase !== 'migrated') {
      const closed = ownerStatus(item, 'POST', '/close');
      if (!closed.available || closed.value.phase !== 'migrated') return { ready: false, state: 'closing', reason: 'Old owner closure/private migration is acknowledged and still settling' };
    }
  }
  // A final invocation observes the restart-safe owner receipts after old DB closure/migration.
  const complete = state.owners.map(item => ownerStatus(item));
  if (!complete.every(item => item.available && item.value.phase === 'migrated')) return { ready: false, state: 'migrating', reason: 'Private native history migration is pending' };
  if (state.prerequisites !== undefined) {
    if (typeof state.prerequisites !== 'string' || !state.prerequisites.startsWith('/')) throw new Error('Native history prerequisites must name an explicit absolute executable');
    const info = statSync(state.prerequisites);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) || !(info.mode & 0o111)) throw new Error('Native history prerequisite source is not a trusted executable');
    state.phase = 'prerequisites-pending'; atomicJson(statePath, state);
    const result = spawnSync(state.prerequisites, [hostFile, candidate], { encoding: 'utf8', timeout: 45000 });
    if (result.status === 75) return { ready: false, state: state.phase, reason: 'Native history owner prerequisites remain pending' };
    if (result.status !== 0) throw new Error(`Native history prerequisites failed: ${result.error?.message ?? result.stderr}`);
    const accepted = JSON.parse(result.stdout);
    if (accepted.ready !== true || accepted.candidate !== candidate || accepted.applicationStarted !== false) throw new Error('Native history prerequisite receipt is not bound to this no-application-start boundary');
    state.prerequisitesAccepted = true;
  }
  state.phase = 'ready'; atomicJson(statePath, state); return { ready: true, state: 'ready' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [hostFile, root, candidate, flag] = process.argv.slice(2);
  const mode = flag === undefined ? 'advance' : flag === '--probe' ? 'probe' : flag === '--restore' ? 'restore' : null;
  if (!mode) { console.error('Invalid native history boundary action'); process.exitCode = 64; }
  else {
    try { const result = await boundary({ hostFile, root, candidate, mode, ...(process.env.PI_NATIVE_HISTORY_STATE_ROOT ? { stateRoot: process.env.PI_NATIVE_HISTORY_STATE_ROOT } : {}) });
      console.log(JSON.stringify(result));
      if (!result.ready) { console.error(`native history boundary waiting: ${result.reason}`); process.exitCode = 75; }
    } catch (error) { console.error(`native history boundary error: ${error.message}`); process.exitCode = 1; }
  }
}
