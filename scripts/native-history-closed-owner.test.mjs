import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { restoreClosedOwner, restoreLiveOwner, restoreObservationOwner, observationUnitProof, readRestoredOwner, liveUnitProof, publishedSourceProof, isNativeExecutable, prepareMaintenanceReceipt } from '../deploy/native-history-closed-owner.mjs';
import { stageLegacyRemoteIdentity, isLegacyCapturePackage } from '../deploy/native-history-package-identity.mjs';
const candidate = 'a'.repeat(40), legacySource = 'b'.repeat(40);
const closed = () => ({ ok: true, value: { LoadState: 'loaded', ActiveState: 'failed', MainPID: '0', ControlGroup: '' } });
function fixture(t, mode = 'remote', receipt = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'history-closed-owner-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const input = { dataDir, mode, uid: process.getuid(), candidate, legacySource,
    unit: `pi-${mode === 'fleet' ? 'orchestrator' : 'remote'}@${userInfo().username}.service` };
  const db = new DatabaseSync(join(dataDir, 'threads.sqlite3'));
  db.exec("CREATE TABLE thread(id TEXT PRIMARY KEY,body TEXT); INSERT INTO thread VALUES('accepted','preserve-me');"); db.close();
  if (mode === 'fleet') {
    input.ledgerPath = join(dataDir, 'ledger.sqlite3');
    const ledger = new DatabaseSync(input.ledgerPath);
    ledger.exec('CREATE TABLE control(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE run(id TEXT PRIMARY KEY,state TEXT,worker_unit TEXT);'); ledger.close();
  }
  if (receipt) writeFileSync(join(dataDir, 'native-history-maintenance.json'), JSON.stringify({ version: 1, protocol: 'native-history-maintenance-v1', ...input, phase: 'draining', admittedAt: 42, untouched: 'retain' }));
  return input;
}
function fence(input, other = false) {
  const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3'));
  db.exec('CREATE TABLE pi_history_bridge(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE pi_history_cohort(id TEXT); CREATE TABLE pi_history_questions(id TEXT);');
  db.prepare('INSERT INTO pi_history_bridge VALUES(?,?)').run('identity', JSON.stringify({ candidate: other ? 'c'.repeat(40) : candidate, legacySource }));
  db.exec("CREATE TRIGGER pi_history_admission BEFORE INSERT ON thread BEGIN SELECT RAISE(ABORT,'fenced'); END;"); db.close();
}
function readThread(input) { const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3'), { readOnly: true }); try { return db.prepare('SELECT * FROM thread').all(); } finally { db.close(); } }

test('closed owner removes exact fence, preserves accepted rows/receipt fields and readonly proof is idempotent', t => {
  const input = fixture(t); fence(input);
  const before = readThread(input); const result = restoreClosedOwner(input, closed);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.restorationProof.threadFence, 'identity-bound');
  assert.deepEqual(readThread(input), before);
  const receipt = JSON.parse(readFileSync(join(input.dataDir, 'native-history-maintenance.json'), 'utf8'));
  assert.equal(receipt.phase, 'restored'); assert.equal(receipt.admittedAt, 42); assert.equal(receipt.untouched, 'retain');
  assert.equal(readRestoredOwner(input).ok, true); assert.equal(restoreClosedOwner(input, closed).ok, true);
});
test('new candidate acquires only a positively restored old attempt and preserves its receipt evidence', t => {
  const input = fixture(t); fence(input);
  const successor = { ...input, candidate: 'd'.repeat(40) };
  const path = join(input.dataDir, 'native-history-maintenance.json'); const initial = readFileSync(path, 'utf8');
  assert.equal(prepareMaintenanceReceipt(successor).error.code, 'prior-custody');
  assert.equal(readFileSync(path, 'utf8'), initial);
  assert.equal(restoreClosedOwner(input, closed).ok, true);
  const previous = JSON.parse(readFileSync(path, 'utf8'));
  const acquired = prepareMaintenanceReceipt(successor);
  assert.equal(acquired.ok, true, JSON.stringify(acquired)); assert.equal(acquired.value.candidate, successor.candidate);
  assert.equal(acquired.value.phase, 'draining'); assert.deepEqual(acquired.value.priorRestoration, previous);
  assert.equal(acquired.value.admittedAt >= previous.admittedAt, true);
  const bytes = readFileSync(path, 'utf8');
  assert.equal(prepareMaintenanceReceipt(successor).ok, true); assert.equal(readFileSync(path, 'utf8'), bytes);
  assert.deepEqual(readThread(input).map(row => row.body), ['preserve-me']);
});
test('restored claim with retained thread fences, migration or foreign fleet identity cannot acquire a successor', t => {
  const input = fixture(t, 'fleet'); fence(input);
  const path = join(input.dataDir, 'native-history-maintenance.json');
  const previous = JSON.parse(readFileSync(path, 'utf8')); previous.phase = 'restored'; writeFileSync(path, JSON.stringify(previous));
  const successor = { ...input, candidate: 'd'.repeat(40) };
  assert.equal(prepareMaintenanceReceipt(successor).error.code, 'prior-fence');
  assert.equal(restoreClosedOwner(input, closed).ok, true);
  writeFileSync(join(input.dataDir, 'native-history-readiness.json'), '{}');
  assert.equal(prepareMaintenanceReceipt(successor).error.code, 'migration-started');
  rmSync(join(input.dataDir, 'native-history-readiness.json'));
  const ledger = new DatabaseSync(input.ledgerPath);
  ledger.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify({ ...successor, candidate: 'e'.repeat(40) }));
  assert.equal(prepareMaintenanceReceipt(successor).ok, false);
  ledger.prepare('UPDATE control SET value=?').run(JSON.stringify({ candidate: successor.candidate, legacySource })); ledger.close();
  assert.equal(prepareMaintenanceReceipt(successor).ok, true, 'Exact new coordinator barrier is permitted without removing it');
  const after = new DatabaseSync(input.ledgerPath); assert.equal(JSON.parse(after.prepare('SELECT value FROM control').get().value).candidate, successor.candidate); after.close();
});
test('an unacquired successor proves prior restoration without rewriting its receipt or releasing foreign custody', t => {
  const input = fixture(t, 'fleet');
  assert.equal(restoreClosedOwner(input, closed).ok, true);
  const successor = { ...input, candidate: 'd'.repeat(40), allowUnacquired: true };
  const path = join(input.dataDir, 'native-history-maintenance.json'), before = readFileSync(path, 'utf8');
  assert.equal(readRestoredOwner({ ...successor, allowUnacquired: false }).ok, false);
  const observed = readRestoredOwner(successor);
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.value.candidate, successor.candidate);
  assert.equal(observed.value.restorationProof.priorCandidate, candidate);
  const ledger = new DatabaseSync(input.ledgerPath);
  ledger.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify(successor)); ledger.close();
  assert.equal(readRestoredOwner(successor).ok, false, 'own fleet barrier still needs release');
  const adoption = readRestoredOwner({ ...input, adoptingCandidate: successor.candidate });
  assert.equal(adoption.ok, true, JSON.stringify(adoption));
  assert.equal(adoption.value.restorationProof.fleetFence, 'identity-bound');
  assert.equal(readRestoredOwner({ ...input, adoptingCandidate: 'f'.repeat(40) }).ok, false, 'foreign fence is not adoption');
  const retained = new DatabaseSync(input.ledgerPath, { readOnly: true });
  assert.equal(JSON.parse(retained.prepare('SELECT value FROM control').get().value).candidate, successor.candidate); retained.close();
  const restored = restoreClosedOwner(successor, closed);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.value.restorationProof.acquisition, 'not-acquired');
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readRestoredOwner(successor).ok, true);
  const foreign = new DatabaseSync(input.ledgerPath);
  foreign.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify({ ...successor, candidate: 'e'.repeat(40) })); foreign.close();
  assert.equal(restoreClosedOwner(successor, closed).ok, false);
  assert.equal(readFileSync(path, 'utf8'), before);
});
test('absent receipt yields positive absent-fence proof without fabricating a private receipt', t => {
  const input = fixture(t, 'remote', false); const result = restoreClosedOwner(input, closed);
  assert.equal(result.ok, true); assert.equal(result.value.restorationProof.receipt, 'absent');
  assert.equal(existsSync(join(input.dataDir, 'native-history-maintenance.json')), false);
  assert.equal(readRestoredOwner(input).error.code, 'receipt-unavailable');
});
test('receipt absent but exact bound fence can be removed; other identity remains untouched', t => {
  const input = fixture(t, 'remote', false); fence(input, true);
  assert.equal(restoreClosedOwner(input, closed).ok, false);
  const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM pi_history_bridge").get().n, 1); db.close();
});
test('migration and live owner reject without modifying admission', t => {
  const input = fixture(t); fence(input);
  assert.equal(restoreClosedOwner(input, () => ({ ok: false, error: { code: 'owner-live' } })).error.code, 'owner-live');
  writeFileSync(join(input.dataDir, 'native-history-readiness.json'), '{}');
  assert.equal(restoreClosedOwner(input, closed).error.code, 'migration-started');
  assert.equal(JSON.parse(readFileSync(join(input.dataDir, 'native-history-maintenance.json'))).phase, 'draining');
});
test('accepted fleet completion prevents mutation and no provider is aborted; settled proof restores both fences', t => {
  const input = fixture(t, 'fleet'); fence(input);
  const db = new DatabaseSync(input.ledgerPath);
  db.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify({ candidate, legacySource }));
  db.exec("INSERT INTO run VALUES('completion1','running','completion:old'); CREATE TRIGGER pi_history_completion_admission BEFORE INSERT ON run BEGIN SELECT RAISE(ABORT,'fenced'); END;"); db.close();
  assert.equal(restoreClosedOwner(input, closed).error.code, 'accepted-completions');
  const ledger = new DatabaseSync(input.ledgerPath); assert.equal(ledger.prepare('SELECT state FROM run').get().state, 'running');
  ledger.exec("UPDATE run SET state='done'"); ledger.close();
  assert.equal(restoreClosedOwner(input, closed).ok, true);
  const read = readRestoredOwner(input); assert.equal(read.ok, true); assert.equal(read.value.restorationProof.pendingCompletions, 0);
});
test('readonly restoration rejects receipt claiming restored while any fence remains', t => {
  const input = fixture(t); fence(input);
  const path = join(input.dataDir, 'native-history-maintenance.json'); const receipt = JSON.parse(readFileSync(path));
  receipt.phase = 'restored'; writeFileSync(path, JSON.stringify(receipt));
  assert.equal(readRestoredOwner(input).error.code, 'fence-present');
});
function live(input, pid = 42) {
  return { ok: true, value: { unit: input.unit, pid, startTicks: '12345', cgroup: '/system.slice/test', source: `/immutable/${legacySource}`,
    healthPort: 2460, releaseCommit: legacySource, namespace: 'mnt:[test]', servingEntry: { pid, startTicks: '12345', entry: `/immutable/${legacySource}/dist/cli.js`, selection: { kind: 'literal-immutable-entry' } } } };
}
test('live old fleet removes only its fences while accepted provider state continues unchanged', t => {
  const input = fixture(t, 'fleet'); fence(input);
  const ledger = new DatabaseSync(input.ledgerPath);
  ledger.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify({ candidate, legacySource }));
  ledger.exec("INSERT INTO run VALUES('completion1','running','completion:old'); CREATE TRIGGER pi_history_completion_admission BEFORE INSERT ON run BEGIN SELECT RAISE(ABORT,'fenced'); END;"); ledger.close();
  const result = restoreLiveOwner(input, () => live(input)); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.restorationProof.owner, 'live-old-unit'); assert.equal(result.value.restorationProof.pendingCompletions, 1);
  const after = new DatabaseSync(input.ledgerPath, { readOnly: true }); assert.equal(after.prepare('SELECT state FROM run').get().state, 'running'); after.close();
  assert.equal(readRestoredOwner(input).ok, true); assert.deepEqual(readThread(input).map(row => row.body), ['preserve-me']);
});
test('live health observes unlocked databases while kernel identity is checked under the fence transaction', t => {
  const input = fixture(t, 'fleet'); fence(input);
  let healthChecks = 0, lockedChecks = 0;
  const full = () => {
    const threads = new DatabaseSync(join(input.dataDir, 'threads.sqlite3'));
    const ledger = new DatabaseSync(input.ledgerPath);
    try {
      threads.exec('BEGIN IMMEDIATE; ROLLBACK'); ledger.exec('BEGIN IMMEDIATE; ROLLBACK');
      healthChecks++; return live(input);
    } finally { threads.close(); ledger.close(); }
  };
  const kernel = () => {
    const ledger = new DatabaseSync(input.ledgerPath);
    try { assert.throws(() => ledger.exec('BEGIN IMMEDIATE'), /locked/); lockedChecks++; return live(input); }
    finally { ledger.close(); }
  };
  const restored = restoreLiveOwner(input, full, kernel);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(healthChecks, 2); assert.equal(lockedChecks, 1);
  assert.equal(readRestoredOwner(input).ok, true);
});
test('serving executable recognizes the installed Bun real binary, not arbitrary launcher names', () => {
  assert.equal(isNativeExecutable('/usr/local/bin/bun.real'), true);
  assert.equal(isNativeExecutable('/usr/local/bin/bun'), true);
  assert.equal(isNativeExecutable('/usr/local/bin/node'), true);
  assert.equal(isNativeExecutable('/bin/bash'), false);
  assert.equal(isNativeExecutable('/tmp/not-bun.real'), false);
});
test('live source/PID drift before fence release rolls back; postcommit drift is an explicit committed-effect error', t => {
  const input = fixture(t); fence(input); let count = 0;
  assert.equal(restoreLiveOwner(input, () => live(input, ++count === 1 ? 42 : 43)).error.code, 'owner-generation-changed');
  const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3'), { readOnly: true }); assert.equal(db.prepare('SELECT count(*) AS n FROM pi_history_bridge').get().n, 1); db.close();
  count = 0;
  const committed = restoreLiveOwner(input, () => live(input, ++count < 3 ? 42 : 43));
  assert.equal(committed.error.fenceReleaseCommitted, true);
  assert.equal(JSON.parse(readFileSync(join(input.dataDir, 'native-history-maintenance.json'))).phase, 'draining');
  assert.equal(restoreLiveOwner(input, () => live(input)).ok, true);
});
test('immutable package accepts its explicit non-root publisher and rejects wrong or missing publisher UID', t => {
  assert.notEqual(process.getuid(), 0, 'This fixture exercises the actual non-root publisher');
  const root = mkdtempSync(join(tmpdir(), 'history-publisher-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, legacySource); mkdirSync(source, { mode: 0o755 });
  writeFileSync(join(source, '.pi-stack-commit'), legacySource, { mode: 0o644 });
  const alias = join(root, 'selected'); symlinkSync(source, alias);
  assert.deepEqual(publishedSourceProof(alias, legacySource, process.getuid()), { ok: true, value: { source, publisherUid: process.getuid() } });
  assert.equal(publishedSourceProof(alias, legacySource, 0).error.code, 'source-mismatch');
  assert.equal(publishedSourceProof(alias, legacySource, undefined).error.code, 'source-proof-input');
});
test('live route rejects unavailable source proof and preclosure crossing without inventing a live boolean', t => {
  const input = fixture(t); fence(input);
  assert.equal(liveUnitProof(input).error.code, 'live-proof-input');
  assert.equal(restoreLiveOwner(input, () => ({ ok: false, error: { code: 'health-source' } })).error.code, 'health-source');
  const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3')); db.exec("INSERT INTO pi_history_bridge VALUES('closing','1')"); db.close();
  assert.equal(restoreLiveOwner(input, () => live(input)).ok, false);
  assert.equal(JSON.parse(readFileSync(join(input.dataDir, 'native-history-maintenance.json'))).phase, 'draining');
});
function observe(input, version = 1) {
  const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3'));
  db.exec('CREATE TABLE pi_history_bridge(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE pi_history_observation(version INTEGER PRIMARY KEY);');
  db.prepare('INSERT INTO pi_history_bridge VALUES(?,?)').run('identity', JSON.stringify({ candidate: input.candidate, legacySource: input.legacySource }));
  db.prepare('INSERT INTO pi_history_observation VALUES(?)').run(version); db.close();
  if (input.mode === 'fleet') {
    const ledger = new DatabaseSync(input.ledgerPath);
    ledger.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify({ candidate: input.candidate, legacySource: input.legacySource }));
    ledger.exec("CREATE TRIGGER pi_history_completion_dispatch BEFORE UPDATE ON run WHEN OLD.state='queued' AND NEW.state='starting' BEGIN SELECT RAISE(ABORT,'dispatch-paused'); END;"); ledger.close();
  }
}
function observationLive(input, pid = 42) { const proof = live(input, pid); delete proof.value.servingEntry; return proof; }
test('observation restore removes only observation/dispatch custody with providers and native rows untouched', t => {
  const input = fixture(t, 'fleet'); observe(input);
  const ledger = new DatabaseSync(input.ledgerPath);
  ledger.exec("INSERT INTO run VALUES('active','running','completion:old'); INSERT INTO run VALUES('queued','queued','completion:next');");
  ledger.prepare('INSERT INTO control VALUES(?,?)').run('completion-run:active', 'preserve'); ledger.close();
  const before = readThread(input);
  const result = restoreObservationOwner(input, () => observationLive(input));
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.restorationProof.owner, 'live-observation');
  assert.equal(result.value.restorationProof.pendingCompletions, 2);
  assert.deepEqual(readThread(input), before);
  const after = new DatabaseSync(input.ledgerPath);
  assert.deepEqual(after.prepare('SELECT id,state FROM run ORDER BY id').all().map(row => ({ ...row })), [{ id: 'active', state: 'running' }, { id: 'queued', state: 'queued' }]);
  assert.equal(after.prepare("SELECT value FROM control WHERE key='completion-run:active'").get().value, 'preserve');
  assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 0); after.close();
  const receipt = JSON.parse(readFileSync(join(input.dataDir, 'native-history-maintenance.json')));
  assert.equal(receipt.phase, 'restored'); assert.equal(receipt.untouched, 'retain');
  assert.equal(readRestoredOwner(input).ok, true);
  assert.equal(restoreObservationOwner(input, () => observationLive(input)).ok, false, 'Absent observation is not fabricated positive custody');
});
test('fleet dispatch-only observation requires its positive owned marker and preserves running providers', t => {
  const input = fixture(t, 'fleet');
  assert.equal(restoreObservationOwner(input, () => observationLive(input)).error.code, 'observation-unacquired');
  const ledger = new DatabaseSync(input.ledgerPath);
  ledger.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify({ candidate, legacySource }));
  ledger.exec("INSERT INTO run VALUES('active','running','completion:old'); CREATE TRIGGER pi_history_completion_dispatch BEFORE UPDATE ON run WHEN OLD.state='queued' AND NEW.state='starting' BEGIN SELECT RAISE(ABORT,'dispatch-paused'); END;"); ledger.close();
  const result = restoreObservationOwner(input, () => observationLive(input));
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.restorationProof.threadFence, 'absent-dispatch-only');
  const after = new DatabaseSync(input.ledgerPath); assert.equal(after.prepare('SELECT state FROM run').get().state, 'running'); after.close();
  assert.equal(readRestoredOwner(input).ok, true);
  const historical = fixture(t, 'fleet'); fence(historical);
  const old = new DatabaseSync(historical.ledgerPath);
  old.prepare('INSERT INTO control VALUES(?,?)').run('native-history-maintenance', JSON.stringify({ candidate, legacySource }));
  old.exec("CREATE TRIGGER pi_history_completion_dispatch BEFORE UPDATE ON run BEGIN SELECT RAISE(ABORT,'paused'); END;"); old.close();
  assert.equal(restoreObservationOwner(historical, () => observationLive(historical)).ok, false);
});
test('observation proof requires health outside locks and repeated kernel identity under both locks', t => {
  const input = fixture(t, 'fleet'); observe(input); let healthChecks = 0, lockedChecks = 0;
  const health = () => {
    for (const path of [join(input.dataDir, 'threads.sqlite3'), input.ledgerPath]) {
      const db = new DatabaseSync(path); try { db.exec('BEGIN IMMEDIATE; ROLLBACK'); } finally { db.close(); }
    }
    healthChecks++; return observationLive(input);
  };
  const kernel = () => {
    for (const path of [join(input.dataDir, 'threads.sqlite3'), input.ledgerPath]) {
      const db = new DatabaseSync(path); try { assert.throws(() => db.exec('BEGIN IMMEDIATE'), /locked/); } finally { db.close(); }
    }
    lockedChecks++; return observationLive(input);
  };
  assert.equal(restoreObservationOwner(input, health, kernel).ok, true);
  assert.equal(healthChecks, 2); assert.equal(lockedChecks, 1);
  assert.equal(observationUnitProof(input).error.code, 'live-proof-input');
});
test('observation route refuses unknown, historical gated, foreign and closing owners without mutation', t => {
  for (const defect of ['missing', 'version', 'identity', 'admission', 'children', 'questions', 'cohort', 'closing', 'ledger-admission', 'ledger-foreign', 'receipt-foreign', 'receipt-absent', 'receipt-closing', 'readiness', 'retirement']) {
    const input = fixture(t, 'fleet'); if (defect !== 'missing') observe(input, defect === 'version' ? 2 : 1);
    const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3'));
    if (['admission', 'children', 'questions'].includes(defect)) db.exec(`CREATE TRIGGER ${defect === 'questions' ? 'pi_history_question_cohort' : `pi_history_${defect}`} BEFORE INSERT ON thread BEGIN SELECT RAISE(ABORT,'historical'); END;`);
    if (defect === 'cohort') db.exec('CREATE TABLE pi_history_cohort(id TEXT)');
    if (defect === 'identity') db.prepare("UPDATE pi_history_bridge SET value=?").run(JSON.stringify({ candidate: 'c'.repeat(40), legacySource }));
    if (defect === 'closing') db.exec("INSERT INTO pi_history_bridge VALUES('closing','1')"); db.close();
    const ledger = new DatabaseSync(input.ledgerPath);
    if (defect === 'ledger-admission') ledger.exec("CREATE TRIGGER pi_history_completion_admission BEFORE INSERT ON run BEGIN SELECT RAISE(ABORT,'historical'); END;");
    if (defect === 'ledger-foreign') ledger.prepare('UPDATE control SET value=?').run(JSON.stringify({ candidate: 'c'.repeat(40), legacySource })); ledger.close();
    const path = join(input.dataDir, 'native-history-maintenance.json');
    if (defect.startsWith('receipt-')) {
      const receipt = JSON.parse(readFileSync(path));
      if (defect === 'receipt-absent') rmSync(path);
      else { if (defect === 'receipt-foreign') receipt.candidate = 'c'.repeat(40); else receipt.phase = 'closing'; writeFileSync(path, JSON.stringify(receipt)); }
    }
    if (defect === 'readiness') writeFileSync(join(input.dataDir, 'native-history-readiness.json'), '{}');
    if (defect === 'retirement') mkdirSync(join(input.dataDir, 'native-history-retirement'));
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const result = restoreObservationOwner(input, () => observationLive(input));
    assert.equal(result.ok, false, defect);
    assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, defect);
    assert.deepEqual(readThread(input).map(row => row.body), ['preserve-me'], defect);
  }
});
test('observation generation changes rollback or explicitly report committed release without acknowledging receipt', t => {
  const input = fixture(t); observe(input);
  const before = readFileSync(join(input.dataDir, 'native-history-maintenance.json'), 'utf8');
  const early = restoreObservationOwner(input, () => observationLive(input), () => observationLive(input, 43));
  assert.equal(early.error.code, 'owner-generation-changed');
  const db = new DatabaseSync(join(input.dataDir, 'threads.sqlite3')); assert.equal(db.prepare('SELECT version FROM pi_history_observation').get().version, 1); db.close();
  let calls = 0;
  const late = restoreObservationOwner(input, () => observationLive(input, ++calls === 1 ? 42 : 43), () => observationLive(input));
  assert.equal(late.error.code, 'owner-generation-changed'); assert.equal(late.error.fenceReleaseCommitted, true);
  assert.equal(readFileSync(join(input.dataDir, 'native-history-maintenance.json'), 'utf8'), before);
});

test('staged local entry/server preserve package assertion and one old API module graph without settings edits', t => {
  const root = mkdtempSync(join(tmpdir(), 'history-package-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, 'old'), target = join(root, 'stage');
  for (const path of [legacy, target]) mkdirSync(join(path, 'server'), { recursive: true });
  writeFileSync(join(legacy, '.pi-stack-commit'), legacySource); symlinkSync(join(legacy, '.pi-stack-commit'), join(target, '.pi-stack-commit'));
  writeFileSync(join(legacy, 'server/main.ts'), 'await import("./server");');
  writeFileSync(join(legacy, 'server/api.ts'), 'export const identity = {};');
  writeFileSync(join(legacy, 'server/context-mirror.ts'), 'export {};');
  writeFileSync(join(legacy, 'package.json'), '{}');
  symlinkSync(join(legacy, 'server/context-mirror.ts'), join(target, 'server/context-mirror.ts'));
  symlinkSync(join(legacy, 'package.json'), join(target, 'package.json'));
  writeFileSync(join(legacy, 'server/server.ts'), 'import { realpathSync } from "node:fs"; import { join } from "node:path"; import {identity} from "./api"; const PACKAGE_ROOT = realpathSync(join(import.meta.dir, "..")); const configuredRoot=realpathSync(process.env.CAPTURE_ROOT); if (configuredRoot !== PACKAGE_ROOT) { throw new Error("wrong capture package"); } console.log(JSON.stringify({PACKAGE_ROOT,sameApi:identity===(await import(process.env.OLD_API)).identity}));');
  symlinkSync(join(legacy, 'server/server.ts'), join(target, 'server/server.ts')); symlinkSync(join(legacy, 'server/api.ts'), join(target, 'server/api.ts'));
  const source = readFileSync(join(legacy, 'server/server.ts'));
  const copied = stageLegacyRemoteIdentity(legacy, target, legacySource);
  assert.deepEqual(readFileSync(join(legacy, 'server/server.ts')), source);
  const pointer = join(root, 'pi-remote'); symlinkSync(target, pointer);
  for (const capture of [legacy, pointer]) {
    const result = spawnSync('/usr/local/bin/bun', [copied.mainPath], { encoding: 'utf8', timeout: 3000, env: { ...process.env, OLD_API: join(legacy, 'server/api.ts'), CAPTURE_ROOT: capture } });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { PACKAGE_ROOT: legacy, sameApi: true });
  }
  const unrelated = join(root, 'unrelated'); mkdirSync(unrelated);
  const rejected = spawnSync('/usr/local/bin/bun', [copied.mainPath], { encoding: 'utf8', timeout: 3000, env: { ...process.env, OLD_API: join(legacy, 'server/api.ts'), CAPTURE_ROOT: unrelated } });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /wrong capture package/);
  assert.equal(isLegacyCapturePackage(unrelated, legacy, target, legacySource), false);
  assert.deepEqual(stageLegacyRemoteIdentity(legacy, target, legacySource).hashes, copied.hashes);
});
