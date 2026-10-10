import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname, release, arch, platform } from 'node:os';
import { pathToFileURL } from 'node:url';
import { digest } from './prepared-components.mjs';

export function doctorKey(phase, runtime, home, control) {
  if (!['browser', 'model'].includes(phase)) throw new Error('doctor phase is required');
  const hash = createHash('sha256').update(JSON.stringify(['pi-doctor-cache-v1', phase, hostname(), release(), arch(), platform(), process.version, home]));
  hash.update(readFileSync(new URL('./doctor-cache.mjs', import.meta.url)));
  hash.update(readFileSync(join(control, 'deploy/runtime-doctors')));
  const closure = realpathSync(join(runtime, 'node_modules'));
  const cache = join(resolve(runtime, '..'), '.pi-stack-doctor-inputs');
  const files = phase === 'browser' ? ['browser-doctor.mjs', 'browser-probe.mjs', 'browser-tab-restore-probe.mjs', 'managed-agent.mjs'] : ['model-selection-doctor.mjs'];
  for (const file of files) {
    const path = join(control, 'packages/runtime', file);
    hash.update(file).update(existsSync(path) ? readFileSync(path) : 'unset');
  }
  const packagesToProve = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui',
    ...(phase === 'browser' ? ['agent-browser', 'pi-agent-browser-native', 'react', 'react-dom', 'scheduler'] : [])];
  for (const name of packagesToProve) {
    const path = join(closure, name);
    hash.update(name).update(existsSync(path) ? digest(realpathSync(path), cache) : 'unset');
  }
  const executable = phase === 'browser' ? join(closure, '.bin/agent-browser') : join(closure, '.bin/pi-model-selection-doctor');
  hash.update(existsSync(executable) ? digest(realpathSync(executable), cache) : 'unset');
  const dependencyLock = join(closure, '.package-lock.json');
  hash.update(existsSync(dependencyLock) ? readFileSync(dependencyLock) : 'unset');
  if (phase === 'browser') {
    const owner = join(runtime, 'capacity/native-session.js');
    hash.update(existsSync(owner) ? readFileSync(owner) : 'unset');
  }
  for (const name of ['settings.json', 'models.json', 'auth.json']) {
    const path = join(home, '.pi/agent', name);
    hash.update(name).update(existsSync(path) ? readFileSync(path) : 'unset');
  }
  const settingsPath = join(home, '.pi/agent/settings.json');
  const packages = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')).packages : [];
  for (const entry of packages ?? []) {
    if (typeof entry !== 'string' || /^(npm:|git:|https?:)/.test(entry)) continue;
    const target = realpathSync(entry);
    hash.update(entry).update(digest(target, cache));
  }
  for (const directory of [join(home, '.cache/ms-playwright'), join(home, '.cache/agent-browser'), process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean)) {
    hash.update(directory);
    if (!existsSync(directory)) { hash.update('unset'); continue; }
    function scan(path) {
      const info = statSync(path, { bigint: true });
      hash.update(JSON.stringify([path, String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]));
      if (info.isDirectory()) for (const name of readdirSync(path).sort()) scan(join(path, name));
    }
    scan(directory);
  }
  for (const path of ['/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/google/chrome/chrome', process.env.AGENT_BROWSER_EXECUTABLE_PATH].filter(Boolean)) {
    hash.update(path);
    if (!existsSync(path)) { hash.update('unset'); continue; }
    const info = statSync(path, { bigint: true });
    hash.update(JSON.stringify([realpathSync(path), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]));
  }
  return hash.digest('hex');
}
export function doctorReceipt(directory, key, action, phase) {
  if (!/^[a-f0-9]{64}$/.test(key) || !['verify', 'record'].includes(action)) throw new Error('invalid doctor cache input');
  const path = join(directory, `${key}.json`);
  if (action === 'verify') {
    if (!existsSync(path)) return false;
    const proof = JSON.parse(readFileSync(path, 'utf8'));
    if (proof.protocol !== 'pi-doctor-proof-v1' || proof.key !== key || proof.phase !== phase || proof.state !== 'passed') throw new Error('invalid doctor proof');
    return true;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ protocol: 'pi-doctor-proof-v1', phase, key, state: 'passed', passedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'key') console.log(doctorKey(...args));
    else if (doctorReceipt(args[0], args[1], action, args[2])) console.log(`runtime doctor ${args[2]} proof reused: ${args[1]}`);
    else process.exitCode = 3;
  } catch (error) { console.error(`doctor-cache-invalid: ${error.message}`); process.exitCode = 66; }
}
