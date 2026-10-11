import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, fsyncSync, closeSync, openSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const failure = (code, message) => ({ ok: false, error: { code, message } });
function trustedJson(path) {
  const metadata = lstatSync(path);
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
export function nativeModelBinding(config, binding, uid, readOriginal) {
  const listeners = config.broker.retainedListeners;
  if (typeof binding.modelBrokerUrl !== 'string' || typeof binding.modelBrokerPrincipalId !== 'string' || !Number.isSafeInteger(binding.modelBrokerUid) || !Array.isArray(config.broker.freshListeners)) return failure('native-model-binding-missing', 'Explicit retained native principal, UID and listener origin required');
  let url;
  try { url = new URL(binding.modelBrokerUrl); } catch { return failure('native-model-binding-invalid', 'Native model origin is invalid'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !url.port) return failure('native-model-binding-invalid', 'Exact retained loopback native model origin required');
  const port = Number(url.port);
  const declarations = [...(listeners.kind === 'uid-bound' ? listeners.bindings : []), ...config.broker.freshListeners.map(item => item.binding)];
  const retained = declarations.find(item => item.principalId === binding.modelBrokerPrincipalId && item.port === port && item.uid === binding.modelBrokerUid);
  const scope = config.scopes.find(item => item.id === binding.scopeId);
  const rootScopeIds = config.root.kind === 'configured' ? [config.root.consultationScopeId, ...config.root.consultationOwners.map(item => item.scopeId)] : [];
  const callerUid = rootScopeIds.includes(scope?.id) ? 0 : uid;
  if (!retained || !retained.authorizedUids.includes(callerUid)) return failure('native-model-binding-denied', 'Native UID is not admitted by this exact retained principal listener');
  const fresh = config.broker.freshListeners.find(item => item.binding === retained);
  if (fresh && (!config.broker.configPaths.includes(fresh.configPath) || JSON.stringify(config.broker.grantFootprints.find(item => item.configPath === fresh.configPath)?.ledgerOwnerIds) !== '["current"]')) return failure('native-model-source-missing', 'Fresh source must bind its exact current-ledger publication footprint');
  const matched = (fresh ? [fresh.configPath] : config.broker.configPaths).some(path => {
    const original = readOriginal(path);
    return (!fresh || original.listeners.length === 1) && original.listeners.some(item => item.principal === retained.principalId && item.port === retained.port);
  });
  if (!matched) return failure('native-model-source-missing', 'Retained listener has no exact original configuration footprint');
  return { ok: true, value: binding.modelBrokerUrl };
}
export function gatewayBinding(config, binding, uid, personOnly) {
  if (binding?.version !== 1 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(binding.user) || !/^[a-zA-Z0-9_.:-]+$/.test(binding.scopeId ?? '') ||
      !/^[a-zA-Z0-9_.:-]+$/.test(binding.gatewayId ?? '') || !Number.isSafeInteger(uid) || uid < 0 || config.gatewayTransport?.kind !== 'unix' || config.gatewayTransport.socketDir !== '/run/pi-stack/gateways') return failure('invalid-binding', 'Explicit configured Unix gateway, scope and actual UID required');
  const scope = config.scopes.find(item => item.id === binding.scopeId);
  const owner = config.principals.find(item => item.id === scope?.principalId);
  const gateway = config.gatewayBindings.find(item => item.gatewayId === binding.gatewayId);
  const caller = config.principals.find(item => item.id === gateway?.principalId);
  if (!scope || !caller || gateway?.peerUid !== uid || gateway.purpose !== 'core-ingress' || scope.custody.uid !== uid || !gateway.scopeIds.includes(scope.id) ||
      !['none', 'remote-callback'].includes(scope.callbackGateway?.kind) || scope.callbackGateway.kind === 'remote-callback' && scope.callbackGateway.peerUid !== uid ||
      personOnly && (scope.callbackGateway.kind !== 'remote-callback' || caller.kind !== 'person' || caller.person !== binding.user || owner?.kind !== 'person' || owner.person !== binding.user)) return failure('binding-not-granted', 'Gateway must already bind this exact custodian UID and scope in unified configuration');
  return { ok: true, value: { user: binding.user, scopeId: scope.id, principalId: scope.principalId, gatewayId: gateway.gatewayId,
    callbackSocket: scope.callbackGateway.kind === 'remote-callback' ? `/run/pi-stack/gateways/remote-${scope.id}/callback.sock` : null,
    url: `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}` } };
}
export function preflightResource(entry, resources, outputPaths) {
  let path = entry.path, output = false;
  try { statSync(path); }
  catch (cause) {
    if (cause.code !== 'ENOENT' || entry.kind !== 'file' || !outputPaths.includes(path)) throw cause;
    output = true; path = dirname(path);
    while (true) {
      try { statSync(path); break; }
      catch (error) { if (error.code !== 'ENOENT' || dirname(path) === path) throw error; path = dirname(path); }
    }
  }
  const actual = statSync(path, { bigint: true }), registered = statSync(resources.directory(path), { bigint: true });
  if (actual.dev !== registered.dev || actual.ino !== registered.ino || (output || entry.kind === 'directory' ? !actual.isDirectory() : !actual.isFile())) return failure('custody-resource-invalid', 'Declared resource or registered output ancestor differs from its owning view');
  return { ok: true, value: { path: entry.path, state: output ? 'declared-output' : 'existing', observedAncestor: path } };
}
export async function coreHost(operation, artifact, configPath, bindingPath, requestId) {
  try {
    if (!['check', 'preflight', 'proof', 'install', 'bind-person', 'bind-gateway', 'provision'].includes(operation) || !isAbsolute(artifact) || !isAbsolute(configPath)) return failure('invalid-operation', 'check|preflight|proof|install|bind-person|bind-gateway requires absolute artifact and configuration paths');
    const config = await configAt(artifact, configPath);
    if (operation === 'check') return { ok: true, value: { scopes: config.scopes.map(scope => scope.id), url: `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}` } };
    if (process.getuid() !== 0) return failure('root-required', 'Core custody inspection, installation and person binding require root');
    if (operation === 'provision') {
      if (!isAbsolute(bindingPath ?? '') || typeof requestId !== 'string' || !requestId) return failure('invalid-registration', 'Explicit protected registration path and stable request ID required');
      const { provisionRegisteredAccount } = await import(pathToFileURL(join(artifact, 'dist/core/provision-command.js')));
      return provisionRegisteredAccount({ configPath, registrationPath: bindingPath, requestId });
    }
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
          const outputs = config.duties.kind === 'configured' ? config.duties.entries.filter(entry => entry.scopeId === scope.id).map(entry => entry.path) : [];
          for (const entry of scope.resources) {
            const checked = preflightResource(entry, resources, outputs);
            if (!checked.ok) return checked;
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
      if (config.gatewayTransport.kind === 'unix') {
        mkdirSync(config.gatewayTransport.socketDir, { recursive: true, mode: 0o755 });
        const directory = lstatSync(config.gatewayTransport.socketDir);
        if (!directory.isDirectory() || directory.uid !== 0 || directory.mode & 0o022) return failure('gateway-directory-untrusted', 'Gateway parent must be root-owned and protected');
        chmodSync(config.gatewayTransport.socketDir, 0o755);
      }
      for (const name of ['pi-stack-core.service', 'pi-stack-core-custody.service']) atomic(`/etc/systemd/system/${name}`, readFileSync(join(artifact, 'host', name), 'utf8'), 0o644);
    } else {
      if (!isAbsolute(bindingPath ?? '')) return failure('invalid-binding', 'A root-owned binding file is required');
      const binding = trustedJson(bindingPath);
      if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(binding.user ?? '')) return failure('invalid-binding', 'Explicit registered custodian user required');
      const identity = spawnSync('/usr/bin/getent', ['passwd', binding.user], { encoding: 'utf8', timeout: 1000 });
      const fields = identity.stdout?.trim().split(':');
      if (identity.error || identity.status !== 0 || fields?.[0] !== binding.user || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) return failure('custodian-unavailable', 'Configured custodian has no actual Unix identity');
      const uid = Number(fields[2]), gid = Number(fields[3]);
      const resolved = gatewayBinding(config, binding, uid, operation === 'bind-person');
      if (!resolved.ok) return resolved;
      const model = nativeModelBinding(config, binding, uid, source => {
        const footprint = config.broker.grantFootprints.find(item => item.configPath === source);
        if (!footprint) throw new Error('Original native model source has no declared owner footprint');
        const owners = footprint.ledgerOwnerIds.map(id => id === 'current' ? config.broker.uid : config.broker.retainedLedgers.find(item => item.id === id)?.uid);
        const metadata = statSync(source);
        if (!metadata.isFile() || ![0, ...owners].includes(metadata.uid) || metadata.mode & 0o022) throw new Error('Untrusted original native model source');
        return JSON.parse(readFileSync(source, 'utf8'));
      });
      if (!model.ok) return model;
      const { user, url, scopeId, principalId, gatewayId, callbackSocket } = resolved.value;
      const path = operation === 'bind-person' ? `/etc/pi-stack/users/${user}/core.env` : binding.environmentFile;
      if (operation === 'bind-gateway' && path !== '/etc/pi-stack/rooms/core.env' && path !== `/etc/pi-stack/scopes/${scopeId}/core.env`) return failure('environment-custody-invalid', 'Service scope binding needs its explicit canonical environment path');
      if (path === '/etc/pi-stack/rooms/core.env' && callbackSocket === null) return failure('rooms-callback-missing', 'Rooms Remote adapter requires its declared reverse callback gateway');
      const root = '/run/pi-stack/gateways';
      mkdirSync(root, { recursive: true, mode: 0o755 });
      const parent = lstatSync(root);
      if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022) return failure('gateway-directory-untrusted', 'Gateway parent must be root-owned and protected');
      if (callbackSocket !== null) {
        const callbackDirectory = dirname(callbackSocket);
        mkdirSync(callbackDirectory, { mode: 0o755 });
        const previous = lstatSync(callbackDirectory);
        if (!previous.isDirectory() || ![0, uid].includes(previous.uid) || previous.mode & 0o022) return failure('callback-directory-untrusted', 'Callback path belongs to another or writable custodian');
        chownSync(callbackDirectory, uid, gid); chmodSync(callbackDirectory, 0o755);
      }
      const environment = `PI_CORE_URL=${url}\nPI_CORE_SCOPE_ID=${scopeId}\nPI_CORE_PRINCIPAL_ID=${principalId}\nPI_CORE_GATEWAY_ID=${gatewayId}\nPI_CORE_GATEWAY_SOCKET=/run/pi-stack/gateways/${gatewayId}.sock\nPI_CORE_GATEWAY_UID=0\nPI_MODEL_BROKER_URL=${model.value}\n`
        + (callbackSocket === null ? '' : `PI_CORE_CALLBACK_SOCKET=${callbackSocket}\nPI_CORE_CALLBACK_UID=0\n`);
      let providerEnvironment = '';
      if (binding.modelBrokerOwnerId !== undefined) {
        const gateway = config.gatewayBindings.find(item => item.gatewayId === gatewayId);
        const owner = config.broker.ownerRoutes.find(item => item.ownerId === binding.modelBrokerOwnerId && item.scopeId === scopeId && item.callerPrincipals.includes(gateway.principalId));
        if (!owner) return failure('provider-owner-unbound', 'Explicit provider owner must already bind this gateway principal and scope');
        providerEnvironment = `PI_CORE_PROVIDER_OWNER_ID=${owner.ownerId}\n`;
      }
      atomic(path, environment + providerEnvironment, 0o644);
      if (operation === 'bind-person') atomic(`/etc/systemd/system/pi-remote@${user}.service.d/90-core.conf`, `[Unit]\nWants=pi-stack-core.service\nAfter=pi-stack-core.service\n[Service]\nEnvironmentFile=${path}\nUnsetEnvironment=PI_ORCHESTRATOR_URL PI_ORCHESTRATOR_FLEET_URL PI_ORCHESTRATOR_CONTROL_URL PI_CORE_TOKEN_FILE\n`, 0o644);
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
