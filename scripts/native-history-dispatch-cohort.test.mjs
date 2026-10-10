import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { closeReadyOwners } from '../deploy/native-history-coordinator.mjs';

const candidate = 'b'.repeat(40), legacySource = 'a'.repeat(40);
const bridge = new URL('../deploy/native-history-bridge.mjs', import.meta.url).href;

// Isolated old-module stand-ins exercise the actual bridge's source-bound prototype
// seams. Every intake path calls dispatch; the unfenced baseline proves those calls
// would execute, rather than testing a fixture that cannot dispatch in the first place.
const apiSource = `
import { DatabaseSync } from 'node:sqlite';
export class ThreadService {
  constructor(path) {
    this.options = { databasePath: path }; this.db = new DatabaseSync(path);
    this.closed = false; this.suspended = false; this.dispatches = [];
    this.runtimes = new Map(); this.operations = new Map(); this.opening = new Map();
    this.halts = new Map(); this.dependencyOperations = new Map();
    this.producer = { source: 'original-native-producer', busy: true, waiters: new Map(), executionId: 'original-execution' };
    this.closeCalls = 0; this.cancelCalls = 0; this.routing = false; this.routed = 0;
  }
  sql(text) { return this.db.prepare(text); }
  async start() {
    if (this.suspended) return { ok: false, error: { code: 'unavailable' } };
    if (this.execution('busy')) await this.attach('busy');
    await this.spawn({ requestId: 'startup-root' });
    await this.send({ requestId: 'startup-input', threadId: 'idle' });
    await this.deliverScheduledWakes();
    await this.wake(); await this.drain();
    await this.routeNotifications();
    return { ok: true };
  }
  async routeNotifications() {
    // Legacy cross-owner routing: its in-flight retry is a busy controller operation.
    this.routing = true;
    try { this.routed++; } finally { this.routing = false; }
  }
  async attach(id) {
    const runtime = id === 'busy' ? this.producer : { busy: false, waiters: new Map() };
    this.runtimes.set(id, runtime); return runtime;
  }
  execution(id) { return this.sql('SELECT * FROM thread_execution WHERE thread_id=? AND ended_at IS NULL').get(id); }
  async rpc(runtime) { return { isStreaming: runtime.busy, isCompacting: false, localTools: 0, pendingCommandCount: 0 }; }
  busy(state) { return state.isStreaming; }
  adoptReference() {}
  async wake(id) { await this.drain(id); }
  async drain(id) {
    for (const work of this.sql("SELECT * FROM thread_work WHERE status='queued'").all()) {
      if (id !== undefined && work.thread_id !== id || this.execution(work.thread_id)) continue;
      this.sql("UPDATE thread_work SET status='dispatched' WHERE id=?").run(work.id);
      this.sql("INSERT INTO thread_execution VALUES(?,?,?,1,'normal-result')").run('execution:' + work.id, work.thread_id, work.id);
      this.dispatches.push(work.id);
      this.sql("UPDATE thread_work SET status='done' WHERE id=?").run(work.id);
    }
  }
  async send({ requestId, threadId, senderId = null }) {
    if (this.closed || this.suspended) return { ok: false, error: { code: 'unavailable' } };
    const prior = this.sql('SELECT target FROM thread_request WHERE id=?').get(requestId);
    if (prior) return { ok: true, value: prior.target };
    this.sql("INSERT INTO thread_work VALUES(?,?,?,'queued')").run(requestId, threadId, senderId);
    this.sql("INSERT INTO thread_request VALUES(?,'send',?)").run(requestId, requestId);
    await this.wake(threadId); return { ok: true, value: requestId };
  }
  async spawn({ requestId, parentId = null }) {
    if (this.closed || this.suspended) return { ok: false, error: { code: 'unavailable' } };
    const prior = this.sql('SELECT target FROM thread_request WHERE id=?').get(requestId);
    if (prior) return { ok: true, value: prior.target };
    this.sql('INSERT INTO thread(id,parent_id) VALUES(?,?)').run(requestId, parentId);
    await this.send({ requestId, threadId: requestId, senderId: parentId });
    return { ok: true, value: requestId };
  }
  async answer({ requestId, questionId }) {
    const question = this.sql('SELECT thread_id FROM thread_question WHERE id=?').get(questionId);
    return this.send({ requestId, threadId: question.thread_id });
  }
  schedule({ requestId, threadId }) {
    if (this.closed || this.suspended) return { ok: false, error: { code: 'unavailable' } };
    this.sql('INSERT INTO thread_wake VALUES(?,?,0,NULL)').run(threadId, requestId);
    return { ok: true };
  }
  async deliverScheduledWakes() {
    for (const wake of this.sql('SELECT * FROM thread_wake WHERE delivered=0').all()) {
      const receipt = 'wake:' + wake.generation;
      await this.send({ requestId: receipt, threadId: wake.thread_id, senderId: wake.thread_id });
      this.sql('UPDATE thread_wake SET delivered=1,last_message_id=? WHERE thread_id=?').run(receipt, wake.thread_id);
    }
  }
  finishOriginal() {
    if (this.runtimes.get('busy') !== this.producer) throw new Error('Original producer was replaced');
    this.sql("UPDATE thread_execution SET ended_at=1,result='original-result' WHERE id='original-execution'").run();
    this.sql("UPDATE thread_work SET status='done' WHERE id='original-work'").run();
    this.producer.busy = false; delete this.producer.executionId;
  }
  close() { this.closeCalls++; throw new Error('Busy producer must not be closed'); }
  cancel() { this.cancelCalls++; throw new Error('Busy producer must not be cancelled'); }
  suspend() { throw new Error('Intake must not be suspended'); }
  async detach() { this.closed = true; this.db.close(); return { ok: true }; }
}
`;

const daemonSource = `
import { DatabaseSync } from 'node:sqlite';
import { ThreadService } from './api.js';
export class Daemon {
  constructor(threadPath, ledgerPath) {
    this.threads = new ThreadService(threadPath); this.ledger = new DatabaseSync(ledgerPath);
    this.reconciling = false; this.completions = [];
    this.completionPool = { size: 0, start: id => {
      this.ledger.prepare("UPDATE run SET state='starting',worker_unit=? WHERE id=?").run('completion:' + id, id);
      this.completions.push(id);
    } };
    this.started = new Promise(resolve => this.signalStarted = resolve);
    this.stopped = new Promise(resolve => this.stop = resolve);
  }
  loadManifest() {} fillCapacity() {}
  async submitCompletion(id) {
    this.ledger.prepare("INSERT INTO run VALUES(?,'queued',NULL)").run(id);
    await this.reconcile(); return { ok: true };
  }
  async reconcile() {
    for (const { id } of this.ledger.prepare("SELECT id FROM run WHERE state='queued'").all()) this.completionPool.start(id);
  }
  async start() {
    await this.threads.start(); await this.submitCompletion('startup-completion');
    this.completionPool.start('startup-completion'); await this.reconcile();
    this.signalStarted(); await this.stopped;
  }
}
`;

const harnessSource = `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { join } from 'node:path';
import { installLegacyMaintenance, bridgeSocket, legacyFleetLedger, removeFence } from ${JSON.stringify(bridge)};
import { ThreadService } from './api.js';
import { Daemon } from './daemon.js';
const root = process.argv[2], mode = process.argv[3], identity = ${JSON.stringify({ candidate, legacySource })};
function database(name, cohort) {
  const path = join(root, name), db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE thread(id TEXT PRIMARY KEY,parent_id TEXT,held INTEGER DEFAULT 0,metadata TEXT DEFAULT '{}');" +
    "CREATE TABLE thread_work(id TEXT PRIMARY KEY,thread_id TEXT,sender_id TEXT,status TEXT);" +
    "CREATE TABLE thread_execution(id TEXT PRIMARY KEY,thread_id TEXT,work_id TEXT,ended_at INTEGER,result TEXT);" +
    "CREATE TABLE thread_request(id TEXT PRIMARY KEY,kind TEXT,target TEXT);" +
    "CREATE TABLE thread_question(id TEXT PRIMARY KEY,thread_id TEXT);" +
    "CREATE TABLE thread_wake(thread_id TEXT PRIMARY KEY,generation TEXT,delivered INTEGER,last_message_id TEXT);" +
    "INSERT INTO thread(id) VALUES('idle'),('wake-startup'),('wake-draining'),('busy');" +
    "INSERT INTO thread_question VALUES('question','idle');" +
    "INSERT INTO thread_wake VALUES('wake-startup','startup-schedule',0,NULL);"
  );
  if (cohort) {
    db.exec("INSERT INTO thread_work VALUES('original-work','busy',NULL,'dispatched');" +
      "INSERT INTO thread_execution VALUES('original-execution','busy','original-work',NULL,NULL);" +
      "INSERT INTO thread_work VALUES('already-queued','idle',NULL,'queued');");
    db.prepare('UPDATE thread SET metadata=? WHERE id=?').run(JSON.stringify({ runnerReference: {
      control: join(root, 'absent.sock'), socketPath: join(root, 'original.sock')
    } }), 'busy');
  }
  db.close(); return path;
}
function ledger(name) {
  const path = join(root, name), db = new DatabaseSync(path);
  db.exec('CREATE TABLE control(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE run(id TEXT PRIMARY KEY,state TEXT,worker_unit TEXT);');
  db.close(); return path;
}
async function intake(service, prefix) {
  for (const result of [
    await service.send({ requestId: prefix + ':input', threadId: 'idle' }),
    await service.spawn({ requestId: prefix + ':root' }),
    await service.spawn({ requestId: prefix + ':child', parentId: 'busy' }),
    await service.send({ requestId: prefix + ':peer-result', threadId: 'idle', senderId: 'busy' }),
    await service.answer({ requestId: prefix + ':answer', questionId: 'question' }),
    service.schedule({ requestId: prefix + ':schedule', threadId: 'wake-draining' })
  ]) assert.equal(result.ok, true);
  await service.deliverScheduledWakes();
  await service.wake(); await service.drain();
  assert.equal(service.suspended, false);
}
function control(method, path) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: bridgeSocket(process.getuid(), root), method, path, timeout: 1500 }, res => {
      let body = ''; res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve({ code: res.statusCode, value: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('Fixture control deadline')));
    req.on('error', reject); req.end();
  });
}
const baselinePath = database('baseline.sqlite3', false);
const baselineDaemon = mode === 'fleet' ? new Daemon(baselinePath, ledger('baseline-ledger.sqlite3')) : null;
const baseline = baselineDaemon ? baselineDaemon.threads : new ThreadService(baselinePath);
let baselineRun;
if (baselineDaemon) {
  baselineRun = baselineDaemon.start(); await baselineDaemon.started;
  assert.ok(baselineDaemon.completions.includes('startup-completion'));
  assert.equal((await baselineDaemon.submitCompletion('normal-request-completion')).ok, true);
  assert.ok(baselineDaemon.completions.includes('normal-request-completion'));
} else assert.equal((await baseline.start()).ok, true);
await intake(baseline, 'normal');
assert.deepEqual(new Set(baseline.dispatches), new Set([
  'startup-root', 'startup-input', 'wake:startup-schedule', 'normal:input', 'normal:root',
  'normal:child', 'normal:peer-result', 'normal:answer', 'wake:normal:schedule'
]));
if (baselineDaemon) { baselineDaemon.stop(); await baselineRun; baselineDaemon.ledger.close(); }
await baseline.detach();

assert.equal(baseline.routed, 1, 'the unfenced baseline routes notifications');
const originals = Object.fromEntries(['start','attach','wake','drain','detach','send','spawn','answer','schedule','deliverScheduledWakes','routeNotifications'].map(key => [key, ThreadService.prototype[key]]));
const originalReconcile = Daemon.prototype.reconcile;
const threadPath = database('threads.sqlite3', true), ledgerPath = mode === 'fleet' ? ledger('ledger.sqlite3') : null;
if (ledgerPath) assert.equal((await legacyFleetLedger(ledgerPath, identity)).ready, true);
assert.equal(await installLegacyMaintenance({ ...identity, dataDir: root, mode,
  oldApi: join(root, 'api.js'), transportModule: join(root, 'transport.mjs'), node: process.execPath,
  ...(ledgerPath ? { ledgerPath } : {}) }), true);
const daemon = mode === 'fleet' ? new Daemon(threadPath, ledgerPath) : null;
const service = daemon ? daemon.threads : new ThreadService(threadPath), producer = service.producer;
const originalCompletionStart = daemon?.completionPool.start;
let daemonRun;
if (daemon) { daemonRun = daemon.start(); await daemon.started; }
else assert.equal((await service.start()).ok, true);
for (const key of ['send','spawn','answer','schedule','deliverScheduledWakes']) assert.equal(ThreadService.prototype[key], originals[key]);
assert.equal(service.runtimes.get('busy'), producer);
assert.deepEqual(service.dispatches, [], 'Startup wake AND direct drain must be paused before originalStart');
assert.equal(service.routed, 0, 'cross-owner notification routing is paused with dispatch, so a retiring peer cannot hold readiness');
assert.equal(service.sql("SELECT count(*) AS n FROM thread_work WHERE status='queued'").get().n, 4);
assert.equal(service.sql("SELECT last_message_id FROM thread_wake WHERE thread_id='wake-startup'").get().last_message_id, 'wake:startup-schedule');
await intake(service, 'draining');
assert.deepEqual(service.dispatches, [], 'Every normal intake path must retain a queued successor receipt');
assert.equal(service.sql("SELECT count(*) AS n FROM thread_work WHERE status='queued'").get().n, 10);
assert.equal(service.sql("SELECT last_message_id FROM thread_wake WHERE thread_id='wake-draining'").get().last_message_id, 'wake:draining:schedule');
assert.equal((await service.send({ requestId: 'draining:input', threadId: 'idle' })).ok, true);
assert.equal(service.sql("SELECT count(*) AS n FROM thread_work WHERE id='draining:input'").get().n, 1, 'Request retry retains one receipt');
if (daemon) {
  assert.equal((await daemon.submitCompletion('draining-completion')).ok, true);
  daemon.completionPool.start('draining-completion'); await daemon.reconcile();
  assert.deepEqual(daemon.completions, [], 'Completion startup, normal request reconciliation and direct pool starts are gated');
  assert.equal(daemon.ledger.prepare("SELECT count(*) AS n FROM run WHERE state='queued'").get().n, 2);
}
const busy = await control('GET', '/status');
assert.equal(busy.code, 200); assert.equal(busy.value.ready, false);
assert.equal(busy.value.owners[0].busy.executions, 1);
const cannotClose = await control('POST', '/close');
assert.equal(cannotClose.value.phase, 'draining'); assert.equal(cannotClose.value.ready, false);
assert.equal(service.closeCalls, 0); assert.equal(service.cancelCalls, 0);
assert.equal(service.runtimes.get('busy'), producer); assert.equal(producer.busy, true);
assert.equal(service.execution('busy').id, 'original-execution');
assert.throws(() => removeFence(service, { ...identity, candidate: 'c'.repeat(40) }), /Another publication/);
await service.wake(); await service.drain(); assert.deepEqual(service.dispatches, []);
service.finishOriginal();
const ready = await control('GET', '/status');
assert.equal(ready.value.ready, true, JSON.stringify(ready));
assert.deepEqual(service.dispatches, [], 'Status reconciliation must not dispatch the queued successor after native settlement');
assert.equal(service.sql("SELECT result FROM thread_execution WHERE id='original-execution'").get().result, 'original-result');
assert.equal(service.sql("SELECT status FROM thread_work WHERE id='original-work'").get().status, 'done');
assert.equal(service.runtimes.get('busy'), producer);
const restored = await control('POST', '/restore');
assert.equal(restored.code, 200); assert.equal(restored.value.phase, 'restored');
assert.equal(restored.value.candidate, identity.candidate); assert.equal(restored.value.legacySource, identity.legacySource);
for (const [key, original] of Object.entries(originals)) assert.equal(ThreadService.prototype[key], original, key + ' restored exactly');
await service.wake(); await service.drain();
assert.equal(service.dispatches.length, 10);
assert.equal(service.sql("SELECT count(*) AS n FROM thread_work WHERE status='queued'").get().n, 0);
assert.equal((await service.spawn({ requestId: 'restored-root' })).ok, true);
assert.ok(service.dispatches.includes('restored-root'));
if (daemon) {
  assert.equal(Daemon.prototype.reconcile, originalReconcile);
  assert.equal(daemon.completionPool.start, originalCompletionStart);
  await daemon.reconcile();
  assert.deepEqual(daemon.completions, ['startup-completion', 'draining-completion']);
  assert.equal(daemon.ledger.prepare("SELECT count(*) AS n FROM control WHERE key='native-history-maintenance'").get().n, 0);
  assert.equal((await daemon.submitCompletion('restored-completion')).ok, true);
  assert.ok(daemon.completions.includes('restored-completion'));
  daemon.stop(); await daemonRun; daemon.ledger.close();
}
assert.equal(service.closeCalls, 0); assert.equal(service.cancelCalls, 0);
await service.detach();
console.log(JSON.stringify({ mode, queuedDuringRetirement: 10, normalDispatchResumed: true, originalResult: 'original-result' }));
process.exit(0);
`;

for (const mode of ['remote', 'fleet']) {
  test(`${mode}: finite native cohort preserves original producer, admits normal requests and restores exact dispatch`, { timeout: 10000 }, t => {
    const root = mkdtempSync(join(tmpdir(), 'native-dispatch-cohort-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'api.js'), apiSource);
    writeFileSync(join(root, 'daemon.js'), daemonSource);
    writeFileSync(join(root, 'transport.mjs'), 'export const runnerSocketDirectory = data => data;');
    writeFileSync(join(root, 'harness.mjs'), harnessSource);
    const run = spawnSync(process.execPath, [join(root, 'harness.mjs'), root, mode], { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 });
    assert.equal(run.status, 0, [run.error?.message, run.stdout, run.stderr].filter(Boolean).join('\n'));
    assert.deepEqual(JSON.parse(run.stdout.trim()), { mode, queuedDuringRetirement: 10, normalDispatchResumed: true, originalResult: 'original-result' });
  });
}

test('a ready owner closes independently of busy, missing and already migrated neighbours', { timeout: 1000 }, async () => {
  const owners = ['busy', 'ready-first', 'unavailable', 'migrated', 'ready-second'].map(unit => ({ unit }));
  const statuses = [
    { available: true, value: { phase: 'draining', ready: false } },
    { available: true, value: { phase: 'draining', ready: true } },
    { available: false, error: 'owner still starting' },
    { available: true, value: { phase: 'migrated' } },
    { available: true, value: { phase: 'draining', ready: true } }
  ];
  const closed = [], releases = [];
  const closing = closeReadyOwners(owners, statuses, owner => {
    closed.push(owner.unit);
    return new Promise(resolve => releases.push(() => resolve({ available: true, value: { phase: 'migrated', unit: owner.unit } })));
  });
  assert.deepEqual(closed, ['ready-first', 'ready-second'], 'Ready owners close concurrently without awaiting a busy neighbour or each other');
  for (const release of releases) release();
  const result = await closing;
  for (const index of [0, 2, 3]) assert.equal(result[index], statuses[index]);
  assert.equal(result[1].value.phase, 'migrated'); assert.equal(result[4].value.phase, 'migrated');
});
