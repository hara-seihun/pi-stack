import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const smoke = fileURLToPath(new URL('../deploy/smoke', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

async function fixture(t, authentication) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-smoke-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const persons = join(directory, 'persons');
  mkdirSync(persons);
  const host = join(directory, 'host.json');
  writeFileSync(host, JSON.stringify({ version: 1, fleetUser: 'kenan' }));
  const users = ['kenan', 'person'];
  const calls = [];
  const faults = { administratorDenied: false, ordinaryAllowed: false, sessionsFailed: false };
  function api(user, path, res) {
    calls.push([user, path]);
    if (path === '/v1/actions') {
      res.statusCode = user === 'kenan' ? faults.administratorDenied ? 403 : 200 : faults.ordinaryAllowed ? 200 : 403;
      return res.end('{}');
    }
    if (path === '/v1/sessions' && faults.sessionsFailed) { res.statusCode = 500; return res.end('{}'); }
    if (path === '/v1/health') return res.end(JSON.stringify({ environmentId: 'fixture', releaseCommit: 'fixture-release' }));
    if (path === '/v1/voice') return res.end(JSON.stringify({ enabled: true, releaseCommit: 'fixture-release' }));
    if (path === '/v1/meet') return res.end(JSON.stringify({ transcriptionAvailable: true }));
    if (path === '/v1/environments') return res.end(JSON.stringify({ environments: [{ id: 'fixture', baseUrl: '' }] }));
    if (path === '/v1/environment') return res.end(JSON.stringify({ environment: { id: 'fixture' } }));
    return res.end('{}');
  }
  for (const user of users) {
    const supervisor = createServer((req, res) => api(user, req.url, res));
    const port = await listen(supervisor);
    t.after(() => close(supervisor));
    writeFileSync(join(persons, `${user}.json`), JSON.stringify({ user, port, auth: authentication, remoteAccess: ['fixture'] }));
  }
  const router = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('access-control-allow-headers', 'x-pi-remote-user,x-pi-remote-session,content-type');
      return res.end();
    }
    if (['/', '/voice.html'].includes(req.url)) return res.end('<html><script src="/assets/app.js"></script></html>');
    if (req.url === '/assets/app.js') return res.end('fixture();');
    if (req.url === '/meet-adapter.js') return res.end('startMeetAdapter');
    if (req.url === '/v1/router-health') return res.end(JSON.stringify({ authentication, people: users.map(user => ({ user, unlocked: true })) }));
    if (req.url === '/v1/unlock' && authentication !== 'oidc') return res.end(JSON.stringify({ session: 'fixture-session' }));
    if (!req.headers['x-pi-remote-session']) {
      if (req.url === '/v1/environment') return res.end(JSON.stringify({ environment: { id: 'fixture' } }));
      res.statusCode = 423; return res.end('{}');
    }
    return api(req.headers['x-pi-remote-user'] ?? 'kenan', req.url, res);
  });
  const port = await listen(router);
  t.after(() => close(router));
  const run = () => new Promise((resolve, reject) => {
    const process = spawn(smoke, [`http://127.0.0.1:${port}`], { env: { ...globalThis.process.env,
      PI_STACK_HOST_FILE: host, PI_REMOTE_PERSONS_DIR: persons, PI_STACK_DEPLOY_NO_SUDO: '1' }, timeout: 10_000 });
    let output = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.stderr.on('data', chunk => { output += chunk; });
    process.on('error', reject);
    process.on('close', code => resolve({ code, output }));
  });
  return { run, calls, faults };
}

for (const authentication of ['oidc', 'key']) {
  test(`${authentication} smoke checks administrator access and ordinary-user refusal`, async t => {
    const { run, calls, faults } = await fixture(t, authentication);
    const accepted = await run();
    assert.equal(accepted.code, 0, accepted.output);
    assert(calls.some(([user, path]) => user === 'kenan' && path === '/v1/actions'));
    assert(calls.some(([user, path]) => user === 'person' && path === '/v1/actions'));
    faults.administratorDenied = true;
    const refusedAdmin = await run();
    assert.equal(refusedAdmin.code, 1, refusedAdmin.output);
    assert.match(refusedAdmin.output, /kenan.*actions/);
    faults.administratorDenied = false;
    faults.ordinaryAllowed = true;
    const leaked = await run();
    assert.equal(leaked.code, 1, leaked.output);
    assert.match(leaked.output, /person.*actions.*expected 403/);
    faults.ordinaryAllowed = false;
    faults.sessionsFailed = true;
    const brokenSessions = await run();
    assert.equal(brokenSessions.code, 1, brokenSessions.output);
    assert.match(brokenSessions.output, /sessions/);
  });
}
