import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, fsyncSync, closeSync, openSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const failure = (code, message) => ({ ok: false, error: { code, message } });
function trustedJson(path) {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw new Error(`Untrusted root-owned configuration: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
function atomic(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(temporary, mode); chownSync(temporary, 0, 0); renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
async function configAt(artifact, path) {
  const { loadCoreConfig } = await import(pathToFileURL(join(artifact, 'dist/core/config.js')));
  const parsed = loadCoreConfig(path);
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  return parsed.value;
}
export function personBinding(config, binding, token) {
  if (binding?.version !== 1 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(binding.user) || typeof binding.scopeId !== 'string' ||
      typeof binding.tokenFile !== 'string' || !isAbsolute(binding.tokenFile) || /[\0\r\n]/.test(binding.tokenFile)) return failure('invalid-binding', 'Explicit person scope and credential-file binding required');
  const scope = config.scopes.find(item => item.id === binding.scopeId);
  const principal = config.principals.find(item => item.id === scope?.principalId);
  const sha256 = createHash('sha256').update(token.trim()).digest('hex');
  const credential = config.credentials.find(item => item.sha256 === sha256);
  if (!scope || principal?.kind !== 'person' || principal.person !== binding.user || !token.trim() ||
      credential?.principalId !== principal.id || credential.purpose !== 'service' || !credential.scopeIds.includes(scope.id)) return failure('binding-not-granted', 'Credential must already bind this exact person and scope in unified core configuration');
  return { ok: true, value: { user: binding.user, scopeId: scope.id, tokenFile: binding.tokenFile,
    url: `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}` } };
}
export async function coreHost(operation, artifact, configPath, bindingPath) {
  try {
    if (!['check', 'preflight', 'proof', 'install', 'bind-person'].includes(operation) || !isAbsolute(artifact) || !isAbsolute(configPath)) return failure('invalid-operation', 'check|preflight|proof|install|bind-person requires absolute artifact and configuration paths');
    const config = await configAt(artifact, configPath);
    if (operation === 'check') return { ok: true, value: { scopes: config.scopes.map(scope => scope.id), url: `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}` } };
    if (process.getuid() !== 0) return failure('root-required', 'Core custody inspection, installation and person binding require root');
    if (operation === 'proof') {
      const base = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
      const response = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(3000) });
      const health = await response.json();
      if (!response.ok || health.ok !== true || health.service !== 'pi-stack-core' || health.releaseCommit !== config.releaseCommit || health.scopeCount !== config.scopes.length) return failure('core-health-unsettled', 'Configured core release/scope ownership is not healthy');
      const { Database } = await import('bun:sqlite');
      const scopes = [];
      for (const scope of config.scopes) {
        if (scope.availability.kind === 'unavailable') { scopes.push({ scopeId: scope.id, availability: scope.availability }); continue; }
        const metadata = statSync(scope.storage.adoptionReceiptPath);
        if (!metadata.isFile() || ![0, scope.custody.uid].includes(metadata.uid) || metadata.mode & 0o022) return failure('adoption-untrusted', 'Scope adoption receipt custody changed');
        const receipt = JSON.parse(readFileSync(scope.storage.adoptionReceiptPath, 'utf8'));
        const identity = statSync(scope.storage.databasePath, { bigint: true });
        if (receipt.scopeId !== scope.id || receipt.state !== 'detached' || receipt.databaseIdentity?.dev !== String(identity.dev) || receipt.databaseIdentity?.ino !== String(identity.ino)) return failure('adoption-storage-changed', 'Configured scope no longer owns its adopted database generation');
        const database = new Database(scope.storage.databasePath, { readonly: true });
        try {
          const rows = database.query('SELECT id,session_file,metadata FROM thread ORDER BY id').all();
          const references = rows.map(row => {
            const metadata = JSON.parse(row.metadata);
            let fileState;
            try { statSync(row.session_file); fileState = 'present'; }
            catch (error) { if (error.code !== 'ENOENT' || metadata.nativeHistoryRequired === true) throw error; fileState = 'absent'; }
            return { id: row.id, sessionFile: row.session_file, fileState, nativeGeneration: metadata.nativeGeneration ?? null, nativeHistoryRequired: metadata.nativeHistoryRequired ?? null };
          });
          scopes.push({ scopeId: scope.id, threads: rows.length, identitySha256: createHash('sha256').update(JSON.stringify(references)).digest('hex'),
            adoptionSha256: createHash('sha256').update(readFileSync(scope.storage.adoptionReceiptPath)).digest('hex') });
        } finally { database.close(); }
      }
      return { ok: true, value: { protocol: 'pi-core-adoption-proof-v1', releaseCommit: health.releaseCommit, scopes, admissionGated: false, mutated: false } };
    }
    if (operation === 'preflight') {
      const { CustodyResources } = await import(pathToFileURL(join(artifact, 'dist/core/custody-resources.js')));
      const scopes = [];
      for (const scope of config.scopes) {
        if (scope.availability.kind === 'unavailable') { scopes.push({ scopeId: scope.id, availability: scope.availability }); continue; }
        const resources = new CustodyResources(scope.custody);
        try {
          const storage = [];
          for (const [key, path] of Object.entries(scope.storage).filter(([key]) => key !== 'adoptionReceiptPath')) {
            const actual = statSync(path, { bigint: true });
            const registered = statSync(resources.directory(path), { bigint: true });
            if (actual.dev !== registered.dev || actual.ino !== registered.ino) return failure('custody-view-mismatch', `Shared core view differs from registered ${scope.id}/${key}`);
            if (key === 'sessionsDir' ? !actual.isDirectory() : !actual.isFile()) return failure('custody-storage-invalid', `Existing ${scope.id}/${key} has the wrong storage kind`);
            storage.push({ key, path, dev: String(actual.dev), ino: String(actual.ino) });
          }
          for (const entry of scope.resources) {
            const actual = statSync(entry.path, { bigint: true });
            const registered = statSync(resources.directory(entry.path), { bigint: true });
            if (actual.dev !== registered.dev || actual.ino !== registered.ino || (entry.kind === 'file' ? !actual.isFile() : !actual.isDirectory())) return failure('custody-resource-invalid', `Registered ${scope.id} resource is unavailable in the shared core view`);
          }
          scopes.push({ scopeId: scope.id, availability: scope.availability, storage });
        } finally { resources.close(); }
      }
      return { ok: true, value: { protocol: 'pi-core-conservation-preflight-v1', scopes, mutated: false } };
    }
    if (operation === 'install') {
      if (configPath !== '/etc/pi-stack/core.json' || artifact !== '/srv/pi/pi-orchestrator') return failure('installation-path-invalid', 'The service has one declared artifact and configuration owner');
      const selected = readFileSync(join(artifact, '.pi-stack-commit'), 'utf8').trim();
      if (!/^[a-f0-9]{40}$/.test(selected)) return failure('source-identity-invalid', 'Selected core artifact requires an exact immutable commit');
      const owned = trustedJson(configPath);
      atomic(configPath, JSON.stringify({ ...owned, releaseCommit: selected }, null, 2) + '\n', 0o600);
      for (const name of ['pi-stack-core.service', 'pi-stack-core-custody.service']) atomic(`/etc/systemd/system/${name}`, readFileSync(join(artifact, 'host', name), 'utf8'), 0o644);
    } else {
      if (!isAbsolute(bindingPath ?? '')) return failure('invalid-binding', 'A root-owned binding file is required');
      const binding = trustedJson(bindingPath);
      const tokenStat = statSync(binding.tokenFile);
      if (!tokenStat.isFile() || (tokenStat.mode & 0o007)) return failure('credential-custody-invalid', 'Core credential must be a private file');
      const resolved = personBinding(config, binding, readFileSync(binding.tokenFile, 'utf8'));
      if (!resolved.ok) return resolved;
      const { user, url, scopeId, tokenFile } = resolved.value;
      const environment = `PI_CORE_URL=${url}\nPI_CORE_SCOPE_ID=${scopeId}\nPI_CORE_TOKEN_FILE=${JSON.stringify(tokenFile)}\nPI_MODEL_BROKER_URL=${url}/v1/model-broker\n`;
      const path = `/etc/pi-stack/users/${user}/core.env`;
      atomic(path, environment, 0o644);
      atomic(`/etc/systemd/system/pi-remote@${user}.service.d/90-core.conf`, `[Unit]\nWants=pi-stack-core.service\nAfter=pi-stack-core.service\n[Service]\nEnvironmentFile=${path}\nUnsetEnvironment=PI_ORCHESTRATOR_URL PI_ORCHESTRATOR_FLEET_URL PI_ORCHESTRATOR_CONTROL_URL\n`, 0o644);
    }
    const reload = spawnSync('systemctl', ['daemon-reload'], { encoding: 'utf8', timeout: 5_000 });
    if (reload.error || reload.status !== 0) return failure('unit-reload-failed', reload.error?.message ?? reload.stderr);
    return { ok: true, value: { operation, activated: false } };
  } catch (error) { return failure('core-host-unavailable', String(error)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await coreHost(...process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 66;
}
