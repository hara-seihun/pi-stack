import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { restoreClosedOwner, restoreLiveOwner, readRestoredOwner, liveUnitProof, publishedSourceProof, isNativeExecutable } from '../deploy/native-history-closed-owner.mjs';
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
