import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const adminToken = 'synthetic-phone-admin-token'.padEnd(48, 'a');
const deviceToken = 'synthetic-phone-device-token'.padEnd(48, 'd');
const brief = {
  to: '+442079460123', purpose: 'Offline integration test only.',
  shareableFacts: ['This is a synthetic test.'], opening: 'Synthetic test opening.', maxSeconds: 60,
};

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out: ${description}`);
}

function unusedPort() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') });
  const port = server.port;
  server.stop(true);
  return port;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-sim-service-test-'));
  const localPort = unusedPort(), publicPort = unusedPort();
  const base = `http://127.0.0.1:${localPort}`;
  const publicBase = `http://127.0.0.1:${publicPort}`;
  const voiceRequests: { method: string; path: string; body: any }[] = [];
  const gatewayMessages: any[] = [];
  const sockets: WebSocket[] = [];
  let releaseLaunch!: () => void;
  const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve; });
  let launchRequests = 0;
  const fakeVoice = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/launch') { launchRequests++; await launchGate; return Response.json({ released: true }); }
    const body = req.method === 'GET' ? null : await req.json();
    voiceRequests.push({ method: req.method, path, body });
    if (req.method === 'POST' && path === '/sessions') return Response.json({ session: { id: 'synthetic-voice' }, sdp: 'synthetic-answer' });
    return Response.json({ ok: true });
  } });
  writeFileSync(join(root, 'admin-token'), adminToken, { mode: 0o600 });
  writeFileSync(join(root, 'device-token'), deviceToken, { mode: 0o600 });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    adminTokenFile: join(root, 'admin-token'), localPort, publicPort,
    voiceUrl: `http://127.0.0.1:${fakeVoice.port}`, owner: 'synthetic-test-owner',
    chromium: join(root, 'never-launch-a-real-browser'),
    simGateways: [{ id: 'desk', name: 'Synthetic desk SIM', tokenFile: join(root, 'device-token') }],
  }));
  // Only Chromium is replaced. HTTP auth, SQLite, WebSockets and the service run unchanged.
  writeFileSync(join(root, 'runner.ts'), `
import { mock } from 'bun:test';
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('External fetch forbidden in integration test');
  return nativeFetch(input, options);
});
const pages = [];
mock.module(${JSON.stringify(Bun.resolveSync('playwright-core', new URL('.', import.meta.url).pathname))}, () => ({ chromium: { async launch() {
  await fetch(process.env.TEST_LAUNCH_URL);
  return { on() {}, async newPage() {
    let socket;
    const page = { async goto(value) {
      const url = new URL(value), token = url.hash.slice(1);
      socket = new WebSocket(url.origin.replace('http:', 'ws:') + '/browser-media');
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      socket.send(JSON.stringify({ type: 'authenticate', token }));
      const response = await fetch(url.origin + '/media/offer', { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ sdp: 'synthetic-offer' }) });
      if (!response.ok) throw new Error('Synthetic media offer rejected');
      socket.send(JSON.stringify({ type: 'ready' }));
    }, async close() { socket?.close(); } };
    pages.push(page);
    return page;
  }, async close() { await Promise.all(pages.map(page => page.close())); } };
} } }));
await import(${JSON.stringify(new URL('./service.ts', import.meta.url).href)});
`);
  const child = Bun.spawn([process.execPath, join(root, 'runner.ts')], {
    env: { ...process.env, PI_STACK_PHONE_CONFIG: join(root, 'config.json'), PI_STACK_PHONE_STATE: join(root, 'state'), TEST_LAUNCH_URL: `http://127.0.0.1:${fakeVoice.port}/launch` },
    stdout: 'ignore', stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const request = (path: string, token: string | null = adminToken, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(1000),
  });
  async function gateways() { return (await (await request('/gateways')).json()).gateways; }
  async function close() {
    releaseLaunch();
    for (const socket of sockets) socket.close();
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    await child.exited;
    clearTimeout(killTimer);
    fakeVoice.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
  try {
    await eventually(async () => {
      try { if ((await request('/status')).ok) return true; } catch {}
      if (child.exitCode !== null) throw new Error(`Service exited: ${await stderr}`);
    }, 'phone service ready');
  } catch (error) { await close(); throw error; }
  async function connect() {
    const Client = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new Client(`${publicBase.replace('http:', 'ws:')}/gateway/connect`, { headers: { authorization: `Bearer ${deviceToken}` } });
    sockets.push(socket);
    socket.addEventListener('message', event => { gatewayMessages.push(typeof event.data === 'string' ? JSON.parse(event.data) : event.data); });
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('Gateway upgrade failed')), { once: true });
      }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Gateway upgrade timed out')), 2000); timer.unref(); }),
    ]);
    return socket;
  }
  function hello(socket: WebSocket, ready: boolean) { socket.send(JSON.stringify({ type: 'hello', id: 'desk', sampleRate: 16000, ready, reason: 'Synthetic Bluetooth unavailable' })); }
  async function readyGateway() {
    const socket = await connect();
    hello(socket, true);
    await eventually(async () => (await gateways())[0].ready ? true : undefined, 'ready gateway');
    return socket;
  }
  async function startCall() {
    const response = await request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief });
    assert.equal(response.status, 202);
    return await response.json();
  }
  async function dispatched() {
    return await eventually(async () => {
      const message = gatewayMessages.find(message => message.type === 'dial');
      if (message) return message;
      const calls = await (await request('/calls')).json();
      if (calls[0]?.ended_at) throw new Error(`Synthetic call failed: ${JSON.stringify(calls[0])}`);
    }, 'synthetic dial command');
  }
  return { request, publicBase, gateways, connect, hello, readyGateway, startCall, dispatched, close, releaseLaunch, voiceRequests, gatewayMessages, launches: () => launchRequests };
}

test('service separates owner/device tokens and rejects offline SIM calls before allocating calls or Voice', async () => {
  const f = await fixture();
  try {
    for (const token of [null, deviceToken, 'wrong-token']) {
      for (const path of ['/status', '/gateways', '/calls']) assert.equal((await f.request(path, token)).status, 403);
      assert.equal((await f.request('/sim-calls', token, 'POST', { gatewayId: 'desk', brief })).status, 403);
      assert.equal((await f.request('/media/offer', token, 'POST', { sdp: 'synthetic-offer' })).status, 403);
    }
    for (const token of [adminToken, 'wrong-token']) {
      const response = await fetch(`${f.publicBase}/gateway/connect`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 403);
    }
    assert.equal((await f.request('/media/offer', adminToken, 'POST', { sdp: 'synthetic-offer' })).status, 403);
    assert.equal((await f.request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief })).status, 409);
    assert.deepEqual(await (await f.request('/calls')).json(), []);
    assert.equal((await (await f.request('/status')).json()).activeCalls, 0);
    assert.equal(f.launches(), 0);
    assert.equal(f.voiceRequests.length, 0);
    const socket = await f.connect();
    assert.equal((await f.gateways())[0].ready, false);
    assert.equal((await f.request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief })).status, 409);
    f.hello(socket, false);
    await eventually(async () => (await f.gateways())[0].reason === 'Synthetic Bluetooth unavailable' ? true : undefined, 'not-ready hello processed');
    assert.equal((await f.request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief })).status, 409);
    f.hello(socket, true);
    await eventually(async () => (await f.gateways())[0].ready ? true : undefined, 'ready gateway');
    socket.close();
    await eventually(async () => !(await f.gateways())[0].connected ? true : undefined, 'gateway disconnect');
    assert.equal((await f.request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief })).status, 409);
    assert.deepEqual(await (await f.request('/calls')).json(), []);
    assert.equal(f.gatewayMessages.length, 0);
    assert.equal(f.voiceRequests.length, 0);
    assert.equal(f.launches(), 0);
  } finally { await f.close(); }
}, 10_000);

test('actual service reserves once, dispatches to fake gateway and retains reservation until ended', async () => {
  const f = await fixture();
  try {
    const socket = await f.readyGateway();
    const call = await f.startCall();
    assert.equal(call.transport, 'sim');
    assert.equal((await f.gateways())[0].callId, call.id);
    assert.equal((await f.request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief })).status, 409);
    assert.equal((await (await f.request('/calls')).json()).length, 1);
    assert.equal(f.gatewayMessages.length, 0);
    assert.equal(f.voiceRequests.length, 0);
    await eventually(() => f.launches() === 1 ? true : undefined, 'synthetic browser launch gate');
    f.releaseLaunch();
    assert.deepEqual(await f.dispatched(), { type: 'dial', callId: call.id, number: brief.to, maxSeconds: brief.maxSeconds });
    assert.equal(f.voiceRequests.filter(req => req.method === 'POST').length, 1);
    assert.equal(f.voiceRequests[0].body.owner, 'synthetic-test-owner');
    assert.equal(f.voiceRequests[0].body.threadId, `phone:${call.id}`);
    socket.send(JSON.stringify({ type: 'call-state', callId: call.id, state: 'active' }));
    await eventually(async () => (await (await f.request(`/calls/${call.id}`)).json()).call.status === 'connected' ? true : undefined, 'connected call');
    assert.equal((await f.request(`/calls/${call.id}`, adminToken, 'DELETE')).status, 200);
    await eventually(() => f.gatewayMessages.find(message => message.type === 'hangup'), 'hangup dispatch');
    assert.equal((await f.gateways())[0].callId, call.id);
    assert.equal((await f.request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief })).status, 409);
    assert.equal(f.voiceRequests.filter(req => req.method === 'DELETE' && req.path === '/sessions/synthetic-voice').length, 1);
    socket.send(JSON.stringify({ type: 'call-state', callId: call.id, state: 'ended' }));
    await eventually(async () => (await f.gateways())[0].ready ? true : undefined, 'confirmed hangup releases gateway');
    assert.equal(f.gatewayMessages.filter(message => message.type === 'dial').length, 1);
    assert.equal((await (await f.request('/status')).json()).activeCalls, 0);
  } finally { await f.close(); }
}, 10_000);

test('gateway disconnect fails the actual service call and cleans its synthetic Voice session', async () => {
  const f = await fixture();
  try {
    const socket = await f.readyGateway();
    f.releaseLaunch();
    const call = await f.startCall();
    await f.dispatched();
    socket.close();
    await eventually(async () => {
      const state = await (await f.request(`/calls/${call.id}`)).json();
      return state.call.status === 'failed' && state.call.cleanup === 1 ? state : undefined;
    }, 'disconnect call cleanup');
    assert.equal((await (await f.request('/status')).json()).activeCalls, 0);
    assert.equal(f.voiceRequests.filter(req => req.method === 'DELETE').length, 1);
    assert.equal((await f.gateways())[0].callId, null);
    assert.equal((await f.request('/sim-calls', adminToken, 'POST', { gatewayId: 'desk', brief })).status, 409);
    assert.equal(f.gatewayMessages.filter(message => message.type === 'dial').length, 1);
  } finally { await f.close(); }
}, 10_000);
