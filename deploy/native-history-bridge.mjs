import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BRIDGE_PROTOCOL = 'native-history-maintenance-v1';
export function bridgeSocket(uid, dataDir) {
  const key = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16);
  const local = join(resolve(dataDir), `.native-history-${key}.sock`);
  return Buffer.byteLength(local) < 104 ? local : `/tmp/pi-history-${uid}-${key}.sock`;
}
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flush: true });
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function runnerRequest(path, request, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let body = '';
    const timer = setTimeout(() => socket.destroy(new Error('Legacy runner control timeout')), timeout);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) socket.destroy(new Error('Oversized legacy runner status')); else if (body.includes('\n')) { try { const value = JSON.parse(body.split('\n')[0]); clearTimeout(timer); socket.destroy(); resolve(value); } catch (error) { socket.destroy(error); } } });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

export function installFence(service, identity) {
  service.db.exec('SAVEPOINT history_fence');
  try {
  const row = service.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='pi_history_bridge'").get();
  service.db.exec(`CREATE TABLE IF NOT EXISTS pi_history_bridge(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pi_history_cohort(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS pi_history_questions(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL);`);
  if (!row) {
    service.sql("INSERT INTO pi_history_bridge VALUES('identity',?)").run(JSON.stringify(identity));
    service.db.exec('INSERT INTO pi_history_cohort SELECT id FROM thread; INSERT INTO pi_history_questions SELECT id,thread_id FROM thread_question;');
  } else {
    const recorded = JSON.parse(service.sql("SELECT value FROM pi_history_bridge WHERE key='identity'").get().value);
    if (recorded.candidate !== identity.candidate || recorded.legacySource !== identity.legacySource) throw new Error('Another publication owns the native history admission fence');
  }
  service.db.exec(`CREATE TRIGGER IF NOT EXISTS pi_history_children AFTER INSERT ON thread
    WHEN NEW.parent_id IN (SELECT id FROM pi_history_cohort)
    BEGIN INSERT OR IGNORE INTO pi_history_cohort VALUES(NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS pi_history_question_cohort AFTER INSERT ON thread_question
    WHEN NEW.thread_id IN (SELECT id FROM pi_history_cohort)
    BEGIN INSERT OR IGNORE INTO pi_history_questions VALUES(NEW.id,NEW.thread_id); END;
    CREATE TRIGGER IF NOT EXISTS pi_history_admission BEFORE INSERT ON thread_work
    WHEN EXISTS(SELECT 1 FROM pi_history_bridge WHERE key='closing') OR
      ((NEW.sender_id IS NULL OR NEW.sender_id NOT IN (SELECT id FROM pi_history_cohort)) AND
       NOT EXISTS(SELECT 1 FROM pi_history_questions WHERE thread_id=NEW.thread_id AND NEW.id='question-answer:'||id))
    BEGIN SELECT RAISE(ABORT,'Native history maintenance admission is closed; retry the same receipt after publication'); END;`);
  service.db.exec('RELEASE history_fence');
  } catch (error) {
    service.db.exec('ROLLBACK TO history_fence; RELEASE history_fence');
    throw error;
  }
}
export function removeFence(service) {
  service.db.exec('DROP TRIGGER IF EXISTS pi_history_admission; DROP TRIGGER IF EXISTS pi_history_children; DROP TRIGGER IF EXISTS pi_history_question_cohort; DROP TABLE IF EXISTS pi_history_questions; DROP TABLE IF EXISTS pi_history_cohort; DROP TABLE IF EXISTS pi_history_bridge;');
}
export async function legacyFleetLedger(path, identity, action = 'prepare') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: action === 'probe' });
  db.exec('PRAGMA busy_timeout=2000');
  const pendingCompletions = () => db.prepare(`SELECT count(*) AS n FROM run r WHERE r.state IN ('queued','starting','running')
    AND (r.worker_unit LIKE 'completion:%' OR EXISTS(SELECT 1 FROM control WHERE key='completion-run:'||r.id))`).get().n;
  if (action === 'probe') {
    try { const pending = pendingCompletions(); return { ready: pending === 0, pendingCompletions: pending }; }
    finally { db.close(); }
  }
  let entered = false;
  try {
    db.exec('BEGIN IMMEDIATE'); entered = true;
    if (action === 'restore') {
      const row = db.prepare("SELECT value FROM control WHERE key='native-history-maintenance'").get();
      if (row && row.value !== JSON.stringify(identity)) throw new Error('Another publication owns the fleet admission fence');
      db.exec('DROP TRIGGER IF EXISTS pi_history_completion_admission');
      db.prepare("DELETE FROM control WHERE key='native-history-maintenance'").run();
      db.exec('COMMIT'); return { ready: true };
    }
    const row = db.prepare("SELECT value FROM control WHERE key='native-history-maintenance'").get();
    if (row && row.value !== JSON.stringify(identity)) throw new Error('Another publication owns the fleet admission fence');
    db.prepare("INSERT OR REPLACE INTO control(key,value) VALUES('native-history-maintenance',?)").run(JSON.stringify(identity));
    db.exec(`CREATE TRIGGER IF NOT EXISTS pi_history_completion_admission BEFORE INSERT ON run
      BEGIN SELECT RAISE(ABORT,'Native history maintenance admission is closed; retry the same completion receipt after publication'); END;`);
    const pending = pendingCompletions();
    db.exec('COMMIT'); return { ready: pending === 0, pendingCompletions: pending };
  } catch (error) {
    if (entered) db.exec('ROLLBACK');
    if (error.errcode === 5 || error.errcode === 6) return { ready: false, reason: 'Owner ledger transaction is still active' };
    throw error;
  }
  finally { db.close(); }
}
export function serviceBusy(service) {
  const work = service.sql(`SELECT count(*) AS n FROM thread_work w JOIN thread t ON t.id=w.thread_id
    WHERE w.status!='done' AND t.held=0 AND json_extract(t.metadata,'$.archived') IS NOT 1`).get().n;
  const executions = service.sql('SELECT count(*) AS n FROM thread_execution WHERE ended_at IS NULL').get().n;
  const operations = ['operations','opening','halts','dependencyOperations'].reduce((count, key) => count + (service[key]?.size ?? 0), 0);
  const native = [...service.runtimes.values()].filter(runtime => runtime.busy || runtime.executionId || runtime.commandRunning || runtime.waiters?.size).length;
  return { work, executions, operations, native };
}

const legacyAttachments = new WeakMap();
export async function attachLegacyRuntime(service, original, id, recoverMissing = false) {
  let pending = legacyAttachments.get(service);
  if (!pending) { pending = new Map(); legacyAttachments.set(service, pending); }
  if (pending.has(id)) return pending.get(id);
  const existing = service.runtimes.get(id);
  if (existing) return existing;
  const attaching = Promise.resolve().then(() => original.call(service, id, recoverMissing));
  pending.set(id, attaching);
  try { return await attaching; } finally { pending.delete(id); }
}

export async function reconcileLegacyRuntime(service, id) {
  if (service.opening.has(id) || service.operations.has(id) || service.halts.has(id)) return;
  const runtime = await service.attach(id);
  if (!runtime) {
    if (service.get(id)?.metadata?.runnerReference) throw new Error('Legacy attachment has not proven producer absence');
    return;
  }
  if (runtime.commandRunning || runtime.waiters.size) return;
  const state = await service.rpc(runtime, { type: 'get_state' });
  if (typeof state?.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean'
    || !Number.isSafeInteger(state.localTools) || state.localTools < 0
    || !Number.isSafeInteger(state.pendingCommandCount) || state.pendingCommandCount < 0) {
    throw new Error('Legacy runtime returned an incomplete execution-state proof');
  }
  if (service.runtimes.get(id) !== runtime) throw new Error('Legacy runtime changed during state reconciliation');
  service.adoptReference(id, state);
  runtime.busy = service.busy(state);
  if (!runtime.busy) service.wake(id);
}

export async function installLegacyMaintenance(options) {
  if (!/^[0-9a-f]{40}$/.test(options.candidate) || !/^[0-9a-f]{40}$/.test(options.legacySource)) throw new Error('Maintenance requires immutable source identities');
  const uid = process.getuid();
  const dataDir = resolve(options.dataDir), receiptPath = join(dataDir, 'native-history-maintenance.json');
  const identity = { candidate: options.candidate, legacySource: options.legacySource };
  let receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : { version: 1, protocol: BRIDGE_PROTOCOL, uid, dataDir, ...identity, admittedAt: Date.now(), phase: 'draining' };
  if (receipt.uid !== uid || receipt.dataDir !== dataDir || receipt.candidate !== identity.candidate || receipt.legacySource !== identity.legacySource) throw new Error('Native history maintenance receipt custody mismatch');
  const save = phase => { receipt = { ...receipt, phase, updatedAt: new Date().toISOString() }; atomicJson(receiptPath, receipt); };
  if (receipt.phase === 'restored') return true;
  if (receipt.phase === 'closing') save('draining');
  const services = new Set(), controls = new Set(), daemons = new Set();
  let restoreDaemonAdmission = () => {};
  if (options.mode === 'fleet' && receipt.phase === 'draining') {
    if (typeof options.ledgerPath !== 'string' || !options.ledgerPath.startsWith('/')) throw new Error('Fleet maintenance needs its exact owner ledger');
    receipt.ledgerPath = options.ledgerPath;
    const { Daemon } = await import(pathToFileURL(join(dirname(options.oldApi), 'daemon.js')).href);
    if (!['start','loadManifest','fillCapacity'].every(key => typeof Daemon?.prototype[key] === 'function')) throw new Error('Selected old fleet has no completion custody seam');
    const loadManifest = Daemon.prototype.loadManifest, fillCapacity = Daemon.prototype.fillCapacity;
    Daemon.prototype.loadManifest = async function() {}; Daemon.prototype.fillCapacity = async function() {};
    restoreDaemonAdmission = () => { Daemon.prototype.loadManifest = loadManifest; Daemon.prototype.fillCapacity = fillCapacity; };
    const start = Daemon.prototype.start;
    Daemon.prototype.start = async function(...args) {
      daemons.add(this);
      try { return await start.apply(this, args); }
      finally {
        if (receipt.phase === 'owners-closed') {
          try { releaseFleetLedger(); delete receipt.error; save('migrated'); if (options.autoAdvance === true) originalExit(75); }
          catch (error) { receipt.error = String(error); save('migration-pending'); originalExit(1); }
        }
      }
    };
  }
  const originalExit = process.exit.bind(process);
  const api = await import(pathToFileURL(options.oldApi).href);
  const prototype = api.ThreadService?.prototype;
  if (!prototype || !['start','close','attach','send','spawn','deliverScheduledWakes','rpc','busy','adoptReference','wake'].every(key => typeof prototype[key] === 'function')) throw new Error('Selected legacy ThreadService has no supported maintenance seam');
  const originalStart = prototype.start, originalSend = prototype.send, originalSpawn = prototype.spawn, originalWakes = prototype.deliverScheduledWakes, originalAttach = prototype.attach;
  prototype.attach = function(id, recoverMissing = false) { return attachLegacyRuntime(this, originalAttach, id, recoverMissing); };
  const rejecting = () => ({ ok: false, error: { code: 'unavailable', retryable: true, message: 'Native history maintenance admission is closed; retry the same receipt after publication' } });
  const allowed = async (service, id) => {
    installFence(service, identity);
    if (typeof id !== 'string') return false;
    if (service.sql('SELECT id FROM pi_history_cohort WHERE id=?').get(id)) return true;
    // The fleet/person directory can route an admitted parent or completion across
    // ledgers. Resolve only its public ancestry; no other owner's history is read.
    if (!service.directory || !Number.isSafeInteger(receipt.admittedAt)) return false;
    const visited = new Set(); let ancestor = id;
    for (let depth = 0; depth < 64 && ancestor && !visited.has(ancestor); depth++) {
      visited.add(ancestor);
      const found = await service.directory.list({ id: ancestor, limit: 1 });
      if (!found.ok) return false;
      const thread = found.value.threads.find(thread => thread.id === ancestor);
      if (!thread) return false;
      if (service.sql('SELECT id FROM pi_history_cohort WHERE id=?').get(ancestor)
        || (Number.isSafeInteger(thread.createdAt) && thread.createdAt <= receipt.admittedAt)) {
        service.sql('INSERT OR IGNORE INTO pi_history_cohort VALUES(?)').run(id); return true;
      }
      ancestor = thread.parentId;
    }
    return false;
  };
  prototype.start = async function(...args) { installFence(this, identity); this.sql("DELETE FROM pi_history_bridge WHERE key='closing'").run(); services.add(this); return originalStart.apply(this, args); };
  const recordedRequest = (service, input) => typeof input?.requestId === 'string'
    && !!service.sql('SELECT id FROM thread_request WHERE id=?').get(input.requestId);
  prototype.send = async function(input) {
    if (receipt.phase !== 'draining') return rejecting();
    if (recordedRequest(this, input)) return originalSend.call(this, input); // Old owner validates the exact receipt/hash.
    return await allowed(this, input.senderId) && receipt.phase === 'draining' ? originalSend.call(this, input) : rejecting();
  };
  prototype.spawn = async function(input) {
    if (receipt.phase !== 'draining') return rejecting();
    if (recordedRequest(this, input)) return originalSpawn.call(this, input);
    return await allowed(this, input.parentId) && receipt.phase === 'draining' ? originalSpawn.call(this, input) : rejecting();
  };
  prototype.deliverScheduledWakes = function() {}; // Schedules remain durable; new wakes resume on the candidate.
  const extension = options.oldApi.endsWith('.ts') ? '.ts' : options.oldApi.endsWith('.js') ? '.js' : null;
  const transportPath = options.transportModule ?? (extension ? join(dirname(options.oldApi), 'threads', `runner-transport${extension}`) : null);
  if (!transportPath) throw new Error('Selected legacy runner transport source is unknown');
  const transport = await import(pathToFileURL(transportPath).href);
  if (typeof transport.runnerSocketDirectory !== 'function') throw new Error('Selected legacy transport has no native ownership census');
  const socketDir = transport.runnerSocketDirectory(dataDir, uid);
  async function status() {
    if (receipt.phase !== 'draining') return receipt;
    if (!services.size) return { ...receipt, ready: false, reason: 'Legacy owner has not registered its thread services' };
    let ready = true; const owners = [];
    if (options.mode === 'fleet') {
      if (!daemons.size) return { ...receipt, ready: false, reason: 'Old fleet completion owner has not registered' };
      for (const daemon of daemons) {
        if (!daemon.completionPool || typeof daemon.completionPool.size !== 'number' || typeof daemon.reconciling !== 'boolean') throw new Error('Old fleet completion custody is unknown');
        if (daemon.completionPool.size || daemon.reconciling) ready = false;
      }
    }
    for (const service of services) {
      const references = service.sql("SELECT id,json_extract(metadata,'$.runnerReference') AS reference FROM thread WHERE json_extract(metadata,'$.runnerReference') IS NOT NULL").all();
      for (const row of references) {
        const reference = JSON.parse(row.reference);
        controls.add(reference.control);
        await reconcileLegacyRuntime(service, row.id);
      }
      const busy = serviceBusy(service), spools = [];
      for (const row of service.sql("SELECT json_extract(metadata,'$.runnerReference') AS reference FROM thread WHERE json_extract(metadata,'$.runnerReference') IS NOT NULL").all()) {
        const reference = JSON.parse(row.reference), path = `${reference.socketPath}.events`;
        if (existsSync(path) && statSync(path).size) spools.push(path);
      }
      if (Object.values(busy).some(Boolean) || spools.length) ready = false;
      owners.push({ database: service.options.databasePath, busy, unacknowledgedSpools: spools.length });
    }
    const known = new Set([...services].flatMap(service => service.sql('SELECT id FROM thread').all().map(row => row.id)));
    const directory = join(socketDir, 'thread-runners');
    if (existsSync(directory)) for (const name of readdirSync(directory).filter(name => name.endsWith('.sock'))) {
      const control = join(directory, name);
      let native;
      try { native = await runnerRequest(control, { type: 'status' }); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') continue; throw error; }
      if (native.ok !== true || !Array.isArray(native.threadIds)) throw new Error('Legacy native ownership census is incomplete');
      if (native.threadIds.some(id => !known.has(id))) throw new Error('Legacy native owner is not mapped to its preserved thread ledger; custody requires repair');
      if (native.activeSessions !== 0) ready = false;
      controls.add(control);
    }
    return { ...receipt, ready, owners };
  }
  let closing;
  async function closeOwners() {
    if (closing) return closing;
    closing = (async () => {
      const current = await status(); if (!current.ready) return current;
      for (const service of services) service.sql("INSERT OR REPLACE INTO pi_history_bridge VALUES('closing','1')").run();
      const raced = [...services].some(service => Object.values(serviceBusy(service)).some(Boolean));
      if (raced) { for (const service of services) service.sql("DELETE FROM pi_history_bridge WHERE key='closing'").run(); return { ...receipt, ready: false, reason: 'Accepted work raced final admission closure' }; }
      save('closing');
      for (const service of services) { const result = await service.close(); if (!result.ok) throw new Error(`Legacy owner close refused: ${result.error.message}`); }
      for (const control of controls) {
        try { const result = await runnerRequest(control, { type: 'drain' }); if (result.ok !== true) throw new Error('Legacy runner refused idle retirement'); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error; }
      }
      for (const control of controls) {
        const deadline = Date.now() + 3000;
        while (existsSync(control) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        if (existsSync(control)) throw new Error('Legacy runner control still exists after acknowledged retirement');
      }
      receipt.databases = [...services].map(service => service.options.databasePath);
      save('owners-closed');
      // The old release closes capture/image/server databases before calling process.exit.
      if (options.mode === 'fleet') {
        for (const service of services) dropFenceFile(service.options.databasePath);
        process.emit('SIGTERM'); // Daemon.start acknowledges provider/resource closure before marking migrated.
      } else process.emit('SIGUSR2');
      return receipt;
    })().finally(() => { closing = undefined; });
    return closing;
  }
  function releaseFleetLedger() {
    if (typeof receipt.ledgerPath !== 'string' || !receipt.ledgerPath.startsWith('/')) throw new Error('Fleet closure has no exact ledger custody');
    const released = spawnSync(options.node ?? '/usr/local/bin/node', ['--input-type=module', '-e', `const {legacyFleetLedger}=await import(process.argv[1]); const result=await legacyFleetLedger(process.argv[2],JSON.parse(process.argv[3]),'restore'); if(result.ready!==true)throw new Error('Fleet ledger fence release remains pending');`, import.meta.url, receipt.ledgerPath, JSON.stringify(identity)], { encoding: 'utf8', timeout: 3000 });
    if (released.status !== 0) throw new Error(`Cannot release fleet admission fence: ${released.stderr}`);
  }
  function dropFenceFile(path) {
    const removed = spawnSync(options.node ?? '/usr/local/bin/node', ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('DROP TRIGGER IF EXISTS pi_history_admission; DROP TRIGGER IF EXISTS pi_history_children; DROP TRIGGER IF EXISTS pi_history_question_cohort; DROP TABLE IF EXISTS pi_history_questions; DROP TABLE IF EXISTS pi_history_cohort; DROP TABLE IF EXISTS pi_history_bridge;'); db.close();`, path], { encoding: 'utf8', timeout: 3000 });
    if (removed.status !== 0) throw new Error(`Cannot release preserved maintenance fence: ${removed.stderr}`);
  }
  async function migrate() {
    const result = spawnSync(options.node ?? '/usr/local/bin/node', [options.migrator, '--supervisor-db', join(dataDir, 'supervisor.sqlite3'), '--thread-db', join(dataDir, 'threads.sqlite3'), '--output-dir', join(dataDir, 'native-history-retirement'), '--writers-stopped'], { encoding: 'utf8', timeout: 45000 });
    if (result.status !== 0) { receipt.error = result.error?.message ?? result.stderr; save('migration-pending'); return; }
    // Maintenance admission tables belong only to the old controller, not the new runtime.
    dropFenceFile(join(dataDir, 'threads.sqlite3'));
    atomicJson(join(dataDir, 'native-history-readiness.json'), { version: 1, contract: 'native-history-v1', uid, dataDir, state: 'ready', writersStopped: true, retainedOutput: 'acknowledged', ...identity, migratedAt: new Date().toISOString() });
    delete receipt.error; save('migrated');
  }
  let exitPending = false;
  process.exit = code => {
    if (receipt.phase === 'owners-closed' && !exitPending) {
      exitPending = true;
      void migrate().then(() => originalExit(receipt.phase === 'migrated' ? 75 : 1)).catch(error => { receipt.error = String(error); save('migration-pending'); originalExit(1); });
      return;
    }
    originalExit(code);
  };
  const socketPath = bridgeSocket(uid, dataDir);
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((request, response) => { void (async () => {
    let value;
    if (request.method === 'GET' && request.url === '/status') value = await status();
    else if (request.method === 'POST' && request.url === '/close') value = await closeOwners();
    else if (request.method === 'POST' && request.url === '/restore') {
      if (receipt.phase !== 'draining' && receipt.phase !== 'restored') throw new Error('Native owner closure has started; resume preserving migration instead of restoring the old decoder');
      for (const service of services) if (!service.closed) removeFence(service);
      if (options.mode === 'fleet') releaseFleetLedger();
      restoreDaemonAdmission();
      prototype.start = originalStart; prototype.send = originalSend; prototype.spawn = originalSpawn; prototype.deliverScheduledWakes = originalWakes; prototype.attach = originalAttach;
      save('restored'); value = receipt;
    }
    else { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
  })().catch(error => { response.writeHead(503); response.end(JSON.stringify({ ...receipt, error: String(error) })); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  if (['owners-closed', 'migration-pending'].includes(receipt.phase)) {
    if (options.mode === 'fleet') {
      if (!Array.isArray(receipt.databases) || receipt.databases.some(path => typeof path !== 'string' || !path.startsWith('/'))) throw new Error('Interrupted fleet closure has no preserved database custody');
      for (const path of receipt.databases) dropFenceFile(path);
      releaseFleetLedger(); save('migrated');
    } else {
      await migrate();
      if (receipt.phase !== 'migrated') throw new Error(`Private native history migration remains pending: ${receipt.error}`);
    }
  }
  if (receipt.phase === 'migrated') {
    if (options.autoAdvance === true) originalExit(75);
    process.on('SIGUSR2', () => originalExit(75)); return false;
  }
  save('draining');
  if (options.autoAdvance === true) {
    let checking = false;
    const timer = setInterval(() => {
      if (checking || receipt.phase !== 'draining') return;
      checking = true;
      void status().then(value => value.ready ? closeOwners() : undefined).catch(error => {
        receipt.error = String(error); save('draining'); console.error(`Native history maintenance: ${error}`);
      }).finally(() => { checking = false; });
    }, 1000);
    timer.unref();
  }
  return true;
}
