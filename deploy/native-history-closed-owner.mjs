import { existsSync, readFileSync, statSync, lstatSync, realpathSync, readlinkSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson, bridgeSocket, BRIDGE_PROTOCOL } from './native-history-bridge.mjs';

function failure(code, message) { return { ok: false, error: { code, message } }; }
export function closedUnitProof(unit) {
  const result = spawnSync('systemctl', ['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlGroup'], { encoding: 'utf8', timeout: 3000 });
  if (result.status !== 0) return failure('unit-inspection', 'Owning unit inspection failed');
  const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  return fields.LoadState === 'loaded' && ['failed', 'inactive'].includes(fields.ActiveState)
    && fields.MainPID === '0' && fields.ControlGroup === ''
    ? { ok: true, value: fields } : failure('owner-live', 'Owner is not a loaded, closed unit with an empty cgroup');
}
function processStartTicks(pid) {
  const rawStat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ticks = rawStat.slice(rawStat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^[0-9]+$/.test(ticks)) throw new Error('Live actor has no stable process generation');
  return ticks;
}
export function isNativeExecutable(path) { return ['node', 'bun', 'bun.real'].includes(basename(path)); }
export function originalEntryProof(input, source, cgroup, namespace) {
  const expectedEntry = join(source, input.mode === 'fleet' ? 'dist/cli.js' : input.mode === 'rooms' ? 'server/rooms-main.ts' : 'server/main.ts');
  const matches = [];
  const pids = readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8').trim().split('\n');
  for (const pid of pids) {
    if (!/^[1-9][0-9]*$/.test(pid)) continue;
    try {
      if (statSync(`/proc/${pid}`).uid !== input.uid) continue;
      if (!isNativeExecutable(readlinkSync(`/proc/${pid}/exe`))) continue;
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const entry = args.find(arg => arg.startsWith('/') && arg.endsWith(`/${input.mode === 'fleet' ? 'dist/cli.js' : input.mode === 'rooms' ? 'server/rooms-main.ts' : 'server/main.ts'}`));
      if (!entry || realpathSync(entry) !== expectedEntry) continue;
      if (readlinkSync(`/proc/${pid}/ns/mnt`) !== namespace || readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim() !== `0::${cgroup}`) throw new Error('Serving entry escaped its declared owner namespace/cgroup');
      const startTicks = processStartTicks(pid);
      let selection = { kind: 'literal-immutable-entry', path: entry };
      if (entry !== expectedEntry) {
        const alias = dirname(dirname(entry)), info = lstatSync(alias);
        if (!info.isSymbolicLink() || realpathSync(alias) !== source) throw new Error('Serving entry has no exact source selection alias');
        const hz = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 });
        if (hz.status !== 0 || !/^[1-9][0-9]*$/.test(hz.stdout.trim())) throw new Error('Process start clock is unavailable');
        const before = Date.now(), uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
        if (!Number.isFinite(uptime) || before - uptime * 1000 + Number(startTicks) / Number(hz.stdout.trim()) * 1000 - 20 <= info.ctimeMs) throw new Error('Serving actor predates immutable source selection; unbridged generation is not proven');
        selection = { kind: 'post-selection-entry', path: alias, inode: info.ino, selectedAt: info.ctimeMs };
      }
      matches.push({ pid: Number(pid), startTicks, entry: expectedEntry, selection });
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  if (matches.length !== 1) throw new Error('Expected exactly one source-bound original serving entry in the owning unit');
  return matches[0];
}
export function publishedSourceProof(path, legacySource, publisherUid) {
  if (!Number.isSafeInteger(publisherUid) || publisherUid < 0 || typeof path !== 'string' || !path.startsWith('/')
    || resolve(path) !== path || !/^[0-9a-f]{40}$/.test(legacySource)) return failure('source-proof-input', 'Explicit trusted publisher UID and immutable source identity are required');
  try {
    const source = realpathSync(path), info = statSync(source), markerPath = join(source, '.pi-stack-commit'), marker = statSync(markerPath);
    if (basename(source) !== legacySource || !info.isDirectory() || info.uid !== publisherUid || (info.mode & 0o022)
      || !marker.isFile() || marker.uid !== publisherUid || (marker.mode & 0o022)
      || readFileSync(markerPath, 'utf8').trim() !== legacySource) return failure('source-mismatch', 'Selected package is not the exact immutable source owned by the declared publisher');
    return { ok: true, value: { source, publisherUid } };
  } catch (error) { return failure('source-proof-failed', error instanceof Error ? error.message : String(error)); }
}
export function liveUnitIdentityProof(input) {
  try {
    if (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 0 || !Number.isSafeInteger(input.healthPort)
      || input.healthPort <= 0 || input.healthPort >= 65536 || typeof input.selectedSource !== 'string'
      || !input.selectedSource.startsWith('/') || resolve(input.selectedSource) !== input.selectedSource) return failure('live-proof-input', 'Live restoration requires an explicit owner PID, health port and selected source');
    const result = spawnSync('systemctl', ['show', input.unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlGroup'], { encoding: 'utf8', timeout: 3000 });
    if (result.status !== 0) return failure('unit-inspection', 'Live owning unit inspection failed');
    const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (fields.LoadState !== 'loaded' || fields.ActiveState !== 'active' || fields.MainPID !== String(input.ownerPid)
      || !fields.ControlGroup?.startsWith('/')) return failure('owner-not-live', 'Declared owner is not the active PID/cgroup');
    const published = publishedSourceProof(input.selectedSource, input.legacySource, input.publisherUid);
    if (!published.ok) return published;
    const { source, publisherUid } = published.value;
    const proc = `/proc/${input.ownerPid}`;
    if (statSync(proc).uid !== input.uid || readlinkSync(join(proc, 'ns/mnt')) !== readlinkSync('/proc/self/ns/mnt')) return failure('namespace-mismatch', 'Live restoration must execute in the actual own-UID owner namespace');
    const cgroup = readFileSync(join(proc, 'cgroup'), 'utf8').trim();
    if (cgroup !== `0::${fields.ControlGroup}`) return failure('owner-cgroup', 'Live PID is not in the declared owning unit cgroup');
    const startTicks = processStartTicks(input.ownerPid);
    const namespace = readlinkSync(join(proc, 'ns/mnt'));
    const servingEntry = originalEntryProof(input, source, fields.ControlGroup, namespace);
    const endpoint = bridgeSocket(input.uid, input.dataDir);
    if (existsSync(endpoint)) {
      const probe = spawnSync(process.execPath, [fileURLToPath(new URL('./native-history-bridge.mjs', import.meta.url)), '--probe-socket', endpoint],
        { encoding: 'utf8', timeout: 1500, maxBuffer: 16384 });
      const observed = probe.stdout ? JSON.parse(probe.stdout) : null;
      if (probe.status !== 0 || observed?.ok !== true) return failure('bridge-unavailable', 'Maintenance endpoint has no positive connection-state proof');
      if (observed.value.kind === 'live') return failure('bridge-present', 'Live maintenance controller exists; restore through its owning bridge');
      if (observed.value.kind !== 'absent' && observed.value.kind !== 'stale') return failure('bridge-unavailable', 'Unknown maintenance endpoint connection-state proof');
    }
    return { ok: true, value: { unit: input.unit, pid: input.ownerPid, startTicks, cgroup: fields.ControlGroup,
      source, publisherUid, healthPort: input.healthPort, namespace, servingEntry } };
  } catch (error) { return failure('live-proof-failed', error instanceof Error ? error.message : String(error)); }
}
export function liveUnitProof(input) {
  const identity = liveUnitIdentityProof(input);
  if (!identity.ok) return identity;
  try {
    const health = spawnSync('curl', ['-fsS', '--max-time', '2', `http://127.0.0.1:${input.healthPort}/v1/health`], { encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
    if (health.status !== 0) return failure('health-unavailable', 'Actual own-UID old-owner health is unavailable');
    const value = JSON.parse(health.stdout);
    if (value.ok !== true || value.releaseCommit !== input.legacySource) return failure('health-source', 'Live owner is not serving the exact immutable old source');
    return { ok: true, value: { ...identity.value, releaseCommit: value.releaseCommit } };
  } catch (error) { return failure('health-proof-failed', error instanceof Error ? error.message : String(error)); }
}
function kernelIdentity(value) { const { releaseCommit, ...identity } = value; return identity; }
function sameIdentity(record, identity) { return record?.candidate === identity.candidate && record?.legacySource === identity.legacySource; }
function ownedFile(path, uid) {
  const info = statSync(path);
  if (!info.isFile() || info.uid !== uid) throw new Error('Maintenance file is not owned by the executing UID');
}
function table(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function trigger(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name); }
function threadFence(db, identity) {
  const present = table(db, 'pi_history_bridge');
  if (!present) {
    if (['pi_history_admission', 'pi_history_children', 'pi_history_question_cohort'].some(name => trigger(db, name))
      || ['pi_history_questions', 'pi_history_cohort'].some(name => table(db, name))) throw new Error('Unidentified partial thread fence');
    return 'absent';
  }
  const row = db.prepare("SELECT value FROM pi_history_bridge WHERE key='identity'").get();
  if (!row || !sameIdentity(JSON.parse(row.value), identity)) throw new Error('Thread fence belongs to another publication or has no identity');
  if (db.prepare("SELECT 1 FROM pi_history_bridge WHERE key='closing'").get()) throw new Error('Owner closure has started; old decoder restoration is forbidden');
  return 'identity-bound';
}
function fleetFence(db, identity) {
  if (!table(db, 'control') || !table(db, 'run')) throw new Error('Fleet completion schema is unavailable');
  const row = db.prepare("SELECT value FROM control WHERE key='native-history-maintenance'").get();
  if (!row && trigger(db, 'pi_history_completion_admission')) throw new Error('Unidentified fleet admission fence');
  if (row && !sameIdentity(JSON.parse(row.value), identity)) throw new Error('Fleet fence belongs to another publication');
  const pending = db.prepare(`SELECT count(*) AS n FROM run r WHERE r.state IN ('queued','starting','running')
    AND (r.worker_unit LIKE 'completion:%' OR EXISTS(SELECT 1 FROM control WHERE key='completion-run:'||r.id))`).get().n;
  return { fence: row ? 'identity-bound' : 'absent', pendingCompletions: pending };
}

export function readRestoredOwner(input) {
  const databases = [];
  try {
    const uid = process.getuid();
    if (input.uid !== uid || !['remote', 'rooms', 'fleet'].includes(input.mode)
      || !/^[0-9a-f]{40}$/.test(input.candidate) || !/^[0-9a-f]{40}$/.test(input.legacySource)
      || typeof input.dataDir !== 'string' || !input.dataDir.startsWith('/') || resolve(input.dataDir) !== input.dataDir) return failure('identity', 'Readonly restoration proof requires exact own custody');
    const identity = { candidate: input.candidate, legacySource: input.legacySource }, receiptPath = join(input.dataDir, 'native-history-maintenance.json');
    if (!existsSync(receiptPath)) return failure('receipt-unavailable', 'No acknowledged restored maintenance receipt');
    ownedFile(receiptPath, uid);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt.version !== 1 || receipt.protocol !== BRIDGE_PROTOCOL || receipt.uid !== uid || receipt.dataDir !== input.dataDir
      || !sameIdentity(receipt, identity) || receipt.phase !== 'restored') return failure('receipt-not-restored', 'Maintenance receipt is not this owner/source restored acknowledgement');
    if (existsSync(join(input.dataDir, 'native-history-readiness.json'))) return failure('migration-started', 'Native readiness exists');
    const path = join(input.dataDir, 'threads.sqlite3'); ownedFile(path, uid);
    const threads = new DatabaseSync(path, { readOnly: true }); databases.push(threads);
    threads.exec('PRAGMA busy_timeout=2000');
    if (threadFence(threads, identity) !== 'absent') return failure('fence-present', 'Restored owner still has a thread fence');
    let fleet = null;
    if (input.mode === 'fleet') {
      if (typeof input.ledgerPath !== 'string' || !input.ledgerPath.startsWith('/') || resolve(input.ledgerPath) !== input.ledgerPath
        || dirname(input.ledgerPath) !== input.dataDir || (receipt.ledgerPath !== undefined && receipt.ledgerPath !== input.ledgerPath)) return failure('identity', 'Exact fleet ledger is required');
      ownedFile(input.ledgerPath, uid);
      const ledger = new DatabaseSync(input.ledgerPath, { readOnly: true }); databases.push(ledger);
      ledger.exec('PRAGMA busy_timeout=2000'); fleet = fleetFence(ledger, identity);
      if (fleet.fence !== 'absent') return failure('fence-present', 'Restored owner still has a fleet fence');
    }
    return { ok: true, value: { protocol: BRIDGE_PROTOCOL, uid, dataDir: input.dataDir, ...identity, phase: 'restored', ready: true,
      restorationProof: { owner: 'acknowledged-receipt', receipt: 'identity-bound', threadFence: 'absent',
        ...(fleet ? { fleetFence: 'absent', pendingCompletions: fleet.pendingCompletions } : {}) } } };
  } catch (error) { return failure('restoration-proof-failed', error instanceof Error ? error.message : String(error)); }
  finally { for (const db of databases) db.close(); }
}

export function prepareMaintenanceReceipt(input) {
  const databases = [];
  try {
    const uid = process.getuid();
    if (input.uid !== uid || !['remote', 'rooms', 'fleet'].includes(input.mode)
      || !/^[0-9a-f]{40}$/.test(input.candidate) || !/^[0-9a-f]{40}$/.test(input.legacySource)
      || typeof input.dataDir !== 'string' || !input.dataDir.startsWith('/') || resolve(input.dataDir) !== input.dataDir) return failure('identity', 'Maintenance attempt requires exact own source and directory custody');
    if (input.mode === 'fleet' && (typeof input.ledgerPath !== 'string' || !input.ledgerPath.startsWith('/')
      || resolve(input.ledgerPath) !== input.ledgerPath || dirname(input.ledgerPath) !== input.dataDir)) return failure('identity', 'Maintenance requires its exact owner fleet ledger');
    const path = join(input.dataDir, 'native-history-maintenance.json');
    let prior = null;
    if (existsSync(path)) {
      ownedFile(path, uid); prior = JSON.parse(readFileSync(path, 'utf8'));
      if (prior.version !== 1 || prior.protocol !== BRIDGE_PROTOCOL || prior.uid !== uid || prior.dataDir !== input.dataDir
        || !['draining', 'restored', 'closing', 'owners-closed', 'migration-pending', 'migrated'].includes(prior.phase)) return failure('identity', 'Previous maintenance receipt has invalid owner custody');
      if (sameIdentity(prior, input)) return { ok: true, value: prior };
      if (prior.phase !== 'restored' || !/^[0-9a-f]{40}$/.test(prior.candidate) || prior.legacySource !== input.legacySource) return failure('prior-custody', 'Previous maintenance is not an acknowledged restoration of this old source');
      if (existsSync(join(input.dataDir, 'native-history-readiness.json'))) return failure('migration-started', 'Native readiness forbids reacquiring an old decoder');
      const threadPath = join(input.dataDir, 'threads.sqlite3'); ownedFile(threadPath, uid);
      const threads = new DatabaseSync(threadPath, { readOnly: true }); databases.push(threads); threads.exec('PRAGMA busy_timeout=2000');
      if (threadFence(threads, prior) !== 'absent') return failure('prior-fence', 'Previous thread admission fence is not absent');
      if (input.mode === 'fleet') {
        if (typeof input.ledgerPath !== 'string' || dirname(input.ledgerPath) !== input.dataDir
          || resolve(input.ledgerPath) !== input.ledgerPath || (prior.ledgerPath !== undefined && prior.ledgerPath !== input.ledgerPath)) return failure('identity', 'New maintenance must retain its exact owner ledger');
        ownedFile(input.ledgerPath, uid);
        const ledger = new DatabaseSync(input.ledgerPath, { readOnly: true }); databases.push(ledger); ledger.exec('PRAGMA busy_timeout=2000');
        fleetFence(ledger, input);
      }
    }
    const value = { version: 1, protocol: BRIDGE_PROTOCOL, uid, dataDir: input.dataDir,
      candidate: input.candidate, legacySource: input.legacySource, admittedAt: Date.now(), phase: 'draining',
      ...(input.mode === 'fleet' ? { ledgerPath: input.ledgerPath } : {}), ...(prior ? { priorRestoration: prior } : {}) };
    atomicJson(path, value);
    return { ok: true, value };
  } catch (error) { return failure('attempt-proof-failed', error instanceof Error ? error.message : String(error)); }
  finally { for (const db of databases) db.close(); }
}

export function restoreClosedOwner(input, inspectUnit = closedUnitProof) {
  return restoreOwner(input, { kind: 'closed-unit', inspect: () => inspectUnit(input.unit) });
}
export function restoreLiveOwner(input, inspectOwner = liveUnitProof, inspectIdentity = inspectOwner === liveUnitProof ? liveUnitIdentityProof : inspectOwner) {
  return restoreOwner(input, { kind: 'live-old-unit', inspect: () => inspectOwner(input), inspectLocked: () => inspectIdentity(input) });
}
function restoreOwner(input, route) {
  const databases = [];
  try {
    const uid = process.getuid(), username = userInfo().username;
    if (input.uid !== uid || !['remote', 'rooms', 'fleet'].includes(input.mode)
      || !/^[0-9a-f]{40}$/.test(input.candidate) || !/^[0-9a-f]{40}$/.test(input.legacySource)
      || typeof input.dataDir !== 'string' || !input.dataDir.startsWith('/') || resolve(input.dataDir) !== input.dataDir) {
      return failure('identity', 'Restoration requires exact own UID, mode, data directory and source identities');
    }
    const expectedUnit = input.mode === 'rooms' && username === 'pi-rooms' ? 'pi-rooms.service'
      : input.mode === 'fleet' ? `pi-orchestrator@${username}.service` : `pi-remote@${username}.service`;
    if (input.unit !== expectedUnit) return failure('identity', 'Unit does not belong to the executing owner');
    const initial = route.inspect();
    if (!initial.ok) return initial;
    const identity = { candidate: input.candidate, legacySource: input.legacySource };
    const receiptPath = join(input.dataDir, 'native-history-maintenance.json');
    if (existsSync(join(input.dataDir, 'native-history-readiness.json'))) return failure('migration-started', 'Native readiness exists; resume the candidate instead of the old decoder');
    let receipt = null;
    if (existsSync(receiptPath)) {
      ownedFile(receiptPath, uid); receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (receipt.version !== 1 || receipt.protocol !== BRIDGE_PROTOCOL || receipt.uid !== uid
        || receipt.dataDir !== input.dataDir || !sameIdentity(receipt, identity)) return failure('identity', 'Maintenance receipt custody mismatch');
      if (!['draining', 'restored'].includes(receipt.phase)) return failure('migration-started', 'Owner closure or migration has started');
      if (receipt.databases !== undefined && (!Array.isArray(receipt.databases)
        || receipt.databases.some(path => path !== join(input.dataDir, 'threads.sqlite3')))) return failure('identity', 'Maintenance receipt names another thread database');
    }
    const threadPath = join(input.dataDir, 'threads.sqlite3');
    if (!existsSync(threadPath)) return failure('database-unavailable', 'Owner thread database is absent; no absence proof can be manufactured');
    ownedFile(threadPath, uid);
    const threads = new DatabaseSync(threadPath); databases.push(threads); threads.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
    const thread = threadFence(threads, identity);
    let ledger = null, fleet = null;
    if (input.mode === 'fleet') {
      if (typeof input.ledgerPath !== 'string' || !input.ledgerPath.startsWith('/') || resolve(input.ledgerPath) !== input.ledgerPath
        || dirname(input.ledgerPath) !== input.dataDir || !existsSync(input.ledgerPath)
        || (receipt?.ledgerPath !== undefined && receipt.ledgerPath !== input.ledgerPath)) return failure('identity', 'Exact owner fleet ledger is required');
      ownedFile(input.ledgerPath, uid);
      ledger = new DatabaseSync(input.ledgerPath); databases.push(ledger); ledger.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
      fleet = fleetFence(ledger, identity);
      if (route.kind === 'closed-unit' && fleet.pendingCompletions !== 0) return failure('accepted-completions', `Accepted fleet completions remain pending: ${fleet.pendingCompletions}`);
    }
    const current = route.kind === 'live-old-unit' ? route.inspectLocked() : route.inspect();
    if (!current.ok) return current;
    if (route.kind === 'live-old-unit' && JSON.stringify(kernelIdentity(current.value)) !== JSON.stringify(kernelIdentity(initial.value))) return failure('owner-generation-changed', 'Live owner source/PID/namespace changed before fence release');
    if (thread === 'identity-bound') threads.exec('DROP TRIGGER IF EXISTS pi_history_admission; DROP TRIGGER IF EXISTS pi_history_children; DROP TRIGGER IF EXISTS pi_history_question_cohort; DROP TABLE IF EXISTS pi_history_questions; DROP TABLE IF EXISTS pi_history_cohort; DROP TABLE pi_history_bridge;');
    if (ledger) {
      if (fleet.fence === 'identity-bound') {
        ledger.exec('DROP TRIGGER IF EXISTS pi_history_completion_admission');
        ledger.prepare("DELETE FROM control WHERE key='native-history-maintenance'").run();
      }
      ledger.exec('COMMIT');
    }
    threads.exec('COMMIT');
    if (route.kind === 'live-old-unit') {
      const after = route.inspect();
      if (!after.ok || JSON.stringify(after.value) !== JSON.stringify(initial.value)) return {
        ok: false, error: { code: 'owner-generation-changed', message: 'Fences were released but live source/PID proof changed; receipt remains untouched', fenceReleaseCommitted: true } };
    }
    const proof = { owner: route.kind, unit: input.unit, ...(route.kind === 'live-old-unit' ? { live: initial.value } : {}), threadFence: thread, receipt: receipt ? 'identity-bound' : 'absent',
      ...(fleet ? { fleetFence: fleet.fence, pendingCompletions: fleet.pendingCompletions } : {}) };
    if (receipt) atomicJson(receiptPath, { ...receipt, phase: 'restored', updatedAt: new Date().toISOString(), restorationProof: proof });
    return { ok: true, value: { protocol: BRIDGE_PROTOCOL, uid, dataDir: input.dataDir, ...identity, phase: 'restored', ready: true, restorationProof: proof } };
  } catch (error) {
    return failure(error.errcode === 5 || error.errcode === 6 ? 'database-busy' : 'restoration-failed', error instanceof Error ? error.message : String(error));
  } finally {
    for (const db of databases.reverse()) { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    const input = JSON.parse(process.argv[2]);
    result = process.argv[3] === '--read-restored' ? readRestoredOwner(input)
      : process.argv[3] === '--prepare-attempt' ? prepareMaintenanceReceipt(input)
      : process.argv[3] === '--restore-live' ? restoreLiveOwner(input)
      : process.argv[3] === undefined ? restoreClosedOwner(input) : failure('input', 'Unknown owner proof action');
  }
  catch { result = failure('input', 'Expected one JSON closed-owner restoration configuration'); }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 75;
}
