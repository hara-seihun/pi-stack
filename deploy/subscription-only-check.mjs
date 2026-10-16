import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkBroker(root, configPath) {
  const module = await import(pathToFileURL(join(root, 'dist/auth/shared-oauth.js')));
  const { subscriptionCredential } = await import(pathToFileURL(join(root, 'dist/auth/subscription-only.js')));
  const { pooledOnlyProvider } = await import(pathToFileURL(join(root, 'dist/auth/pooled-only.js')));
  const directory = mkdtempSync(join(tmpdir(), 'subscription-offline-'));
  const path = join(directory, 'auth.json');
  let refreshes = 0, conversions = 0;
  const auth = new module.SharedOAuthAuth({ path, providerId: 'openai-codex', refresh: async () => { refreshes++; throw Error('offline refresh sentinel'); }, toAuth: value => { conversions++; return { apiKey: value.access }; } });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw Error('network forbidden in offline proof'); };
  const cases = [];
  try {
    // Import the real broker graph, including newly introduced modules. Importing
    // does not start listeners; the global fetch sentinel forbids model calls.
    await import(pathToFileURL(join(root, 'dist/model-broker.js')));
    if (configPath) {
      try { JSON.parse(readFileSync(configPath, 'utf8')); }
      catch { throw Error('Broker config is unreadable or invalid for the runtime identity'); }
    }
    cases.push('broker graph and private config readable by runtime identity');
    for (const value of [{ type: 'api_key', key: 'offline-metered-sentinel' }, { type: 'token', token: 'offline-metered-sentinel' }, 'offline-metered-sentinel']) {
      writeFileSync(path, JSON.stringify({ 'openai-codex': value }));
      await assert.rejects(auth.resolve('openai-codex', AbortSignal.timeout(1000)), error => error.code === 'metered_inference_forbidden');
      assert.equal(conversions, 0); assert.equal(refreshes, 0);
      cases.push('persisted non-OAuth rejected before refresh/conversion');
    }
    writeFileSync(path, '{}');
    await assert.rejects(auth.resolve('openai-codex', AbortSignal.timeout(1000)), error => error.code === 'subscription_credential_unset');
    writeFileSync(path, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'offline-oauth', refresh: 'offline-refresh', expires: Date.now() + 3600000 } }));
    assert.equal((await auth.resolve('openai-codex', AbortSignal.timeout(1000))).apiKey, 'offline-oauth');
    cases.push('pooled OAuth preserved');
    assert.equal(subscriptionCredential('openrouter', { type: 'oauth' }, () => ({})).error.code, 'metered_inference_forbidden');
    await assert.rejects(pooledOnlyProvider({ id: 'anthropic', name: 'Anthropic' }).auth.apiKey.resolve(), error => error.code === 'metered_inference_forbidden');
    cases.push('unknown OAuth family and direct family auth rejected');
    writeFileSync(path, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'expired', refresh: 'offline-refresh', expires: 0 } }));
    await assert.rejects(auth.resolve('openai-codex', AbortSignal.timeout(1000)), /offline refresh sentinel/);
    assert.equal(conversions, 1); assert.equal(refreshes, 1); assert.equal(fetches, 0);
    cases.push('subscription refresh failure has no API fallback');
    const brokerSource = readFileSync(join(root, 'src/model-broker.ts'), 'utf8');
    assert.match(brokerSource, /forwardVoiceRequest/);
    assert.match(brokerSource, /metered_inference_forbidden/);
    return { ok: true, component: 'subscription-only-broker', root: resolve(root), cases, networkCalls: fetches, uid: process.getuid(), gid: process.getgid() };
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 3 || process.argv.length > 4) { console.error('usage: node subscription-only-check.mjs BROKER_RELEASE [CONFIG]'); process.exitCode = 64; }
  else try { console.log(JSON.stringify(await checkBroker(process.argv[2], process.argv[3]))); } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code ?? 'offline_guard_failed', message: error.message })); process.exitCode = 1; }
}
