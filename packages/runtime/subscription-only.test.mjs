import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { authorizeInference, SUBSCRIPTION_ONLY_CODE } from './subscription-only.mjs';
import { families, patchSubscriptionOnly, patchSubscriptionSource } from './patch-subscription-only.mjs';

const original = process.env.PI_TEST_NODE_MODULES || dirname(dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))))));
const root = mkdtempSync(join(tmpdir(), 'pi-subscription-test-'));
const modules = join(root, 'node_modules');
mkdirSync(join(modules, '@earendil-works'), { recursive: true });
for (const name of readdirSync(original)) {
  if (name === '@earendil-works') continue;
  symlinkSync(join(original, name), join(modules, name));
}
for (const name of readdirSync(join(original, '@earendil-works'))) {
  const source = join(original, '@earendil-works', name);
  const dest = join(modules, '@earendil-works', name);
  if (['pi-ai', 'pi-coding-agent'].includes(name)) cpSync(source, dest, { recursive: true, dereference: true });
  else symlinkSync(source, dest);
}
function writable(path) { for (const entry of readdirSync(path, {withFileTypes:true})) { const child=join(path, entry.name); if(entry.isDirectory()) writable(child); else if(entry.isFile()) chmodSync(child, 0o644); } }
for(const name of ['pi-ai','pi-coding-agent']) writable(join(modules,'@earendil-works',name));
const api = join(modules, '@earendil-works/pi-ai/dist/api');
const chunks = join(modules, '@earendil-works/pi-coding-agent/dist/bundle/chunks');
const model = (family, baseUrl = 'https://api.openai.com/v1') => ({ id: 'fixture', provider: 'openai', api: family, baseUrl, reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 32, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
const context = { messages: [{ role: 'user', content: 'offline fixture', timestamp: 1 }] };
const load = path => import(pathToFileURL(path).href);
const options = { apiKey: 'synthetic-paid-key', maxRetries: 0 };

test('unpatched concrete provider reaches injected transport; patched adapters reject before it', async t => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const fetch = async () => { calls++; return new Response('{"error":{"message":"offline fixture"}}', { status: 401, headers: { 'content-type': 'application/json' } }); };
  const baselinePath = join(api, 'offline-baseline.js');
  const baselineSource = readFileSync(join(api, 'openai-responses.js'), 'utf8')
    .replace('import { authorizeInference, rejectedInferenceStream, rejectedImageInference } from "./subscription-only.mjs";\n// PiStack subscription-only inference boundary\n', '')
    .replaceAll('\nconst policy = authorizeInference("openai-responses", model, options); if (!policy.ok) return rejectedInferenceStream(model, policy.error);\n', '');
  writeFileSync(baselinePath, baselineSource);
  const baseline = await load(baselinePath);
  await baseline.stream(model('openai-responses'), context, { ...options, fetch }).result();
  assert.equal(calls, 1, 'baseline must exercise credential dispatch via fake fetch');
  assert.equal(patchSubscriptionOnly(modules).length, 22);
  assert.equal(patchSubscriptionOnly(modules).length, 22);
  calls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  for (const family of families) {
    const bundle = readdirSync(chunks).find(name => name === `${family}.js` || name.startsWith(`${family}-`) && name.endsWith('.js'));
    for (const path of [join(api, `${family}.js`), join(chunks, bundle)]) {
      const source = readFileSync(path, 'utf8');
      assert.equal(patchSubscriptionSource(source, family), source);
      const parsed = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', timeout: 2000 });
      assert.equal(parsed.status, 0, parsed.stderr);
      const impl = await import(`${pathToFileURL(path).href}?patched`);
      for (const method of family === 'openrouter-images' ? ['generateImages'] : ['stream', 'streamSimple']) {
        const value = impl[method](model(family), context, { ...options, fetch });
        const result = method === 'generateImages' ? await value : await value.result();
        assert.equal(result.errorCode, SUBSCRIPTION_ONLY_CODE, `${family}/${method}/${path.includes('chunks')}`);
        assert.ok(!JSON.stringify(result).includes(options.apiKey));
      }
    }
  }
  assert.equal(calls, 0, 'all SDK/bundled rejected paths must avoid transport');

  const { createModels, InMemoryCredentialStore } = await load(join(modules, '@earendil-works/pi-ai/dist/index.js'));
  const { openaiProvider } = await load(join(modules, '@earendil-works/pi-ai/dist/providers/openai.js'));
  for (const mode of ['stored', 'env', 'override', 'headers']) {
    const credentials = new InMemoryCredentialStore();
    if (mode === 'stored') await credentials.modify('openai', () => ({ type: 'api_key', key: options.apiKey }));
    const sdk = createModels({ credentials, authContext: { env: async name => mode === 'env' && name === 'OPENAI_API_KEY' ? options.apiKey : undefined, fileExists: async () => false } });
    const provider = openaiProvider();
    sdk.setProvider(provider);
    const selected = provider.getModels()[0];
    const request = { fetch, maxRetries: 0, ...(mode === 'override' || mode === 'headers' ? { apiKey: options.apiKey } : {}), ...(mode === 'headers' ? { transformHeaders: async () => ({ authorization: `Bearer ${options.apiKey}` }) } : {}) };
    assert.equal((await sdk.completeSimple(selected, context, request)).errorCode, SUBSCRIPTION_ONLY_CODE, mode);
  }
  assert.equal(calls, 0);

  const anthropic = await import(`${pathToFileURL(join(api, 'anthropic-messages.js')).href}?patched`);
  const oauthModel = { ...model('anthropic-messages', 'https://api.anthropic.com'), provider: 'anthropic' };
  await anthropic.stream(oauthModel, context, { ...options, apiKey: 'sk-ant-oat01-offline-synthetic', fetch }).result();
  assert.equal(calls, 1, 'subscription OAuth reaches fake transport');
  const marker = join(root, 'network-attempt');
  const preloader = join(root, 'offline.mjs');
  writeFileSync(preloader, `import {writeFileSync} from 'node:fs';globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(marker)},'attempt');throw Error('offline');};`);
  const home = join(root, 'home'); mkdirSync(home);
  const cli = spawnSync(process.execPath, ['--import', preloader, join(modules, '@earendil-works/pi-coding-agent/dist/bundle/cli.js'), '--provider', 'openai', '--model', 'gpt-4o', '--api-key', options.apiKey, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-session', '--mode', 'json', '-p', 'offline fixture'], { encoding: 'utf8', timeout: 12000, cwd: home, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi/agent'), OPENAI_API_KEY: options.apiKey } });
  assert.match(cli.stdout + cli.stderr, new RegExp(SUBSCRIPTION_ONLY_CODE));
  assert.ok(!readdirSync(root).includes('network-attempt'));
});

test('route policy binds credential class to endpoint and adapter; never model cost or caller voice flag', () => {
  const paid = options.apiKey;
  for (const family of families) for (const url of ['https://api.openai.com/v1', 'https://api.anthropic.com', 'https://openrouter.ai/api/v1', 'http://127.0.0.1:1234']) assert.equal(authorizeInference(family, { ...model(family, url), cost: { input: 0, output: 0 } }, { apiKey: paid, voice: true }, {}).ok, false);
  const oauth = 'sk-ant-oat01-offline-synthetic';
  assert.equal(authorizeInference('anthropic-messages', model('anthropic-messages', 'https://api.anthropic.com'), { apiKey: oauth }, {}).route, 'subscription-oauth');
  for (const url of ['https://api.anthropic.com.evil.test', 'https://api.openai.com', 'http://api.anthropic.com', 'https://api.anthropic.com/redirect']) assert.equal(authorizeInference('anthropic-messages', model('anthropic-messages', url), { apiKey: oauth }, {}).ok, false);
  assert.equal(authorizeInference('anthropic-messages', model('anthropic-messages', 'https://api.anthropic.com'), { apiKey: oauth, headers: { 'x-api-key': paid } }, {}).ok, false);
  assert.equal(authorizeInference('anthropic-messages', model('anthropic-messages', 'http://127.0.0.1:8000'), { apiKey: 'sk-ant-oat01-pi-model-broker' }, {}).route, 'broker');
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
  assert.equal(authorizeInference('openai-codex-responses', model('openai-codex-responses', 'https://chatgpt.com/backend-api'), { apiKey: `eyJhbGciOiJub25lIn0.${payload}.synthetic` }, {}).route, 'subscription-oauth');
  assert.equal(authorizeInference('openai-responses', model('openai-responses'), { apiKey: `eyJhbGciOiJub25lIn0.${payload}.synthetic` }, {}).ok, false);
});

test('local engine requires exact manifest provider and endpoint; malformed/missing manifests reject', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-local-policy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'local.json');
  const env = { PI_STACK_LOCAL_MODELS: path };
  const local = { ...model('openai-completions', 'http://127.0.0.1:7777/v1'), provider: 'bonsai' };
  assert.equal(authorizeInference('openai-completions', local, { apiKey: 'local' }, env).ok, false);
  writeFileSync(path, JSON.stringify({ engines: [{ id: 'bonsai', baseUrl: local.baseUrl, publish: true }] }));
  assert.equal(authorizeInference('openai-completions', local, { apiKey: 'local' }, env).route, 'local-engine');
  assert.equal(authorizeInference('openai-completions', { ...local, baseUrl: 'https://api.openai.com/v1' }, options, env).ok, false);
  assert.equal(authorizeInference('openai-completions', { ...local, provider: 'openai' }, options, env).ok, false);
  writeFileSync(path, '{}'); assert.equal(authorizeInference('openai-completions', local, options, env).ok, false);
});
