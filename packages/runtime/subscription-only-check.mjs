import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { families } from './patch-subscription-only.mjs';

export async function checkRuntime(nodeModules) {
  try {
    const api = join(nodeModules, '@earendil-works/pi-ai/dist/api');
    const chunks = join(nodeModules, '@earendil-works/pi-coding-agent/dist/bundle/chunks');
    const helper = readFileSync(new URL('./subscription-only.mjs', import.meta.url), 'utf8');
    for (const dir of [api, chunks]) {
      if (readFileSync(join(dir, 'subscription-only.mjs'), 'utf8') !== helper) return { ok: false, error: { code: 'runtime_policy_mismatch' } };
    }
    let adapters = 0;
    for (const family of families) {
      const bundles = readdirSync(chunks).filter(name => name === `${family}.js` || name.startsWith(`${family}-`) && name.endsWith('.js'));
      if (bundles.length !== 1) return { ok: false, error: { code: 'runtime_adapter_shape', family } };
      for (const path of [join(api, `${family}.js`), join(chunks, bundles[0])]) {
        const source = readFileSync(path, 'utf8');
        const required = family === 'openrouter-images' ? 1 : 2;
        if (!source.includes('PiStack subscription-only inference boundary') || source.split(`const policy = authorizeInference(${JSON.stringify(family)}, model, options);`).length !== required + 1) return { ok: false, error: { code: 'runtime_adapter_unprotected', family } };
        adapters++;
      }
    }
    const result = await new Promise(resolveResult => execFile(process.execPath, ['--test', fileURLToPath(new URL('./subscription-only.test.mjs', import.meta.url))], { timeout: 20000, maxBuffer: 65536, env: { ...process.env, PI_TEST_NODE_MODULES: nodeModules } }, error => resolveResult(error ? { ok: false, error: { code: 'runtime_offline_causal_test_failed' } } : { ok: true, adapters, offlineCausalTests: 'passed' })));
    return result;
  } catch { return { ok: false, error: { code: 'runtime_policy_unreadable' } }; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkRuntime(resolve(process.argv[2]));
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
