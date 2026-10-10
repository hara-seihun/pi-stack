import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

test('only a successful exact doctor command earns reusable proof; changed probe source runs again', t => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-command-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'deploy')); mkdirSync(join(root, 'packages/runtime'), { recursive: true });
  for (const file of ['runtime-doctors', 'lib', 'release-checkout', 'doctor-cache.mjs', 'prepared-components.mjs']) copyFileSync(new URL(`../deploy/${file}`, import.meta.url), join(root, 'deploy', file));
  const runtime = join(root, 'runtime'), home = join(root, 'home'), cache = join(root, 'proofs');
  mkdirSync(join(runtime, 'node_modules'), { recursive: true }); mkdirSync(join(home, '.pi/agent'), { recursive: true });
  writeFileSync(join(home, '.pi/agent/settings.json'), '{"packages":[]}');
  const probe = join(root, 'packages/runtime/browser-doctor.mjs');
  writeFileSync(probe, `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.TRACE, 'doctor\\n'); process.exit(Number(process.env.TEST_EXIT));`);
  const trace = join(root, 'trace'), user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  const run = exit => spawnSync('bash', [join(root, 'deploy/runtime-doctors'), 'browser', root, user, root], { encoding: 'utf8', timeout: 3000, env: { ...process.env, PI_STACK_HOME_OVERRIDE: home, PI_STACK_DEPLOY_NO_SUDO: '1', PI_STACK_RUNTIME_DEST: runtime, PI_STACK_DOCTOR_CACHE_ROOT: cache, TEST_EXIT: String(exit), TRACE: trace } });
  assert.equal(run(42).status, 42);
  const passed = run(0); assert.equal(passed.status, 0, passed.stderr);
  const reused = run(42); assert.equal(reused.status, 0, reused.stderr); assert.match(reused.stdout, /proof reused/);
  assert.equal(readFileSync(trace, 'utf8'), 'doctor\ndoctor\n');
  assert.equal(readdirSync(join(cache, user)).length, 1);
  writeFileSync(probe, readFileSync(probe, 'utf8') + '\n// changed probe contract\n');
  assert.equal(run(42).status, 42);
  assert.equal(readdirSync(join(cache, user)).length, 1, 'failed new probe cannot acquire a success receipt');
});
