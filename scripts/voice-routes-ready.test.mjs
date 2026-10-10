import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { waitForVoiceRoutes } from '../deploy/voice-routes-ready.mjs';

const commit = 'a'.repeat(40);
const routes = ['kenan', 'person'].map((user, index) => ({ user, url: `http://127.0.0.1:${19000 + index}/v1/voice` }));
const ready = () => Response.json({ enabled: true, releaseCommit: commit });

test('route readiness waits through broker startup and connection retirement with one shared budget', async () => {
  const calls = new Map();
  const result = await waitForVoiceRoutes(routes, commit, 1000, async url => {
    const count = (calls.get(url) ?? 0) + 1;
    calls.set(url, count);
    if (url === routes[0].url) return ready();
    if (count === 1) throw new TypeError('Retired pooled connection');
    if (count === 2) return new Response('Starting', { status: 503 });
    return ready();
  });
  assert.equal(result.ok, true);
  assert.equal(calls.get(routes[0].url), 1);
  assert.equal(calls.get(routes[1].url), 3);
});

test('a broker that never serves cannot pass the readiness gate', async () => {
  const started = Date.now();
  const result = await waitForVoiceRoutes(routes, commit, 80, async () => new Response('Starting', { status: 503 }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /kenan, person/);
  assert(Date.now() - started < 500);
});

test('readiness retains exact release, enabled state, authorization and response contracts', async () => {
  for (const [response, code] of [
    [Response.json({ enabled: true, releaseCommit: 'b'.repeat(40) }), 'release_mismatch'],
    [Response.json({ enabled: false, releaseCommit: commit }), 'release_mismatch'],
    [new Response('Denied', { status: 403 }), 'invalid_response'],
    [new Response('Not JSON'), 'invalid_response'],
  ]) {
    let calls = 0;
    const result = await waitForVoiceRoutes([routes[0]], commit, 1000, async () => { calls++; return response; });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(calls, 1);
  }
  assert.equal((await waitForVoiceRoutes([], commit, 1000, async () => { throw new Error('Locked users have no route'); })).ok, true);
  assert.equal((await waitForVoiceRoutes(routes, commit, undefined, ready)).error.code, 'invalid_request');
});

test('host observes consumer routes after broker activation is joined and before smoke', () => {
  const source = readFileSync(new URL('../deploy/host', import.meta.url), 'utf8');
  const joined = source.indexOf('if [[ -n ${daemon_activation_pid:-} ]]; then wait "$daemon_activation_pid" || activation_failed=1; fi');
  const readiness = source.indexOf('pi_stack_as_root node "$root/deploy/voice-routes-ready.mjs"');
  const smoke = source.indexOf('! "$root/deploy/smoke"');
  assert(joined !== -1 && joined < readiness && readiness < smoke);
});
