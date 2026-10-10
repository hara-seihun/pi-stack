import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('..', import.meta.url));
const runtime = fs.readFileSync(join(source, 'deploy/runtime'), 'utf8');
const hashRecipe = runtime.match(/dependency_hash=\$\(\{\n([\s\S]*?)\n\} \| sha256sum \| cut -d' ' -f1\)/)[1];
const bundleRecipe = runtime.split('\n').find(line => line.includes('--outfile="$stage/capacity/native-session.js"'));

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-runtime-closure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  fs.mkdirSync(join(root, 'deploy'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'deploy/runtime']) {
    fs.copyFileSync(join(source, name), join(root, name));
  }
  for (const name of ['runtime', 'orchestrator', 'kenan-memory', 'kenan-root']) {
    fs.cpSync(join(source, 'packages', name), join(root, 'packages', name), {
      recursive: true, filter: path => !['node_modules', 'dist'].includes(path.split('/').at(-1)),
    });
  }
  return { directory, root };
}

function run(script, cwd, args = []) {
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${script}`, '--', ...args], {
    cwd, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function identity(root) {
  return run(`{\n${hashRecipe}\n} | sha256sum | cut -d' ' -f1`, root);
}

test('runtime dependency identity changes with the bundle recipe, not just its source files', t => {
  const { root } = fixture(t);
  const current = identity(root);
  const file = join(root, 'deploy/runtime');
  const withoutNarration = runtime.replace(' --alias:pi-orchestrator/anthropic-narration="$root/packages/orchestrator/src/threads/anthropic-narration.mjs"', '');
  assert.notEqual(withoutNarration, runtime);
  fs.writeFileSync(file, withoutNarration);
  assert.notEqual(identity(root), current, 'a changed alias must not reuse the prior dependency closure');
  fs.writeFileSync(file, runtime);
  assert.equal(identity(root), current, 'unchanged inputs must retain their cache identity');
});

test('the actual deployment bundle imports from an isolated runtime without an Orchestrator package link', t => {
  const { directory, root } = fixture(t);
  fs.symlinkSync(fs.realpathSync(join(source, 'node_modules')), join(root, 'node_modules'));
  const stage = join(directory, 'isolated');
  fs.mkdirSync(join(stage, 'capacity'), { recursive: true });
  fs.writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
  const metadata = join(stage, 'bundle.json');
  run(`root=$1; stage=$2\n${bundleRecipe} --metafile="$stage/bundle.json"`, root, [root, stage]);
  const external = Object.values(JSON.parse(fs.readFileSync(metadata, 'utf8')).outputs)
    .flatMap(output => output.imports).filter(item => item.external).map(item => item.path);
  assert.ok(external.length > 0);
  assert.equal(external.some(name => name === 'pi-orchestrator' || name.startsWith('pi-orchestrator/')), false, external.join('\n'));
  const packages = new Set(external.filter(name => !name.startsWith('node:')).map(name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]));
  for (const name of packages) {
    const link = join(stage, 'node_modules', name);
    fs.mkdirSync(dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(join(source, 'node_modules', name)), link);
  }
  fs.copyFileSync(join(source, 'packages/runtime/managed-agent.mjs'), join(stage, 'managed-agent.mjs'));
  const env = { ...process.env };
  delete env.PI_STACK_NATIVE_SESSION_MODULE;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
const sdk = await import('@earendil-works/pi-coding-agent');
const owner = await import('./managed-agent.mjs');
if (typeof sdk.main !== 'function' || typeof owner.createManagedAgentSession !== 'function' || typeof owner.recoverNativeSessionOwners !== 'function') throw Error('Incomplete managed exports');
`], { cwd: stage, encoding: 'utf8', timeout: 8000, env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
