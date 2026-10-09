import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyFleetLedger } from '../deploy/native-history-bridge.mjs';

const identity = { candidate: 'b'.repeat(40), legacySource: 'a'.repeat(40) };
function ledger(t) {
  const root = mkdtempSync(join(tmpdir(), 'completion-cohort-'));
  const path = join(root, 'ledger.sqlite3'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE control(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE run(id TEXT PRIMARY KEY,state TEXT,worker_unit TEXT,result TEXT);');
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, db };
}

test('idle observation does not prove replacement readiness until dispatch generation is prepared', async t => {
  const { path, db } = ledger(t);
  assert.deepEqual(await legacyFleetLedger(path, identity, 'probe'), { prepared: false, ready: false, pendingCompletions: 0 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM control').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 0);
  assert.deepEqual(await legacyFleetLedger(path, identity), { prepared: true, ready: true, pendingCompletions: 0 });
  db.exec("INSERT INTO run VALUES('new','queued','completion:new',NULL)");
  assert.throws(() => db.exec("UPDATE run SET state='starting' WHERE id='new'"), /dispatch paused/);
  assert.deepEqual(await legacyFleetLedger(path, identity, 'probe'), { prepared: true, ready: true, pendingCompletions: 0 });
});

test('control-owned completion cohort drains without preventing inserts, old output or other dispatch', async t => {
  const { path, db } = ledger(t);
  db.exec(`INSERT INTO run VALUES('old','running',NULL,NULL);
    INSERT INTO control VALUES('completion-run:old','original-request');`);
  assert.deepEqual(await legacyFleetLedger(path, identity), { prepared: true, ready: false, pendingCompletions: 1 });
  const marker = db.prepare("SELECT value FROM control WHERE key='native-history-maintenance'").get().value;
  for (let i = 0; i < 4; i++) {
    db.prepare('INSERT INTO run VALUES(?,?,NULL,NULL)').run(`input-${i}`, 'queued');
    db.prepare('INSERT INTO control VALUES(?,?)').run(`completion-run:input-${i}`, `request-${i}`);
    assert.throws(() => db.prepare("UPDATE run SET state='starting' WHERE id=?").run(`input-${i}`), /dispatch paused/);
    assert.deepEqual(await legacyFleetLedger(path, identity), { prepared: true, ready: false, pendingCompletions: 1 });
    assert.equal(db.prepare("SELECT value FROM control WHERE key='native-history-maintenance'").get().value, marker);
  }
  db.exec("INSERT INTO run VALUES('ordinary','queued','job:ordinary',NULL); UPDATE run SET state='starting' WHERE id='ordinary'");
  db.exec("UPDATE run SET state='done',result='original-result' WHERE id='old'");
  db.exec("INSERT INTO run VALUES('latest','queued','completion:latest',NULL)");
  assert.deepEqual(await legacyFleetLedger(path, identity, 'probe'), { prepared: true, ready: true, pendingCompletions: 0 });
  assert.equal(db.prepare("SELECT result FROM run WHERE id='old'").get().result, 'original-result');
  assert.equal(db.prepare("SELECT value FROM control WHERE key='completion-run:old'").get().value, 'original-request');
  assert.equal(db.prepare("SELECT count(*) AS n FROM run WHERE state='queued'").get().n, 5);
  await legacyFleetLedger(path, { legacySource: identity.legacySource, candidate: identity.candidate }, 'restore');
  await legacyFleetLedger(path, identity, 'restore-owned');
  db.exec("UPDATE run SET state='starting' WHERE id='input-0'");
  assert.equal(db.prepare("SELECT state FROM run WHERE id='input-0'").get().state, 'starting');
});

test('restoration preserves foreign ownership and refuses an unowned dispatch barrier', async t => {
  const { path, db } = ledger(t);
  assert.deepEqual(await legacyFleetLedger(path, identity, 'restore-owned'), { ready: true });
  await legacyFleetLedger(path, identity);
  const foreign = { ...identity, candidate: 'c'.repeat(40) };
  await assert.rejects(legacyFleetLedger(path, foreign, 'probe'), /Another publication/);
  await assert.rejects(legacyFleetLedger(path, foreign, 'restore'), /Another publication/);
  assert.deepEqual(await legacyFleetLedger(path, foreign, 'restore-owned'), { ready: true, ownership: 'foreign-preserved' });
  assert.deepEqual(await legacyFleetLedger(path, identity, 'probe'), { prepared: true, ready: true, pendingCompletions: 0 });
  db.exec("DELETE FROM control WHERE key='native-history-maintenance'");
  for (const action of ['prepare', 'probe', 'restore', 'restore-owned']) {
    await assert.rejects(legacyFleetLedger(path, identity, action), /no declared identity/);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='pi_history_completion_dispatch'").get().n, 1);
});

test('a marker alone or a changed trigger cannot establish ready proof', async t => {
  const { path, db } = ledger(t);
  db.prepare("INSERT INTO control VALUES('native-history-maintenance',?)").run(JSON.stringify(identity));
  assert.deepEqual(await legacyFleetLedger(path, identity, 'probe'), { prepared: false, ready: false, pendingCompletions: 0 });
  await legacyFleetLedger(path, identity);
  db.exec("DROP TRIGGER pi_history_completion_dispatch; CREATE TRIGGER pi_history_completion_dispatch BEFORE UPDATE ON run WHEN 0 BEGIN SELECT 1; END");
  await assert.rejects(legacyFleetLedger(path, identity, 'probe'), /unknown definition/);
  await assert.rejects(legacyFleetLedger(path, identity), /unknown definition/);
  assert.deepEqual(await legacyFleetLedger(path, identity, 'restore'), { ready: true });
});

test('invalid actions and identities do not acquire maintenance state', async t => {
  const { path, db } = ledger(t);
  await assert.rejects(legacyFleetLedger(path, identity, 'unknown'), /Unknown fleet/);
  await assert.rejects(legacyFleetLedger(path, { candidate: '', legacySource: identity.legacySource }), /immutable ownership/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM control').get().n, 0);
  db.prepare("INSERT INTO control VALUES('native-history-maintenance',?)").run(JSON.stringify({ candidate: 'invalid', legacySource: identity.legacySource }));
  await assert.rejects(legacyFleetLedger(path, identity, 'restore-owned'), /invalid ownership/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM control').get().n, 1);
});
