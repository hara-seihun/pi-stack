import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, readlinkSync, symlinkSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, bridgeSocket, BRIDGE_PROTOCOL, MAINTENANCE_INTAKE } from './native-history-bridge.mjs';
import { stageLegacyRemoteIdentity } from './native-history-package-identity.mjs';
import { recoverClosedOwner } from './native-history-owner-recovery.mjs';

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
  links(legacy, target, ['server']); links(join(legacy, 'server'), join(target, 'server'), ['main.ts', 'rooms-main.ts', 'server.ts']);
  const stagedIdentity = stageLegacyRemoteIdentity(legacy, target, marker(legacy));
  writeFileSync(join(target, 'server/main.ts'), `import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url';
const m=JSON.parse(readFileSync(${JSON.stringify(manifest)},'utf8'));
const c=JSON.parse(readFileSync(process.env.PI_REMOTE_CONFIG,'utf8'));
const dataDir=process.env.PI_REMOTE_DATA??c.environment.PI_REMOTE_DATA;
const {installLegacyMaintenance}=await import(pathToFileURL(m.bridgeModule).href);
if(await installLegacyMaintenance({...m,dataDir,mode:'remote',oldApi:m.legacyRemote+'/node_modules/pi-orchestrator/src/api.ts'})) await import(pathToFileURL(${JSON.stringify(stagedIdentity.mainPath)}).href);
`, { mode: 0o644 });
  if (existsSync(join(legacy, 'server/rooms-main.ts'))) writeFileSync(join(target, 'server/rooms-main.ts'), `import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url';
const m=JSON.parse(readFileSync(${JSON.stringify(manifest)},'utf8'));
const c=JSON.parse(readFileSync(process.env.PI_REMOTE_CONFIG??'/etc/pi-stack/rooms.json','utf8'));
const dataDir=process.env.PI_REMOTE_DATA??c.environment.PI_REMOTE_DATA;
const {installLegacyMaintenance}=await import(pathToFileURL(m.bridgeModule).href);
if(await installLegacyMaintenance({...m,dataDir,mode:'rooms',oldApi:m.legacyRemote+'/node_modules/pi-orchestrator/src/api.ts'})) await import(pathToFileURL(m.legacyRemote+'/server/rooms-main.ts').href);
`, { mode: 0o644 });
}
export function stageFleet(legacy, target, manifest) {
  links(legacy, target, ['dist']); links(join(legacy, 'dist'), join(target, 'dist'), ['cli.js']);
  writeFileSync(join(target, 'dist/cli.js'), `import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url'; import {dirname,join} from 'node:path';
const m=JSON.parse(readFileSync(${JSON.stringify(manifest)},'utf8'));
const {userInfo}=await import('node:os');
const ledgerPath=process.env.PI_ORCHESTRATOR_LEDGER??m.fleetLedgers?.[userInfo().username];
if(typeof ledgerPath!=='string'||!ledgerPath.startsWith('/')) throw new Error('Fleet maintenance has no exact owner ledger');
process.env.PI_ORCHESTRATOR_LEDGER=ledgerPath;
const dataDir=dirname(ledgerPath);
const {installLegacyMaintenance}=await import(pathToFileURL(m.bridgeModule).href);
if(await installLegacyMaintenance({...m,dataDir,mode:'fleet',ledgerPath,oldApi:m.legacyOrchestrator+'/dist/api.js'})) await import(pathToFileURL(m.legacyOrchestrator+'/dist/cli.js').href);
`, { mode: 0o644 });
}
function owner(user, dataDir, unit, mode) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || typeof dataDir !== 'string' || !dataDir.startsWith('/')) throw new Error('Invalid native history owner configuration');
  const uid = Number(command('id', ['-u', user]));
  if (!Number.isSafeInteger(uid)) throw new Error('Invalid native history owner UID');
  return { user, uid, dataDir, unit, mode, socket: bridgeSocket(uid, dataDir) };
}
function captureCommand(binary, args, timeout) {
  return new Promise(resolve => execFile(binary, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}
async function ownerStatus(item, method = 'GET', path = '/status') {
  const inspected = await captureCommand('systemctl', ['show', item.unit, '-p', 'MainPID', '--value'], 3000);
  if (inspected.error) throw new Error(`Owner namespace inspection failed for ${item.unit}: ${inspected.stderr.trim() || inspected.error.message}`);
  const pid = inspected.stdout.trim();
  if (!/^[1-9][0-9]*$/.test(pid)) return { available: false, error: 'Owning namespace launcher is not active' };
  const result = await captureCommand('nsenter', ['--target', pid, '--mount', '--', 'runuser', '-u', item.user, '--', 'curl', '-sS', '--max-time', '5', '--unix-socket', item.socket, '-X', method, `http://localhost${path}`], 7000);
  if (result.error) return { available: false, error: result.stderr.trim() || result.error.message };
  const value = JSON.parse(result.stdout);
  if (value.protocol !== BRIDGE_PROTOCOL || value.uid !== item.uid || value.dataDir !== resolve(item.dataDir)) throw new Error(`Maintenance owner identity mismatch: ${item.user}`);
  return { available: true, pid, value };
}
export function ownerStatuses(owners) { return Promise.all(owners.map(item => ownerStatus(item))); }
function ownerRestorationProof(item, root, hostFile, identity, allowMutation = true) {
  const pid = command('systemctl', ['show', item.unit, '-p', 'MainPID', '--value']);
  const alive = /^[1-9][0-9]*$/.test(pid);
  let namespacePid = pid;
  if (!alive) {
    if (!allowMutation) throw new Error('Restored controller generation changed during readonly adoption proof');
    if (pid !== '0') throw new Error('Owner returned an invalid namespace PID');
    const custody = JSON.parse(readFileSync(hostFile, 'utf8')).nativeHistoryCustodyUnit;
    if (custody === undefined) return recoverClosedOwner({ item, root, legacyRemote: realpathSync('/srv/pi/pi-remote'), identity });
    if (typeof custody !== 'string' || !/^[a-zA-Z0-9_.@-]+\.service$/.test(custody)) throw new Error('Invalid retained custody namespace declaration');
    if (command('systemctl', ['show', custody, '-p', 'ActiveState', '--value']) !== 'active') throw new Error('Retained custody namespace is not active');
    namespacePid = command('systemctl', ['show', custody, '-p', 'MainPID', '--value']);
    if (!/^[1-9][0-9]*$/.test(namespacePid)) throw new Error('Retained custody has no namespace PID');
  }
  const input = { uid: item.uid, unit: item.unit, mode: item.mode, dataDir: item.dataDir, ...identity, allowUnacquired: true,
    ...(item.mode === 'fleet' ? { ledgerPath: item.ledgerPath } : {}) };
  const invoke = (request, action) => spawnSync('nsenter', ['--target', namespacePid, '--mount', '--', 'runuser', '-u', item.user, '--',
    '/usr/local/bin/node', join(root, 'deploy/native-history-closed-owner.mjs'), JSON.stringify(request), ...action],
    { encoding: 'utf8', timeout: 10000 });
  let result = invoke(input, alive ? ['--read-restored'] : []);
  let proof = result.stdout ? JSON.parse(result.stdout) : null;
  if (alive && proof?.ok === false && allowMutation) {
    const host = JSON.parse(readFileSync(hostFile, 'utf8'));
    if (typeof host.nativeHistoryRestorationPlan !== 'string' || !host.nativeHistoryRestorationPlan.startsWith('/')) throw new Error('Live owner restoration requires its declared controller plan');
    const plan = JSON.parse(readFileSync(host.nativeHistoryRestorationPlan, 'utf8'));
    const healthPort = restorationPort(plan, item.unit);
    const selectedSource = item.mode === 'fleet' ? '/srv/pi/pi-orchestrator' : '/srv/pi/pi-remote';
    if (MAINTENANCE_INTAKE !== 'always-open-v1') throw new Error('Unknown controller intake observation contract');
    result = invoke({ ...input, ownerPid: Number(pid), healthPort, selectedSource, publisherUid: Number(command('id', ['-u', host.fleetUser])) }, ['--restore-observation']);
    proof = result.stdout ? JSON.parse(result.stdout) : null;
  }
  if (result.status !== 0 || proof?.ok !== true) throw new Error(`Owner restoration proof unavailable for ${item.unit}: ${proof?.error?.code ?? result.error?.message ?? result.stderr?.trim() ?? 'missing proof'}`);
  const value = proof.value;
  if (value.protocol !== BRIDGE_PROTOCOL || value.uid !== item.uid || value.dataDir !== item.dataDir || value.candidate !== identity.candidate
    || value.legacySource !== identity.legacySource || value.phase !== 'restored' || value.ready !== true) throw new Error('Owner restoration proof identity mismatch');
  return value;
}
function fleetAdmission(item, root, identity, action = 'prepare') {
  const pid = command('systemctl', ['show', item.unit, '-p', 'MainPID', '--value']);
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('Fleet admission owner namespace is unavailable');
  if (typeof item.ledgerPath !== 'string' || !item.ledgerPath.startsWith('/')) throw new Error('Fleet admission requires its exact ledger path');
  const result = command('nsenter', ['--target', pid, '--mount', '--', 'runuser', '-u', item.user, '--', '/usr/local/bin/node', '--input-type=module', '-e',
    `const {legacyFleetLedger}=await import(process.argv[1]); console.log(JSON.stringify(await legacyFleetLedger(process.argv[2],JSON.parse(process.argv[3]),process.argv[4])));`,
    join(root, 'deploy/native-history-bridge.mjs'), item.ledgerPath, JSON.stringify(identity), action]);
  const value = JSON.parse(result);
  if ((action === 'restore' || action === 'restore-owned') && value.ready !== true) throw new Error('Fleet admission fence restoration remains pending');
  return value;
}
export function fleetInventory(host, persons, platform) {
  const declared = new Map(persons.map(person => [person.user, person]));
  if (host.fleetUser !== undefined && !declared.has(host.fleetUser)) declared.set(host.fleetUser, undefined);
  const result = [];
  for (const [user, person] of declared) {
    if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error('Invalid declared fleet owner');
    const unit = `pi-orchestrator@${user}.service`, instance = platform.inspect(unit);
    if (instance === null) continue; // Explicitly inactive; never infer absence from a failed inspection.
    if (!/^[1-9][0-9]*$/.test(instance.pid)) throw new Error(`Active fleet ${unit} has no owning namespace`);
    const environment = instance.environment;
    const get = name => environment.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
    let ledgerPath = get('PI_ORCHESTRATOR_LEDGER') ?? person?.environment?.PI_REMOTE_ORCHESTRATOR_DB;
    if (ledgerPath === undefined) {
      // This is the inspected old CLI's HOME-based path, not a candidate default.
      const home = get('HOME');
      if (typeof home !== 'string' || !home.startsWith('/')) throw new Error(`Fleet ${unit} has no exact ledger or legacy HOME custody`);
      ledgerPath = join(home, '.local/share/pi-orchestrator/ledger.sqlite3');
    }
    if (typeof ledgerPath !== 'string' || !ledgerPath.startsWith('/') || resolve(ledgerPath) !== ledgerPath) throw new Error(`Fleet ${unit} has an invalid exact ledger path`);
    result.push({ ...platform.owner(user, dirname(ledgerPath), unit, 'fleet'), ledgerPath });
  }
  return result;
}
export function fleetCompletionBarrier(owners, inspect) {
  const waiting = [];
  // Observe every owner; an earlier busy provider never hides later custody.
  for (const item of owners) {
    const receipt = inspect(item);
    if (receipt.ready !== true) waiting.push({ user: item.user, pendingCompletions: receipt.pendingCompletions, reason: receipt.reason });
  }
  return { ready: waiting.length === 0, waiting };
}
export function restorationPort(plan, unit) {
  const entries = plan.owners.flatMap(owner => owner.controllers).filter(controller => controller.unit === unit);
  if (entries.length !== 1) throw new Error('Live restoration requires exactly one declared controller endpoint');
  const url = new URL(entries[0].healthUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1/health' || !/^[1-9][0-9]*$/.test(url.port)
    || url.username || url.password || url.search || url.hash) throw new Error('Invalid declared restoration health endpoint');
  return Number(url.port);
}
export function maintenanceStatus(status, identity, proveRestored) {
  if (!status.available || (status.value.candidate === identity.candidate && status.value.legacySource === identity.legacySource)) return status;
  const prior = status.value;
  if (prior.phase !== 'restored' || prior.legacySource !== identity.legacySource || !/^[0-9a-f]{40}$/.test(prior.candidate)) throw new Error('Maintenance controller selected a different source');
  proveRestored({ candidate: prior.candidate, legacySource: prior.legacySource, adoptingCandidate: identity.candidate });
  return { available: false, error: 'Proven restored controller is awaiting asynchronous adoption' };
}
export function allOwnersReady(owners) { return owners.every(item => item.available && (item.value.phase === 'migrated' || item.value.ready === true)); }

/** Every ready owner advances independently; a busy neighbour cannot retain its custody. */
export async function closeReadyOwners(owners, statuses, close) {
  return Promise.all(owners.map(async (owner, index) => {
    const status = statuses[index];
    if (!status?.available || status.value.phase === 'migrated' || status.value.ready !== true) return status;
    return close(owner);
  }));
}

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
    if (result.status === 75 && result.stderr.includes('native history observation waiting:')) return { ready: false, state: 'root-busy', reason: result.stderr.trim() };
    if (result.status !== 0) throw new Error(`Root native history boundary failed: ${result.error?.message ?? result.stderr}`);
    const value = JSON.parse(result.stdout);
    if (value.ready !== true) throw new Error('Root native history adapter returned an invalid readiness proof');
    if (action !== '--restore' && value.admissionGated === true) throw new Error('History observation must not gate Root intake');
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
    const persons = existsSync(personsDir) ? readdirSync(personsDir).filter(name => name.endsWith('.json')).map(file => JSON.parse(readFileSync(join(personsDir, file), 'utf8'))) : [];
    for (const person of persons) {
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
    owners.push(...fleetInventory(host, persons, {
      owner,
      inspect: unit => {
        const active = command('systemctl', ['show', unit, '-p', 'ActiveState', '--value']);
        if (active === 'inactive' || active === 'failed') return null;
        if (active !== 'active') throw new Error(`Fleet ${unit} lifecycle is unsettled: ${active}`);
        const pid = command('systemctl', ['show', unit, '-p', 'MainPID', '--value']);
        if (!/^[1-9][0-9]*$/.test(pid)) throw new Error(`Active fleet ${unit} has no owning namespace`);
        return { pid, environment: readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0') };
      },
    }));
    mkdirSync(stateDir, { recursive: true, mode: 0o755 }); chmodSync(stateDir, 0o755);
    const manifestPath = join(stateDir, 'legacy.json');
    if (marker(legacyOrchestrator) !== legacySource) throw new Error('Selected Remote and Orchestrator source identities differ before maintenance');
    const manifest = { version: 1, candidate, legacySource, legacyRemote: selected, legacyOrchestrator, fleetLedgers: Object.fromEntries(owners.filter(item => item.mode === 'fleet').map(item => [item.user, item.ledgerPath])), bridgeModule: join(root, 'deploy/native-history-bridge.mjs'), migrator: join(root, 'scripts/migrate-native-history.mjs'), node: '/usr/local/bin/node' };
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
      state.phase = 'released'; atomicJson(statePath, state); return { ready: true, state: 'candidate-selected' };
    }
    const statuses = await ownerStatuses(state.owners);
    if (statuses.some(item => item.available && ['closing','migrated','owners-closed','migration-pending'].includes(item.value.phase)) || state.phase === 'ready') throw new Error('Native history is already preserved/migrated; prior capture source restoration is not allowed. Resume the candidate.');
    state.phase = 'restoring'; atomicJson(statePath, state);
    if (realpathSync(remotePointer) === state.remoteStage) selectPointer(remotePointer, state.legacyRemote);
    if (realpathSync(orchestratorPointer) === state.fleetStage) selectPointer(orchestratorPointer, state.legacyOrchestrator);
    for (const item of state.owners) {
      if (!state.adopted.includes(item.unit)) {
        if (item.mode === 'fleet') fleetAdmission(item, root, { candidate, legacySource: state.legacySource }, 'restore-owned');
        continue;
      }
      const before = await ownerStatus(item);
      if (before.available && (before.value.candidate !== candidate || before.value.legacySource !== state.legacySource)) {
        if (before.value.phase !== 'restored' || before.value.legacySource !== state.legacySource) throw new Error('Another publication owns this maintenance controller; restoration cannot alter its fences');
        ownerRestorationProof(item, root, hostFile, { candidate, legacySource: state.legacySource });
        continue;
      }
      const status = await ownerStatus(item, 'POST', '/restore');
      if (!status.available && state.adopted.includes(item.unit)) ownerRestorationProof(item, root, hostFile, { candidate, legacySource: state.legacySource });
      else if (status.available && (status.value.error || status.value.phase !== 'restored')) throw new Error(`Cannot restore admission for ${item.unit}: ${status.value?.error ?? 'owner did not acknowledge restoration'}`);
    }
    // Live old owners have acknowledged restoration in their own processes.
    // Restarting a fleet here would abort accepted tool-free provider requests.
    state.phase = 'restored'; atomicJson(statePath, state); return { ready: true, state: 'restored' };
  }
  if (state.phase === 'restored' || state.phase === 'restoring') throw new Error('Restoring native history attempt cannot advance; finish restoration before a new publication identity');
  if (state.phase === 'ready' || state.phase === 'released') return { ready: true, state: state.phase };
  if (mode === 'probe' && state.phase === 'planned') {
    return { ready: true, state: 'awaiting-adoption', reason: 'The publication can establish finite retiring dispatch cohorts while intake stays open' };
  }
  const restoredControllers = new Map();
  const observations = await ownerStatuses(state.owners);
  for (const [index, item] of state.owners.entries()) {
    const observed = observations[index];
    maintenanceStatus(observed, state, prior => {
      ownerRestorationProof(item, root, hostFile, prior, false);
      restoredControllers.set(item.unit, { pid: observed.pid, candidate: prior.candidate });
    });
  }
  if (mode !== 'probe') {
    const fleets = state.owners.filter(item => item.mode === 'fleet' && !state.adopted.includes(item.unit));
    const identity = { candidate, legacySource: state.legacySource };
    // Establish a finite retiring generation BEFORE observing idleness. New
    // submissions stay accepted in the ledger, but cannot enlarge this cohort.
    const fleetReady = new Set();
    for (const item of fleets) {
      const proof = fleetAdmission(item, root, identity, 'prepare');
      if (proof.prepared !== true) {
        if (proof.code === 'ledger-transaction-active') continue;
        throw new Error(`Fleet dispatch cohort was not established for ${item.unit}`);
      }
      if (proof.ready === true) fleetReady.add(item.unit);
    }
    stageRemote(state.legacyRemote, state.remoteStage, state.manifestPath);
    stageFleet(state.legacyOrchestrator, state.fleetStage, state.manifestPath);
    if (state.phase === 'planned') {
      // Only transient OLD-source wrappers are selected. Candidate artifacts have not changed.
      selectPointer(remotePointer, state.remoteStage); selectPointer(orchestratorPointer, state.fleetStage);
      state.phase = 'adopting'; atomicJson(statePath, state);
    }
    for (const item of state.owners) if (!state.adopted.includes(item.unit) && (item.mode !== 'fleet' || fleetReady.has(item.unit))) {
      command('systemctl', [item.mode === 'fleet' ? 'restart' : 'reload', '--no-block', item.unit]);
      state.adopted.push(item.unit); atomicJson(statePath, state);
    }
  }
  const refreshed = await ownerStatuses(state.owners);
  const statuses = state.owners.map((item, index) => {
    const observed = refreshed[index], proven = restoredControllers.get(item.unit);
    return maintenanceStatus(observed, state, prior => {
      if (proven?.pid !== observed.pid || proven?.candidate !== prior.candidate) ownerRestorationProof(item, root, hostFile, prior, false);
    });
  });
  for (const item of statuses) if (item.available) {
    if (item.value.error) throw new Error(`Private native history maintenance failed: ${item.value.error}`);
    if (item.value.phase === 'restored') throw new Error('An owner restored its admission; restore the whole publication boundary before another candidate');
  }
  if (mode === 'probe') {
    const identity = { candidate, legacySource: state.legacySource };
    const adoptable = state.owners.some(item => item.mode === 'fleet' && !state.adopted.includes(item.unit)
      && fleetAdmission(item, root, identity, 'probe').ready === true);
    const closable = statuses.some(item => item.available && item.value.phase !== 'migrated' && item.value.ready === true);
    if (adoptable || closable) return { ready: true, state: 'owner-progress', reason: 'An individual retiring owner is ready to advance' };
    if (!statuses.every(item => item.available && item.value.phase === 'migrated')) {
      return { ready: false, state: state.phase, owners: statuses, reason: 'Finite retiring execution cohorts are settling; newly accepted work stays queued for the successor' };
    }
    const privileged = rootBoundary('--probe');
    return privileged.ready ? { ready: true, state: 'drained' } : privileged;
  }
  await closeReadyOwners(state.owners, statuses, item => ownerStatus(item, 'POST', '/close'));
  // No owner's native inode is replaced while its writer lives. Other owners
  // may still be busy; that does not postpone the ready owner's migration.
  // A final invocation observes the restart-safe owner receipts after old DB closure/migration.
  const complete = await ownerStatuses(state.owners);
  if (!complete.every(item => item.available && item.value.phase === 'migrated')) return { ready: false, state: 'migrating', owners: complete, reason: 'Finite retiring owner cohorts are settling; ready owners have already advanced' };
  const privileged = rootBoundary('--probe');
  if (!privileged.ready) return privileged;
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
