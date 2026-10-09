import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson, BRIDGE_PROTOCOL } from './native-history-bridge.mjs';

function failure(code, message) { return { ok: false, error: { code, message } }; }
export function closedUnitProof(unit) {
  const result = spawnSync('systemctl', ['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlGroup'], { encoding: 'utf8', timeout: 3000 });
  if (result.status !== 0) return failure('unit-inspection', 'Owning unit inspection failed');
  const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  return fields.LoadState === 'loaded' && ['failed', 'inactive'].includes(fields.ActiveState)
    && fields.MainPID === '0' && fields.ControlGroup === ''
    ? { ok: true, value: fields } : failure('owner-live', 'Owner is not a loaded, closed unit with an empty cgroup');
}
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

export function restoreClosedOwner(input, inspectUnit = closedUnitProof) {
  const databases = [];
  try {
    const uid = process.getuid(), username = userInfo().username;
    if (input.uid !== uid || !['remote', 'rooms', 'fleet'].includes(input.mode)
      || !/^[0-9a-f]{40}$/.test(input.candidate) || !/^[0-9a-f]{40}$/.test(input.legacySource)
      || typeof input.dataDir !== 'string' || !input.dataDir.startsWith('/') || resolve(input.dataDir) !== input.dataDir) {
      return failure('identity', 'Closed-owner restoration requires exact own UID, mode, data directory and source identities');
    }
    const expectedUnit = input.mode === 'rooms' && username === 'pi-rooms' ? 'pi-rooms.service'
      : input.mode === 'fleet' ? `pi-orchestrator@${username}.service` : `pi-remote@${username}.service`;
    if (input.unit !== expectedUnit) return failure('identity', 'Unit does not belong to the executing owner');
    const closed = inspectUnit(input.unit);
    if (!closed.ok) return closed;
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
      if (fleet.pendingCompletions !== 0) return failure('accepted-completions', `Accepted fleet completions remain pending: ${fleet.pendingCompletions}`);
    }
    const stillClosed = inspectUnit(input.unit);
    if (!stillClosed.ok) return stillClosed;
    if (thread === 'identity-bound') threads.exec('DROP TRIGGER IF EXISTS pi_history_admission; DROP TRIGGER IF EXISTS pi_history_children; DROP TRIGGER IF EXISTS pi_history_question_cohort; DROP TABLE IF EXISTS pi_history_questions; DROP TABLE IF EXISTS pi_history_cohort; DROP TABLE pi_history_bridge;');
    if (ledger) {
      if (fleet.fence === 'identity-bound') {
        ledger.exec('DROP TRIGGER IF EXISTS pi_history_completion_admission');
        ledger.prepare("DELETE FROM control WHERE key='native-history-maintenance'").run();
      }
      ledger.exec('COMMIT');
    }
    threads.exec('COMMIT');
    const proof = { owner: 'closed-unit', unit: input.unit, threadFence: thread, receipt: receipt ? 'identity-bound' : 'absent',
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
      : process.argv[3] === undefined ? restoreClosedOwner(input) : failure('input', 'Unknown closed-owner proof action');
  }
  catch { result = failure('input', 'Expected one JSON closed-owner restoration configuration'); }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 75;
}
