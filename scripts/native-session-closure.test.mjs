import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native session bundle loads without external Orchestrator or Remote workspace links', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-session-closure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const modules = join(directory, 'node_modules');
  mkdirSync(modules);
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  for (const name of readdirSync(join(root, 'node_modules'))) {
    if (name === 'pi-orchestrator' || name === 'pi-remote' || name === '@hara-seihun') continue;
    symlinkSync(join(root, 'node_modules', name), join(modules, name));
  }
  const bundle = join(directory, 'native-session.js');
  const build = spawnSync(process.execPath, [join(root, 'scripts/build-native-session.mjs'), bundle],
    { encoding: 'utf8', timeout: 8000 });
  assert.equal(build.status, 0, build.stderr);
  const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const owner = await import(${JSON.stringify(bundle)});
    for (const name of ['createManagedAgentSession', 'recoverNativeSessionOwners', 'nativeOwnerAbsent']) {
      assert.equal(typeof owner[name], 'function', name);
    }
  `], { encoding: 'utf8', timeout: 8000 });
  assert.equal(loaded.status, 0, loaded.stderr);
});

test('an unmapped workspace import refuses the build without writing a bundle', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-session-unclosed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'packages/orchestrator/src/threads'), { recursive: true });
  copyFileSync(join(root, 'scripts/build-native-session.mjs'), join(directory, 'scripts/build-native-session.mjs'));
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
  writeFileSync(join(directory, 'packages/orchestrator/src/threads/native-session.ts'), 'import "pi-orchestrator/api";');
  const bundle = join(directory, 'native-session.js');
  const build = spawnSync(process.execPath, [join(directory, 'scripts/build-native-session.mjs'), bundle],
    { encoding: 'utf8', timeout: 8000 });
  assert.notEqual(build.status, 0);
  assert.match(build.stderr, /Native session closure has external workspace imports: pi-orchestrator\/api/);
  assert.equal(existsSync(bundle), false);
});
