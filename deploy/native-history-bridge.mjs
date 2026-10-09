import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, lstatSync, unlinkSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

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

export async function probeBridgeSocket(path) {
  try {
    let before;
    try { before = lstatSync(path); }
    catch (error) { if (error.code === 'ENOENT') return { ok: true, value: { kind: 'absent' } }; throw error; }
    if (!before.isSocket() || before.uid !== process.getuid()) return { ok: false, error: { code: 'unrelated-file', message: 'Maintenance endpoint has unrelated file custody' } };
    const kind = await new Promise((resolve, reject) => {
      const socket = createConnection(path);
      const timer = setTimeout(() => socket.destroy(new Error('Maintenance endpoint custody probe timed out')), 1000);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('live'); });
      socket.once('error', error => {
        clearTimeout(timer);
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve('stale'); else reject(error);
      });
    });
    return { ok: true, value: { kind, dev: before.dev, ino: before.ino } };
  } catch (error) { return { ok: false, error: { code: 'unavailable', message: String(error) } }; }
}

export async function prepareBridgeSocket(path) {
  const observed = await probeBridgeSocket(path);
  if (!observed.ok) return observed;
  if (observed.value.kind === 'absent') return { ok: true, value: 'available' };
  if (observed.value.kind === 'live') return { ok: false, error: { code: 'live-owner', message: 'Another live controller owns the maintenance endpoint' } };
  if (observed.value.kind !== 'stale') return { ok: false, error: { code: 'invalid-proof', message: 'Unknown maintenance endpoint proof' } };
  try {
    let current;
    try { current = lstatSync(path); }
    catch (error) { if (error.code === 'ENOENT') return { ok: true, value: 'available' }; throw error; }
    if (current.dev !== observed.value.dev || current.ino !== observed.value.ino) return { ok: false, error: { code: 'changed-owner', message: 'Maintenance endpoint changed during custody proof' } };
    unlinkSync(path);
    return { ok: true, value: 'removed-stale' };
  } catch (error) { return { ok: false, error: { code: 'unavailable', message: String(error) } }; }
}

export const MAINTENANCE_INTAKE = 'always-open-v1';
export function installObservation(service, identity) {
  service.db.exec('SAVEPOINT history_fence');
  try {
  const row = service.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='pi_history_bridge'").get();
  service.db.exec(`CREATE TABLE IF NOT EXISTS pi_history_bridge(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pi_history_observation(version INTEGER PRIMARY KEY CHECK(version=1));`);
  if (!row) {
    service.sql("INSERT INTO pi_history_bridge VALUES('identity',?)").run(JSON.stringify(identity));
    service.sql('INSERT OR IGNORE INTO pi_history_observation VALUES(1)').run();
  } else {
    const recorded = JSON.parse(service.sql("SELECT value FROM pi_history_bridge WHERE key='identity'").get().value);
    if (recorded.candidate !== identity.candidate || recorded.legacySource !== identity.legacySource) throw new Error('Another publication owns the native history observation');
  }
  const admission = service.sql("SELECT name FROM sqlite_master WHERE type='trigger' AND name='pi_history_admission'").get();
  if (admission) throw new Error('An earlier gated owner must restore before always-open observation');
  service.db.exec('RELEASE history_fence');
  } catch (error) {
    service.db.exec('ROLLBACK TO history_fence; RELEASE history_fence');
    throw error;
  }
}
export function removeFence(service, identity) {
  if (!/^[0-9a-f]{40}$/.test(identity?.candidate) || !/^[0-9a-f]{40}$/.test(identity?.legacySource)) throw new Error('Fence restoration requires immutable ownership identity');
  service.db.exec('SAVEPOINT history_restore');
  try {
    const table = service.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='pi_history_bridge'").get();
    if (!table) {
      const custody = service.sql("SELECT name FROM sqlite_master WHERE name IN ('pi_history_admission','pi_history_children','pi_history_question_cohort','pi_history_questions','pi_history_cohort','pi_history_observation')").get();
      if (custody) throw new Error('History custody has no restoration identity');
      service.db.exec('RELEASE history_restore');
      return { ownership: 'unacquired' };
    }
    const row = service.sql("SELECT value FROM pi_history_bridge WHERE key='identity'").get();
    if (!row) throw new Error('History custody has no restoration identity');
    const recorded = JSON.parse(row.value);
    if (recorded.candidate !== identity.candidate || recorded.legacySource !== identity.legacySource) throw new Error('Another publication owns the history restoration');
    service.db.exec('DROP TRIGGER IF EXISTS pi_history_admission; DROP TRIGGER IF EXISTS pi_history_children; DROP TRIGGER IF EXISTS pi_history_question_cohort; DROP TABLE IF EXISTS pi_history_questions; DROP TABLE IF EXISTS pi_history_cohort; DROP TABLE IF EXISTS pi_history_bridge; DROP TABLE IF EXISTS pi_history_observation; RELEASE history_restore;');
    return { ownership: 'restored' };
  } catch (error) {
    service.db.exec('ROLLBACK TO history_restore; RELEASE history_restore');
    throw error;
  }
}
export async function legacyFleetLedger(path, identity, action = 'prepare') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: action === 'probe' });
  db.exec('PRAGMA busy_timeout=2000');
  const pendingCompletions = () => db.prepare(`SELECT count(*) AS n FROM run r WHERE r.state IN ('starting','running')
    AND (r.worker_unit LIKE 'completion:%' OR EXISTS(SELECT 1 FROM control WHERE key='completion-run:'||r.id))`).get().n;
  if (action === 'probe') {
    try { const pending = pendingCompletions(); return { ready: pending === 0, pendingCompletions: pending }; }
    finally { db.close(); }
  }
  let entered = false;
  try {
    db.exec('BEGIN IMMEDIATE'); entered = true;
    if (action === 'restore' || action === 'restore-owned') {
      const row = db.prepare("SELECT value FROM control WHERE key='native-history-maintenance'").get();
      if (row && row.value !== JSON.stringify(identity)) {
        const recorded = JSON.parse(row.value);
        if (action !== 'restore-owned' || !/^[0-9a-f]{40}$/.test(recorded.candidate) || !/^[0-9a-f]{40}$/.test(recorded.legacySource)) throw new Error('Another publication owns the fleet admission fence');
        db.exec('COMMIT'); return { ready: true, ownership: 'foreign-preserved' };
      }
      if (!row && db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='pi_history_completion_admission'").get()) throw new Error('Fleet admission fence has no declared identity');
      db.exec('DROP TRIGGER IF EXISTS pi_history_completion_admission; DROP TRIGGER IF EXISTS pi_history_completion_dispatch');
      db.prepare("DELETE FROM control WHERE key='native-history-maintenance'").run();
      db.exec('COMMIT'); return { ready: true };
    }
    const row = db.prepare("SELECT value FROM control WHERE key='native-history-maintenance'").get();
    if (row && row.value !== JSON.stringify(identity)) throw new Error('Another publication owns the fleet admission fence');
    db.prepare("INSERT OR REPLACE INTO control(key,value) VALUES('native-history-maintenance',?)").run(JSON.stringify(identity));
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='pi_history_completion_admission'").get()) throw new Error('An earlier gated fleet must restore before dispatch replacement');
    db.exec(`CREATE TRIGGER IF NOT EXISTS pi_history_completion_dispatch BEFORE UPDATE ON run
      WHEN OLD.state='queued' AND NEW.state='starting' AND NEW.worker_unit LIKE 'completion:%'
      BEGIN SELECT RAISE(ABORT,'Controller replacement dispatch paused; queued completion receipt is retained'); END;`);
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
    WHERE w.status NOT IN ('done','queued') AND t.held=0 AND json_extract(t.metadata,'$.archived') IS NOT 1`).get().n;
  const executions = service.sql('SELECT count(*) AS n FROM thread_execution WHERE ended_at IS NULL').get().n;
  const operations = ['operations','opening','halts','dependencyOperations'].reduce((count, key) => count + (service[key]?.size ?? 0), Number(service.routing === true));
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
  const owned = () => service.execution(id) || service.opening.has(id) || service.operations.has(id) || service.halts.has(id);
  if (owned()) return;
  const runtime = await service.attach(id);
  if (owned()) return;
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
  const prepared = spawnSync(options.node ?? '/usr/local/bin/node', [fileURLToPath(new URL('./native-history-closed-owner.mjs', import.meta.url)),
    JSON.stringify({ uid, mode: options.mode, dataDir, ...identity, ...(options.mode === 'fleet' ? { ledgerPath: options.ledgerPath } : {}) }), '--prepare-attempt'],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  const result = prepared.stdout ? JSON.parse(prepared.stdout) : null;
  if (prepared.status !== 0 || result?.ok !== true) throw new Error(`Native history maintenance receipt custody mismatch: ${result?.error?.code ?? prepared.error?.message ?? prepared.stderr?.trim() ?? 'missing proof'}`);
  let receipt = result.value;
  const save = phase => { receipt = { ...receipt, phase, updatedAt: new Date().toISOString() }; atomicJson(receiptPath, receipt); };
  if (receipt.phase === 'restored') return true;
  if (receipt.phase === 'closing') save('draining');
  const services = new Set(), controls = new Set(), daemons = new Set(), detaching = new WeakSet(), startedServices = new WeakSet();
  const dispatchPaused = new WeakSet(), daemonDispatchPaused = new WeakSet();
  let handingOff = false;
  let controlServer, autoTimer;
  let ownerQueue = Promise.resolve();
  const ownerOperation = (action, kind) => {
    const operation = ownerQueue.then(async () => {
      const value = await action();
      if (kind === 'status' && Array.isArray(value?.owners) && receipt.errorOperation === kind) {
        delete receipt.error; delete receipt.errorOperation; save(receipt.phase);
        const { error, errorOperation, ...proof } = value;
        return proof;
      }
      return value;
    });
    ownerQueue = operation.then(() => undefined, error => {
      if (!receipt.error || receipt.errorOperation === 'status' || receipt.errorOperation === kind) {
        receipt.error = String(error); receipt.errorOperation = kind;
      }
      save(receipt.phase);
    });
    return operation;
  };
  const awaitingReplacement = () => ({ ...receipt, ready: false, reason: 'Legacy thread controller is awaiting startup or replacement; preserved producer custody is not ready' });
  const activeServices = () => {
    const active = [...services].filter(service => startedServices.has(service) && !service.closed && !detaching.has(service));
    const paths = new Set(active.map(service => service.options.databasePath));
    return [...services].every(service => paths.has(service.options.databasePath)) ? active : null;
  };
  function stopControl() {
    clearInterval(autoTimer);
    receipt.controllerStopped = true; receipt.ready = false; save(receipt.phase);
    controlServer?.unref(); controlServer?.closeIdleConnections();
  }
  let restoreDaemonDispatch = () => {};
  if (options.mode === 'fleet' && receipt.phase === 'draining') {
    if (typeof options.ledgerPath !== 'string' || !options.ledgerPath.startsWith('/')) throw new Error('Fleet maintenance needs its exact owner ledger');
    receipt.ledgerPath = options.ledgerPath;
    const { Daemon } = await import(pathToFileURL(join(dirname(options.oldApi), 'daemon.js')).href);
    if (!['start','loadManifest','fillCapacity'].every(key => typeof Daemon?.prototype[key] === 'function')) throw new Error('Selected old fleet has no completion custody seam');
    const reconcile = Daemon.prototype.reconcile;
    if (typeof reconcile !== 'function') throw new Error('Selected old fleet has no dispatch reconciliation seam');
    Daemon.prototype.reconcile = function(...args) { return daemonDispatchPaused.has(this) ? Promise.resolve() : reconcile.apply(this, args); };
    restoreDaemonDispatch = () => { Daemon.prototype.reconcile = reconcile; };
    const start = Daemon.prototype.start;
    Daemon.prototype.start = async function(...args) {
      if (!(this.threads instanceof api.ThreadService) || typeof this.threads.options?.databasePath !== 'string'
        || !this.threads.options.databasePath.startsWith('/')) throw new Error('Legacy daemon uses an uninstrumented or unbound thread service');
      services.add(this.threads);
      daemons.add(this);
      releaseFleetLedger();
      try { return await start.apply(this, args); }
      catch (error) { receipt.error = `Legacy daemon startup failed: ${String(error)}`; throw error; }
      finally {
        if (receipt.phase === 'owners-closed') {
          try { releaseFleetLedger(); delete receipt.error; save('migrated'); if (options.autoAdvance === true) originalExit(75); }
          catch (error) { receipt.error = String(error); save('migration-pending'); originalExit(1); }
        } else stopControl();
      }
    };
  }
  const originalExit = process.exit.bind(process);
  const api = await import(pathToFileURL(options.oldApi).href);
  const prototype = api.ThreadService?.prototype;
  if (!prototype || !['start','close','attach','execution','send','spawn','deliverScheduledWakes','rpc','busy','adoptReference','wake'].every(key => typeof prototype[key] === 'function')) throw new Error('Selected legacy ThreadService has no supported maintenance seam');
  const originalStart = prototype.start, originalAttach = prototype.attach, originalDetach = prototype.detach;
  const originalWake = prototype.wake, originalDrain = prototype.drain;
  prototype.wake = function(...args) { if (!dispatchPaused.has(this)) return originalWake.apply(this, args); };
  if (typeof originalDrain === 'function') prototype.drain = function(...args) { return dispatchPaused.has(this) ? Promise.resolve() : originalDrain.apply(this, args); };
  if (typeof originalDetach === 'function') prototype.detach = async function(...args) {
    detaching.add(this);
    try { return await originalDetach.apply(this, args); }
    finally { if (!this.closed) detaching.delete(this); }
  };
  prototype.attach = function(id, recoverMissing = false) { return attachLegacyRuntime(this, originalAttach, id, recoverMissing); };
  prototype.start = async function(...args) {
    services.add(this);
    installObservation(this, identity);
    if (handingOff) dispatchPaused.add(this);
    const result = await originalStart.apply(this, args);
    if (result?.ok === true) {
      startedServices.add(this);
      delete receipt.controllerStopped; delete receipt.ready; save(receipt.phase);
    }
    return result;
  };
  const extension = options.oldApi.endsWith('.ts') ? '.ts' : options.oldApi.endsWith('.js') ? '.js' : null;
  const transportPath = options.transportModule ?? (extension ? join(dirname(options.oldApi), 'threads', `runner-transport${extension}`) : null);
  if (!transportPath) throw new Error('Selected legacy runner transport source is unknown');
  const transport = await import(pathToFileURL(transportPath).href);
  if (typeof transport.runnerSocketDirectory !== 'function') throw new Error('Selected legacy transport has no native ownership census');
  const socketDir = transport.runnerSocketDirectory(dataDir, uid);
  async function status() {
    if (receipt.phase !== 'draining') return receipt;
    if (!services.size) return { ...receipt, ready: false, reason: 'Legacy owner has not registered its thread services' };
    const active = activeServices();
    if (active === null || !active.length) return awaitingReplacement();
    let ready = true; const owners = [];
    if (options.mode === 'fleet') {
      if (!daemons.size) return { ...receipt, ready: false, reason: 'Old fleet completion owner has not registered' };
      for (const daemon of daemons) {
        if (!daemon.completionPool || typeof daemon.completionPool.size !== 'number' || typeof daemon.reconciling !== 'boolean') throw new Error('Old fleet completion custody is unknown');
        if (daemon.completionPool.size || daemon.reconciling) ready = false;
      }
    }
    for (const service of active) {
      if (service.closed || detaching.has(service)) return awaitingReplacement();
      const references = service.sql("SELECT id,json_extract(metadata,'$.runnerReference') AS reference FROM thread WHERE json_extract(metadata,'$.runnerReference') IS NOT NULL").all();
      for (const row of references) {
        const reference = JSON.parse(row.reference);
        controls.add(reference.control);
        try { await reconcileLegacyRuntime(service, row.id); }
        catch (error) { if (service.closed || detaching.has(service)) return awaitingReplacement(); throw error; }
        if (service.closed || detaching.has(service)) return awaitingReplacement();
      }
      const busy = serviceBusy(service), spools = [];
      for (const row of service.sql("SELECT json_extract(metadata,'$.runnerReference') AS reference FROM thread WHERE json_extract(metadata,'$.runnerReference') IS NOT NULL").all()) {
        const reference = JSON.parse(row.reference), path = `${reference.socketPath}.events`;
        if (existsSync(path) && statSync(path).size) spools.push(path);
      }
      if (Object.values(busy).some(Boolean) || spools.length) ready = false;
      owners.push({ database: service.options.databasePath, busy, unacknowledgedSpools: spools.length });
    }
    if (active.some(service => service.closed || detaching.has(service))) return awaitingReplacement();
    const known = new Set(active.flatMap(service => service.sql('SELECT id FROM thread').all().map(row => row.id)));
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
      const active = activeServices();
      if (active === null || !active.length) return awaitingReplacement();
      handingOff = true;
      for (const service of active) dispatchPaused.add(service);
      for (const daemon of daemons) daemonDispatchPaused.add(daemon);
      const raced = active.some(service => Object.entries(serviceBusy(service)).some(([key, count]) => key !== 'work' && count !== 0))
        || [...daemons].some(daemon => daemon.completionPool.size || daemon.reconciling);
      if (raced) {
        handingOff = false;
        for (const service of active) dispatchPaused.delete(service);
        for (const daemon of daemons) daemonDispatchPaused.delete(daemon);
        return { ...receipt, ready: false, reason: 'In-flight dispatch raced the short controller replacement; intake remains open' };
      }
      save('closing');
      for (const service of active) { const result = await service.close(); if (!result.ok) throw new Error(`Legacy owner close refused: ${result.error.message}`); }
      for (const control of controls) {
        try { const result = await runnerRequest(control, { type: 'drain' }); if (result.ok !== true) throw new Error('Legacy runner refused idle retirement'); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') throw error; }
      }
      for (const control of controls) {
        const deadline = Date.now() + 3000;
        while (existsSync(control) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        if (existsSync(control)) throw new Error('Legacy runner control still exists after acknowledged retirement');
      }
      receipt.databases = active.map(service => service.options.databasePath);
      save('owners-closed');
      // The old release closes capture/image/server databases before calling process.exit.
      if (options.mode === 'fleet') {
        for (const service of active) dropFenceFile(service.options.databasePath);
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
    const removed = spawnSync(options.node ?? '/usr/local/bin/node', ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('DROP TRIGGER IF EXISTS pi_history_admission; DROP TRIGGER IF EXISTS pi_history_children; DROP TRIGGER IF EXISTS pi_history_question_cohort; DROP TABLE IF EXISTS pi_history_questions; DROP TABLE IF EXISTS pi_history_cohort; DROP TABLE IF EXISTS pi_history_bridge; DROP TABLE IF EXISTS pi_history_observation;'); db.close();`, path], { encoding: 'utf8', timeout: 3000 });
    if (removed.status !== 0) throw new Error(`Cannot release preserved maintenance fence: ${removed.stderr}`);
  }
  async function migrate() {
    const result = spawnSync(options.node ?? '/usr/local/bin/node', [options.migrator, '--supervisor-db', join(dataDir, 'supervisor.sqlite3'), '--thread-db', join(dataDir, 'threads.sqlite3'), '--output-dir', join(dataDir, 'native-history-retirement'), '--writers-stopped'], { encoding: 'utf8', timeout: 45000 });
    if (result.status !== 0) { receipt.error = result.error?.message ?? result.stderr; save('migration-pending'); return; }
    // The source-bound observation belongs to the retiring controller.
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
  const endpoint = await prepareBridgeSocket(socketPath);
  if (!endpoint.ok) throw new Error(`${endpoint.error.code}: ${endpoint.error.message}`);
  const server = createServer((request, response) => { response.setHeader('connection', 'close'); void ownerOperation(async () => {
    let value;
    if (request.method === 'GET' && request.url === '/status') value = await status();
    else if (request.method === 'POST' && request.url === '/close') value = await closeOwners();
    else if (request.method === 'POST' && request.url === '/restore') {
      if (receipt.phase !== 'draining' && receipt.phase !== 'restored') throw new Error('Native owner closure has started; resume preserving migration instead of restoring the old decoder');
      for (const service of services) if (!service.closed) removeFence(service, identity);
      if (options.mode === 'fleet') releaseFleetLedger();
      restoreDaemonDispatch();
      prototype.start = originalStart; prototype.attach = originalAttach; prototype.wake = originalWake;
      if (originalDrain) prototype.drain = originalDrain;
      if (originalDetach) prototype.detach = originalDetach;
      delete receipt.error; save('restored'); value = receipt;
    }
    else { response.writeHead(404); response.end(); return; }
    return value;
  }, request.method === 'GET' && request.url === '/status' ? 'status' : `${request.method} ${request.url}`).then(value => {
    if (response.writableEnded) return;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
  }).catch(error => { response.writeHead(503); response.end(JSON.stringify({ ...receipt, error: String(error) })); }); });
  controlServer = server;
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
    autoTimer = setInterval(() => {
      if (checking || receipt.phase !== 'draining') return;
      checking = true;
      void ownerOperation(status, 'status').then(value => {
        if (value.ready) return ownerOperation(closeOwners, 'close');
      }).catch(error => {
        console.error(`Native history maintenance: ${error}`);
      }).finally(() => { checking = false; });
    }, 1000);
    autoTimer.unref();
  }
  return true;
}

const evalInvocation = process.execArgv.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg) || arg.startsWith('--eval=') || arg.startsWith('--print='));
if (!evalInvocation && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--probe-socket') {
    console.error('Expected --probe-socket PATH'); process.exitCode = 64;
  } else {
    const result = await probeBridgeSocket(process.argv[3]);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 75;
  }
}
