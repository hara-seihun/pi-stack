import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '..');
test('enabled release refreshes the fixed access owner, disabled release changes nothing, failure rejects acceptance', t => {
  const directory = mkdtempSync(join(tmpdir(), 'one-kenan-access-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo'), deploy = join(repo, 'deploy');
  mkdirSync(deploy, { recursive: true });
  for (const name of ['lib', 'release-checkout', 'one-kenan-access-release']) copyFileSync(join(source, 'deploy', name), join(deploy, name));
  writeFileSync(join(deploy, 'one-kenan-access'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\nexit "${ACCESS_EXIT:-0}"\n', { mode: 0o755 });
  for (const args of [['init','-q',repo], ['-C',repo,'add','.'], ['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']]) {
    assert.equal(spawnSync('git', args).status, 0);
  }
  const host = join(directory, 'host.json'), config = join(directory, 'access.json'), command = join(directory, 'pi-kenan-access'), trace = join(directory, 'trace');
  writeFileSync(config, '{}');
  const env = { ...process.env, PI_STACK_DEPLOY_NO_SUDO:'1', PI_STACK_HOST_LOCK_PATH:join(directory,'lock'), PI_KENAN_ACCESS_CONFIG:config, PI_KENAN_ACCESS_COMMAND:command, TRACE:trace };
  function run(enabled, overrides={}) {
    writeFileSync(host, JSON.stringify({ version:1, oneKenan:enabled }));
    return spawnSync('bash', [join(deploy,'one-kenan-access-release'), host], { encoding:'utf8', timeout:3000, env:{...env,...overrides} });
  }
  let result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(command), false);
  assert.equal(existsSync(trace), false);
  result = run(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(trace,'utf8'), `apply --config ${config}\n`);
  assert.match(result.stdout, /no service restarted/);
  assert.equal(readFileSync(command,'utf8'), readFileSync(join(deploy,'one-kenan-access'),'utf8'));
  result = run(true, {ACCESS_EXIT:'1'});
  assert.equal(result.status, 1);
  rmSync(config);
  result = run(true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Enabled One Kenan is missing/);
});
