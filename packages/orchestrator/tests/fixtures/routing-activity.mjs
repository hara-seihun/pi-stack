import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(process.env.TEST_SDK);
const { AssistantMessageEventStream } = await import(process.env.TEST_AI);
const { Store } = await import(process.env.TEST_STORE);
const { SharedOAuthAuth } = await import(new URL('./auth/shared-oauth.js', `file://${process.env.TEST_STORE}`));
const root = process.env.HOME, dir = join(root, 'agent');
mkdirSync(dir);
writeFileSync(join(dir, 'auth.json'), '{}');
const credential = { type: 'oauth', access: 'test', refresh: 'test', expires: Date.now() + 3600000, accountId: 'account' };
writeFileSync(join(root, 'auth.json'), JSON.stringify({ 'openai-codex-2': credential, 'openai-codex-3': credential }));
const store = Store.open(process.env.PI_ORCHESTRATOR_LEDGER);
for (const id of ['openai-codex-2', 'openai-codex-3']) store.upsertAccount({ id, provider: 'openai-codex' });
const sessions = [], errors = [], shutDown = new Set();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function open(parent) {
  const manager = SessionManager.inMemory(root);
  if (parent) manager.newSession({ parentSession: parent.sessionId });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [process.env.TEST_ROUTING] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: dir, modelRuntime, settingsManager, resourceLoader, sessionManager: manager, tools: [], model: { ...modelRuntime.getModel('openai-codex', 'gpt-6-astra'), provider: 'openai-codex-2' } });
  sessions.push(session);
  await session.bindExtensions({ mode: 'print', onError: e => errors.push(e) });
  let resolveRequest;
  let nextRequest = new Promise(resolve => { resolveRequest = resolve; });
  session.agent.streamFunction = model => {
    const stream = new AssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: Date.now() };
    resolveRequest({ model, finish(stopReason = 'stop', errorMessage) {
      const result = { ...message, stopReason, ...(errorMessage ? { errorMessage } : {}), ...(errorMessage === 'Not Found' ? { usage: { ...usage, input: 0, output: 0, totalTokens: 0 } } : {}) };
      stream.push(stopReason === 'error' || stopReason === 'aborted' ? { type: 'error', reason: stopReason, error: result } : { type: 'done', reason: stopReason, message: result });
      stream.end(result);
    } });
    return stream;
  };
  return { session, request: async () => {
    const request = await nextRequest;
    nextRequest = new Promise(resolve => { resolveRequest = resolve; });
    return request;
  } };
}
const leases = () => store.activeLeases().map(lease => [lease.id, lease.account_id]).sort();
const id = session => `interactive:${session.sessionId}`;
const emit = (session, type, data = {}) => session.extensionRunner.emit({ type, ...data });
try {
  const parent = await open();
  const child = await open(parent.session);
  const sibling = await open(parent.session);
  assert.deepEqual(leases(), [], 'loaded roots and retained children do not reserve capacity');
  const parentRun = parent.session.prompt('parent work'), parentRequest = await parent.request();
  const childRun = child.session.prompt('child work'), childRequest = await child.request();
  const siblingRun = sibling.session.prompt('sibling work'), siblingRequest = await sibling.request();
  assert.equal(leases().length, 3);
  childRequest.finish();
  await childRun;
  assert.equal(child.session.isIdle, true);
  assert.deepEqual(leases(), [[id(parent.session), 'openai-codex-2'], [id(sibling.session), 'openai-codex-2']].sort());
  assert.equal(child.session.model.provider, 'openai-codex-2', 'idle child keeps affinity');
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  // Existing active intervals predate the fake clock. Start a new child activity to test its timer.
  const resumed = child.session.prompt('resume retained child'), resumedRequest = await child.request();
  const started = store.activeLeases().find(lease => lease.id === id(child.session)).started_at;
  mock.timers.tick(30_001);
  const heartbeat = store.activeLeases().find(lease => lease.id === id(child.session));
  assert.equal(heartbeat.started_at, started);
  assert.ok(heartbeat.heartbeat_at > started, 'active child is heartbeated');
  resumedRequest.finish('aborted');
  await resumed;
  mock.timers.tick(30_001);
  assert.ok(!leases().some(([lease]) => lease === id(child.session)), 'aborted retained child stays released after heartbeat interval');
  mock.timers.reset();

  await child.session.setModel(child.session.modelRuntime.getModel('openai-codex-3', 'gpt-6-astra'));
  assert.equal(leases().length, 2, 'idle model selection does not reserve capacity');
  const switched = child.session.prompt('switch while active'), switchedRequest = await child.request();
  assert.equal(switchedRequest.model.provider, 'openai-codex-3');
  await child.session.setModel(child.session.modelRuntime.getModel('openai-codex-2', 'gpt-6-astra'));
  assert.ok(leases().some(([lease, account]) => lease === id(child.session) && account === 'openai-codex-3'), 'in-flight account stays charged');
  switchedRequest.finish('error', '429 rate limit');
  await switched;
  assert.equal(child.session.model.provider, 'openai-codex-2');
  assert.equal(store.account('openai-codex-2').cooldownUntil, undefined, 'prior request does not poison selected account');
  assert.equal(leases().length, 2);

  const failed = child.session.prompt('fail over'), failedRequest = await child.request();
  let failoverSettlements = 0;
  const unsubscribeFailover = child.session.subscribe(event => { if (event.type === 'agent_settled') failoverSettlements++; });
  failedRequest.finish('error', '429 rate limit');
  const retryRequest = await child.request();
  assert.equal(failoverSettlements, 0, 'account recovery is part of the accepted run');
  assert.equal(retryRequest.model.provider, 'openai-codex-3');
  assert.ok(leases().some(([lease, account]) => lease === id(child.session) && account === 'openai-codex-3'));
  retryRequest.finish();
  await failed;
  assert.equal(failoverSettlements, 1, 'only the recovered run settles');
  unsubscribeFailover();
  assert.equal(leases().length, 2, 'failover continuation releases on settlement');

  let repairs = 0, usageChecks = 0;
  const refreshRejected = SharedOAuthAuth.prototype.refreshRejected;
  SharedOAuthAuth.prototype.refreshRejected = async () => { repairs++; return credential; };
  const usageRequest = mock.method(https, 'request', (url, options, callback) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/usage');
    assert.equal(options.headers.Authorization, 'Bearer test');
    usageChecks++;
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 404;
      response.headers = { 'x-request-id': 'fixture-usage-rejection' };
      callback(response);
      response.emit('end');
    });
    return request;
  });
  syncBuiltinESMExports();
  try {
    for (const [index, failure] of ['401 unauthorized', 'Not Found', 'Not Found'].entries()) {
      const rejected = child.session.prompt('repair token'), rejectedRequest = await child.request();
      rejectedRequest.finish('error', failure);
      const repairedRequest = await child.request();
      assert.equal(repairs, index + 1);
      assert.equal(repairedRequest.model.provider, 'openai-codex-3');
      assert.equal(leases().length, 3);
      repairedRequest.finish(index === 2 ? 'error' : 'stop', index === 2 ? 'Not Found' : undefined);
      await rejected;
      assert.equal(repairs, index + 1, 'a second rejection does not refresh or continue again');
      assert.equal(leases().length, 2, 'credential repair continuation releases on settlement');
    }
    assert.equal(usageChecks, 2, '401 does not need corroboration; repeated 404 does not probe again');
    assert.ok(child.session.sessionManager.getEntries().some(entry => entry.customType === 'credential-repair' && entry.data.detail.includes('fixture-usage-rejection')), 'corroboration diagnostic persists in the session');
  } finally {
    SharedOAuthAuth.prototype.refreshRejected = refreshRejected;
    usageRequest.mock.restore();
    syncBuiltinESMExports();
  }
  const exhausted = child.session.prompt('every sibling cooling'), exhaustedRequest = await child.request();
  exhaustedRequest.finish('error', '429 rate limit');
  const coolingRequest = await child.request();
  assert.equal(coolingRequest.model.provider, 'openai-codex-2', 'a pool of cooling siblings slows the turn down instead of failing it');
  coolingRequest.finish();
  await exhausted;
  assert.equal(leases().length, 2, 'the continuation on a cooling sibling releases on settlement');

  for (const terminal of ['session_compact', 'session_compact_failed']) {
    await emit(child.session, 'session_before_compact');
    assert.equal(leases().length, 3, 'manual compaction is active work');
    await emit(child.session, terminal);
    assert.equal(leases().length, 2);
  }
  await emit(parent.session, 'session_before_compact');
  await emit(parent.session, 'session_compact_failed');
  assert.equal(leases().length, 2, 'compaction completion cannot release an active run');
  parentRequest.finish(); siblingRequest.finish();
  await Promise.all([parentRun, siblingRun]);
  assert.deepEqual(leases(), []);
  const closing = child.session.prompt('shutdown while active'), closingRequest = await child.request();
  assert.equal(leases().length, 1);
  await emit(child.session, 'session_shutdown', { reason: 'quit' });
  shutDown.add(child.session);
  assert.deepEqual(leases(), []);
  closingRequest.finish('error', '429 rate limit');
  await closing;
  assert.deepEqual(leases(), [], 'late failure cannot reacquire after shutdown');
  assert.deepEqual(errors, []);
} finally {
  mock.timers.reset();
  for (const session of sessions) { if (!shutDown.has(session)) await emit(session, 'session_shutdown', { reason: 'quit' }); session.dispose(); }
  store.close();
}
console.log('activity leases released; retained idle child kept affinity');
