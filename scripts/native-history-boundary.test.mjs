import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { once } from 'node:events';
import { installFence, removeFence, serviceBusy, bridgeSocket, legacyFleetLedger } from '../deploy/native-history-bridge.mjs';
import { allOwnersReady, stageRemote, stageFleet, selectPointer } from '../deploy/native-history-coordinator.mjs';
const old = 'a'.repeat(40), candidate = 'b'.repeat(40);
function directory(t) { const path = mkdtempSync(join(tmpdir(), 'history-boundary-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function database(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE thread(id TEXT PRIMARY KEY,parent_id TEXT,held INTEGER DEFAULT 0,metadata TEXT DEFAULT '{}',session_file TEXT);
    CREATE TABLE thread_work(id TEXT PRIMARY KEY,thread_id TEXT,sender_id TEXT,status TEXT);
    CREATE TABLE thread_execution(id TEXT,ended_at INTEGER);
    CREATE TABLE thread_question(id TEXT PRIMARY KEY,thread_id TEXT);
    CREATE TABLE thread_request(id TEXT PRIMARY KEY,hash TEXT,kind TEXT,target TEXT);
    INSERT INTO thread(id) VALUES('accepted');`);
  return { db, sql: sql => db.prepare(sql), runtimes: new Map(), operations: new Map(), opening: new Map(), halts: new Map(), dependencyOperations: new Map() };
}
test('durable admission fence preserves admitted roots/children/receipts but refuses new external roots and incompatible custody', t => {
  const path = directory(t), service = database(join(path, 'threads.sqlite3'));
  service.sql("INSERT INTO thread_work VALUES('receipt','accepted',NULL,'queued')").run();
  installFence(service, { candidate, legacySource: old });
  assert.equal(serviceBusy(service).work, 1);
  assert.throws(() => service.sql("INSERT INTO thread_work VALUES('external','accepted',NULL,'queued')").run(), /admission is closed/);
  service.sql("INSERT INTO thread(id,parent_id) VALUES('child','accepted')").run();
  service.sql("INSERT INTO thread_work VALUES('child-receipt','child','accepted','queued')").run();
  service.sql("INSERT INTO thread_work VALUES('result-receipt','accepted','child','queued')").run();
  service.sql("INSERT INTO thread_question VALUES('pending-question','accepted')").run();
  service.sql("INSERT INTO thread_work VALUES('question-answer:pending-question','accepted',NULL,'queued')").run();
  assert.equal(service.sql('SELECT count(*) AS n FROM thread_work').get().n, 4);
  service.sql("INSERT INTO pi_history_bridge VALUES('closing','1')").run();
  assert.throws(() => service.sql("INSERT INTO thread_work VALUES('raced','accepted','child','queued')").run(), /admission is closed/);
  assert.throws(() => installFence(service, { candidate: 'c'.repeat(40), legacySource: old }), /Another publication/);
  removeFence(service);
  service.sql("INSERT INTO thread_work VALUES('after','accepted',NULL,'queued')").run();
  service.db.close();
});
test('transient wrappers pin old modules and source identity without rewriting the immutable selected release', t => {
  const root = directory(t), remote = join(root, 'old-remote'), fleet = join(root, 'old-fleet');
  mkdirSync(join(remote, 'server'), { recursive: true }); mkdirSync(join(fleet, 'dist'), { recursive: true });
  writeFileSync(join(remote, '.pi-stack-commit'), old); writeFileSync(join(remote, 'server/main.ts'), 'original remote');
  writeFileSync(join(fleet, '.pi-stack-commit'), old); writeFileSync(join(fleet, 'dist/cli.js'), 'original fleet');
  const stagedRemote = join(root, 'remote'), stagedFleet = join(root, 'fleet');
  stageRemote(remote, stagedRemote, '/immutable/legacy.json'); stageFleet(fleet, stagedFleet, '/immutable/legacy.json');
  // A restarted coordinator completes the same staged generation, not another release.
  stageRemote(remote, stagedRemote, '/immutable/legacy.json'); stageFleet(fleet, stagedFleet, '/immutable/legacy.json');
  assert.equal(readFileSync(join(remote, 'server/main.ts'), 'utf8'), 'original remote');
  assert.equal(readFileSync(join(fleet, 'dist/cli.js'), 'utf8'), 'original fleet');
  assert.equal(readFileSync(join(stagedRemote, '.pi-stack-commit'), 'utf8'), old);
  assert.match(readFileSync(join(stagedRemote, 'server/main.ts'), 'utf8'), /legacyRemote/);
  const selected = join(root, 'selected'); selectPointer(selected, stagedRemote); assert.equal(realpathSync(selected), stagedRemote);
  assert.equal(allOwnersReady([{ available: false }]), false);
  assert.equal(allOwnersReady([{ available: true, value: { phase: 'draining', ready: false } }]), false);
  assert.equal(allOwnersReady([{ available: true, value: { phase: 'draining', ready: true } }]), true);
  assert.equal(allOwnersReady([{ available: true, value: { phase: 'migrated' } }]), true);
});
function control(socketPath, method, path) {
  return new Promise((resolve, reject) => { const req = request({ socketPath, method, path }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }); req.on('error', reject); req.end(); });
}
test('old owner drains existing work/output, closes before private migration, and replay keeps exact native receipt/thinking', async t => {
  const root = directory(t), threadPath = join(root, 'threads.sqlite3');
  const service = database(threadPath);
  const native = join(root, 'native.jsonl'), message = { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'answer' }] };
  const receipt = '{"type":"custom","id":"receipt","parentId":null,"customType":"thread_landed","data":{"workId":"exact-id"}}\n';
  writeFileSync(native, '{"type":"session","id":"session","version":3}\n' + receipt + JSON.stringify({ type: 'message', id: 'assistant', parentId: 'receipt', message }) + '\n');
  service.sql('UPDATE thread SET session_file=?').run(native);
  service.sql("INSERT INTO thread_work VALUES('exact-id','accepted',NULL,'accepted')").run();
  service.sql("INSERT INTO thread_execution VALUES('execution',NULL)").run();
  const socketPrefix = join(root, 'native.sock'), spool = `${socketPrefix}.events`;
  writeFileSync(spool, '{"sequence":1,"line":"old durable output"}\n');
  service.sql('UPDATE thread SET metadata=?').run(JSON.stringify({ runnerReference: { control: join(root, 'absent-control.sock'), socketPath: socketPrefix } }));
  service.db.close();
  const supervisor = new DatabaseSync(join(root, 'supervisor.sqlite3'));
  supervisor.exec('CREATE TABLE session_contexts(id INTEGER PRIMARY KEY, body BLOB); CREATE TABLE message_facts(session_id TEXT,finalizes_message TEXT,thinking TEXT,metrics TEXT,PRIMARY KEY(session_id,finalizes_message));');
  supervisor.prepare('INSERT INTO session_contexts VALUES(1,?)').run(Buffer.from([0,255,10]));
  const key = createHash('sha256').update(JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content })).digest('hex');
  supervisor.prepare("INSERT INTO message_facts VALUES('accepted',?,'retained thinking',NULL)").run(key); supervisor.close();
  const fakeApi = join(root, 'api.mjs'), bridge = resolve('deploy/native-history-bridge.mjs'), transportModule = join(root, 'transport.mjs');
  writeFileSync(transportModule, 'export const runnerSocketDirectory = data => data;');
  writeFileSync(fakeApi, `import {DatabaseSync} from 'node:sqlite'; export class ThreadService {
    constructor(path){this.options={databasePath:path};this.db=new DatabaseSync(path);this.runtimes=new Map();this.operations=new Map();this.opening=new Map();this.halts=new Map();this.dependencyOperations=new Map();this.directory={list:async({id})=>({ok:true,value:{threads:id==='remote-parent'?[{id,createdAt:0}]:id==='remote-child'?[{id,createdAt:Date.now()+100000,parentId:'remote-parent'}]:[]}})};}
    sql(sql){return this.db.prepare(sql)} async start(){return {ok:true}} async attach(){} async send(){return {ok:true}} async spawn(){return {ok:true}} deliverScheduledWakes(){}
    async close(){this.db.exec("UPDATE thread SET metadata=json_remove(metadata,'$.runnerReference')");this.db.close();this.closed=true;return {ok:true}}
  }`);
  const harness = join(root, 'harness.mjs');
  writeFileSync(harness, `import {installLegacyMaintenance} from ${JSON.stringify(pathToFileURL(bridge).href)}; import {ThreadService} from './api.mjs';
    const run=await installLegacyMaintenance(${JSON.stringify({ candidate, legacySource: old, dataDir: root, oldApi: fakeApi, transportModule, migrator: resolve('scripts/migrate-native-history.mjs'), node: process.execPath })});
    if(run){const service=new ThreadService(${JSON.stringify(threadPath)});await service.start();process.on('SIGUSR2',()=>process.exit(75));
      const admitted=await service.spawn({requestId:'admitted-child',parentId:'accepted'});
      const crossOwner=await service.spawn({requestId:'cross-owner-child',parentId:'remote-child'});
      const denied=await service.spawn({requestId:'new-external-root'});
      service.sql("INSERT INTO thread_request VALUES('accepted-root-retry','exact-hash','spawn','accepted')").run();
      const replay=await service.spawn({requestId:'accepted-root-retry'});
      console.log(JSON.stringify({admitted:admitted.ok,crossOwner:crossOwner.ok,denied:denied.ok,replay:replay.ok}));
    }`);
  const child = spawn(process.execPath, [harness], { stdio: ['ignore','pipe','pipe'] });
  let errors = ''; child.stderr.on('data', chunk => errors += chunk);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const [started] = await once(child.stdout, 'data');
  assert.deepEqual(JSON.parse(started.toString()), { admitted: true, crossOwner: true, denied: false, replay: true });
  const socket = bridgeSocket(process.getuid(), root);
  const busy = await control(socket, 'GET', '/status');
  assert.equal(busy.ready, false); assert.equal(busy.owners[0].busy.executions, 1);
  const settled = new DatabaseSync(threadPath); settled.exec("UPDATE thread_work SET status='done'; UPDATE thread_execution SET ended_at=1;"); settled.close();
  const unacknowledged = await control(socket, 'GET', '/status');
  assert.equal(unacknowledged.ready, false); assert.equal(unacknowledged.owners[0].unacknowledgedSpools, 1);
  truncateSync(spool, 0); // The fixture's OLD decoder has now ACKed the retained output.
  const ready = await control(socket, 'GET', '/status'); assert.equal(ready.ready, true);
  const exit = once(child, 'exit');
  await control(socket, 'POST', '/close').catch(() => {});
  const [code] = await exit; assert.equal(code, 75, errors);
  const preserved = readFileSync(native, 'utf8'); assert.ok(preserved.includes(receipt)); assert.match(preserved, /retained thinking/);
  const readiness = JSON.parse(readFileSync(join(root, 'native-history-readiness.json'), 'utf8'));
  assert.equal(readiness.writersStopped, true); assert.equal(readiness.retainedOutput, 'acknowledged');
  assert.equal(JSON.parse(readFileSync(join(root, 'native-history-maintenance.json'), 'utf8')).phase, 'migrated');
  const snapshotFiles = new DatabaseSync(join(root, 'supervisor.sqlite3'));
  assert.equal(snapshotFiles.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='session_contexts'").get().n, 0); snapshotFiles.close();
}, { timeout: 5000 });
test('fleet adoption fences fresh completions while old accepted provider work settles, without cancellation', async t => {
  const root = directory(t), path = join(root, 'ledger.sqlite3'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE control(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE run(id TEXT PRIMARY KEY,state TEXT,worker_unit TEXT);
    INSERT INTO run VALUES('accepted','running','completion:accepted');`);
  const identity = { candidate, legacySource: old };
  assert.deepEqual(await legacyFleetLedger(path, identity, 'probe'), { ready: false, pendingCompletions: 1 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM control').get().n, 0);
  assert.deepEqual(await legacyFleetLedger(path, identity), { ready: false, pendingCompletions: 1 });
  assert.equal(db.prepare("SELECT state FROM run WHERE id='accepted'").get().state, 'running');
  assert.throws(() => db.exec("INSERT INTO run VALUES('new','queued',NULL)"), /admission is closed/);
  await assert.rejects(legacyFleetLedger(path, { ...identity, candidate: 'c'.repeat(40) }), /Another publication/);
  db.exec("UPDATE run SET state='done'");
  assert.deepEqual(await legacyFleetLedger(path, identity), { ready: true, pendingCompletions: 0 });
  await legacyFleetLedger(path, identity, 'restore');
  db.exec("INSERT INTO run VALUES('after','queued',NULL)"); db.close();
});
test('interrupted fleet closure releases its durable fences and locked bootstrap advances without reopening old work', async t => {
  const root = directory(t), threadPath = join(root, 'threads.sqlite3');
  const service = database(threadPath);
  installFence(service, { candidate, legacySource: old }); service.db.close();
  const ledgerPath = join(root, 'ledger.sqlite3'), ledger = new DatabaseSync(ledgerPath);
  ledger.exec('CREATE TABLE control(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE run(id TEXT PRIMARY KEY,state TEXT,worker_unit TEXT);'); ledger.close();
  await legacyFleetLedger(ledgerPath, { candidate, legacySource: old });
  writeFileSync(join(root, 'native-history-maintenance.json'), JSON.stringify({ version: 1, protocol: 'native-history-maintenance-v1', uid: process.getuid(), dataDir: root, candidate, legacySource: old, phase: 'owners-closed', databases: [threadPath], ledgerPath }));
  const oldApi = join(root, 'api.mjs'), transportModule = join(root, 'transport.mjs');
  writeFileSync(oldApi, 'export class ThreadService {start(){} close(){} attach(){} send(){} spawn(){} deliverScheduledWakes(){}}');
  writeFileSync(transportModule, 'export const runnerSocketDirectory = data => data;');
  const harness = join(root, 'resume.mjs');
  writeFileSync(harness, `import {installLegacyMaintenance} from ${JSON.stringify(pathToFileURL(resolve('deploy/native-history-bridge.mjs')).href)}; await installLegacyMaintenance(${JSON.stringify({ candidate, legacySource: old, dataDir: root, oldApi, transportModule, mode: 'fleet', autoAdvance: true, node: process.execPath })}); throw new Error('Old work must not reopen');`);
  const child = spawn(process.execPath, [harness], { stdio: ['ignore','pipe','pipe'] });
  let errors = ''; child.stderr.on('data', chunk => errors += chunk);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const [code] = await once(child, 'exit'); assert.equal(code, 75, errors);
  assert.equal(JSON.parse(readFileSync(join(root, 'native-history-maintenance.json'), 'utf8')).phase, 'migrated');
  const db = new DatabaseSync(threadPath);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='pi_history_bridge'").get().n, 0); db.close();
}, { timeout: 5000 });
