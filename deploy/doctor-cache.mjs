import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import { existsSync, readFileSync, realpathSync, statSync, lstatSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { hostname, release, arch, platform } from 'node:os';
import { pathToFileURL } from 'node:url';
export function doctorDigest(directory, cache) {
  const signature = createHash('sha256');
  const visited = new Map(), records = [];
  function scan(path, relative) {
    const info = lstatSync(path, { bigint: true });
    signature.update(JSON.stringify([path, String(info.dev), String(info.ino), String(info.mode), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]));
    if (info.isSymbolicLink()) {
      records.push([relative, 'link']);
      scan(realpathSync(path), `${relative}/target`);
      return;
    }
    if (visited.has(path)) { records.push([relative, 'reference', visited.get(path)]); return; }
    visited.set(path, relative);
    if (info.isDirectory()) {
      records.push([relative, 'directory', Number(info.mode & 0o777n)]);
      for (const name of readdirSync(path).sort()) {
        if (name === '.pi-stack-commit') continue;
        scan(join(path, name), `${relative}/${name}`);
      }
    } else if (info.isFile()) records.push([relative, 'file', Number(info.mode & 0o777n), path]);
    else throw new Error(`Unsupported doctor input: ${path}`);
  }
  scan(realpathSync(directory), '.');
  const generation = signature.digest('hex');
  const receipt = join(cache, `closure-${createHash('sha256').update(directory).digest('hex')}.json`);
  if (existsSync(receipt)) {
    const saved = JSON.parse(readFileSync(receipt, 'utf8'));
    if (saved.protocol === 'pi-doctor-content-v1' && saved.generation === generation && /^[a-f0-9]{64}$/.test(saved.sha256)) return saved.sha256;
  }
  const content = createHash('sha256').update('pi-doctor-content-v1');
  for (const [relative, kind, mode, path] of records) {
    content.update(JSON.stringify([relative, kind, mode]));
    if (kind === 'file') content.update(readFileSync(path));
  }
  const sha256 = content.digest('hex');
  mkdirSync(cache, { recursive: true, mode: 0o755 });
  const temporary = `${receipt}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ protocol: 'pi-doctor-content-v1', generation, sha256 }));
  renameSync(temporary, receipt);
  return sha256;
}

export function configuredExtensionKey(target, cache, nonce) {
  const manifestPath = join(target, 'package.json');
  if (!existsSync(manifestPath)) return doctorDigest(target, cache);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Remote also ships the host controller, web, phone and Root. Only its Pi
  // extension entrypoints belong to the disposable browser session.
  if (manifest.name !== 'pi-remote') return doctorDigest(target, cache);
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || !entries.length || entries.some(entry => typeof entry !== 'string' || !entry.startsWith('./'))) return doctorDigest(target, cache) + nonce;
  const hash = createHash('sha256').update(JSON.stringify(['pi-remote-extension-closure-v1', manifest.type, entries]));
  const visited = new Set();
  function file(base) {
    const stem = base.replace(/\.(?:js|mjs|cjs)$/, '');
    const path = [base, `${stem}.ts`, `${stem}.mts`, `${base}.ts`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts'), join(base, 'index.js')].find(path => existsSync(path) && statSync(path).isFile());
    if (!path) throw new Error('extension import cannot be resolved');
    return realpathSync(path);
  }
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    const parsed = JSON.parse(execFileSync('bun', ['-e', `const input = JSON.parse(await Bun.stdin.text()); const t = new Bun.Transpiler({loader: input.loader}); const js = t.transformSync(input.source); console.log(JSON.stringify({js, imports: t.scanImports(js)}));`], {
      input: JSON.stringify({ source, loader: /\.(ts|mts)$/.test(path) ? 'ts' : 'js' }), encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    }));
    if (/\b(?:import|require|readFile(?:Sync)?|createRequire|glob(?:Sync)?|fetch|eval|Function)\s*\(|\bimport\.meta\b|\bnew\s+URL\s*\(/.test(parsed.js)) throw new Error('extension has unknown dynamic inputs');
    hash.update(relative(target, path)).update(source);
    for (const entry of parsed.imports) {
      if (entry.kind !== 'import-statement') throw new Error('extension has an unknown import kind');
      if (entry.path.startsWith('.')) visit(file(resolve(dirname(path), entry.path)));
      else if (isBuiltin(entry.path)) {
        if (/^(?:node:)?(?:fs|module|vm|child_process|worker_threads)(?:\/|$)/.test(entry.path)) throw new Error('extension has unknown filesystem or executable inputs');
      } else {
        const name = entry.path.startsWith('@') ? entry.path.split('/').slice(0, 2).join('/') : entry.path.split('/')[0];
        if (!['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui'].includes(name)) throw new Error('extension has an undeclared external executable dependency');
        let directory = dirname(path), packageRoot;
        while (true) {
          const candidate = join(directory, 'node_modules', name);
          if (existsSync(join(candidate, 'package.json'))) { packageRoot = realpathSync(candidate); break; }
          const parent = dirname(directory); if (parent === directory) throw new Error('extension dependency has no package root'); directory = parent;
        }
        hash.update(entry.path).update(doctorDigest(packageRoot, cache));
      }
    }
  }
  try { for (const entry of entries) visit(file(resolve(target, entry))); return hash.digest('hex'); }
  catch (error) {
    if (process.env.PI_STACK_DOCTOR_DIAGNOSTICS === '1') console.error(`doctor extension closure cold: ${error.message}`);
    return doctorDigest(target, cache) + nonce;
  }
}
export function captureDoctorBindings(phase, runtime, home, control) {
  if (!['browser', 'model'].includes(phase)) throw new Error('doctor phase is required');
  const path = join(home, '.pi/agent/settings.json');
  const bytes = existsSync(path) ? readFileSync(path) : null;
  const settings = bytes === null ? {} : JSON.parse(bytes);
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error('doctor settings packages must be an array');
  const packages = (settings.packages ?? []).map(entry => {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string') throw new Error('doctor package source is required');
    const target = /^(npm:|git:|https?:)/.test(source) ? source : realpathSync(source);
    return typeof entry === 'string' ? target : { ...entry, source: target };
  });
  return { protocol: 'pi-doctor-bindings-v1', phase, runtime: realpathSync(runtime), home: resolve(home), control: realpathSync(control),
    settingsSha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex'), packages, nonce: randomUUID() };
}
export function doctorKey(phase, runtime, home, control, bindings = captureDoctorBindings(phase, runtime, home, control)) {
  if (bindings.protocol !== 'pi-doctor-bindings-v1' || bindings.phase !== phase || bindings.home !== resolve(home) || bindings.control !== realpathSync(control) || !Array.isArray(bindings.packages) || typeof bindings.nonce !== 'string' || !bindings.nonce) throw new Error('invalid doctor input bindings');
  runtime = bindings.runtime;
  if (realpathSync(runtime) !== runtime) throw new Error('doctor runtime binding must remain immutable');
  const hash = createHash('sha256').update(JSON.stringify(['pi-doctor-cache-v4', phase, hostname(), release(), arch(), platform(), process.version, home]));
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
    hash.update(name).update(existsSync(path) ? doctorDigest(realpathSync(path), cache) : 'unset');
  }
  const executable = phase === 'browser' ? join(closure, '.bin/agent-browser') : join(closure, '.bin/pi-model-selection-doctor');
  hash.update(existsSync(executable) ? doctorDigest(realpathSync(executable), cache) : 'unset');
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
  for (const entry of bindings.packages) {
    const target = typeof entry === 'string' ? entry : entry?.source;
    if (typeof target !== 'string') throw new Error('doctor bound package source is required');
    if (/^(npm:|git:|https?:)/.test(target)) continue;
    if (realpathSync(target) !== target) throw new Error('doctor package binding must remain immutable');
    hash.update(configuredExtensionKey(target, cache, bindings.nonce));
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
    if (action === 'capture') {
      const bindings = captureDoctorBindings(...args.slice(0, 4));
      writeFileSync(args[4], JSON.stringify(bindings) + '\n', { mode: 0o600 });
      console.log(bindings.runtime);
    } else if (action === 'key') console.log(doctorKey(...args.slice(0, 4), args[4] === undefined ? undefined : JSON.parse(readFileSync(args[4], 'utf8'))));
    else if (doctorReceipt(args[0], args[1], action, args[2])) console.log(`runtime doctor ${args[2]} proof reused: ${args[1]}`);
    else process.exitCode = 3;
  } catch (error) { console.error(`doctor-cache-invalid: ${error.message}`); process.exitCode = 66; }
}
