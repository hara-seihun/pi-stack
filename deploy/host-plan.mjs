import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, chmodSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownerScopes, sourceKeys } from './source-scopes.mjs';
import { digest } from './prepared-components.mjs';

export function verifyOwner(root, plan, owner, runningCommit) {
  try {
    if (plan.protocol !== 'pi-host-plan-v1' || !(owner in ownerScopes)) return { ok: false, error: { code: 'host-plan-invalid' } };
    const candidateKey = sourceKeys(root, plan.candidate, { [owner]: ownerScopes[owner] })[owner];
    if (candidateKey !== plan.owners[owner]?.candidateKey) return { ok: false, error: { code: 'host-plan-source-mismatch' } };
    const runningKey = sourceKeys(root, runningCommit, { [owner]: ownerScopes[owner] })[owner];
    if (runningKey !== candidateKey) return { ok: false, error: { code: 'host-owner-source-stale', owner, runningCommit, candidate: plan.candidate } };
    return { ok: true, value: { owner, runningCommit, candidate: plan.candidate, sourceKey: candidateKey, equivalent: runningCommit !== plan.candidate } };
  } catch (error) { return { ok: false, error: { code: 'host-plan-source-unavailable', message: String(error) } }; }
}
function savePlan(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o644);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(temporary, 0o644); renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
function validProof(proof) {
  return proof?.kind === 'activated-units' && /^[a-f0-9]{40}$/.test(proof.runningCommit) && Array.isArray(proof.units) &&
    new Set(proof.units.map(item => item.unit)).size === proof.units.length && proof.units.every(item =>
      /^[a-zA-Z0-9@_.:-]+\.service$/.test(item.unit) && ['active', 'inactive', 'absent'].includes(item.state) &&
      (item.state === 'active' ? /^[a-f0-9]{32}$/.test(item.invocationId) : item.invocationId === null));
}
export function acceptOwner(root, path, candidate, owner, proof) {
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    if (plan.candidate !== candidate || !validProof(proof)) return { ok: false, error: { code: 'host-owner-proof-invalid' } };
    const source = verifyOwner(root, plan, owner, proof.runningCommit);
    if (!source.ok) return source;
    const acceptance = { protocol: 'pi-host-owner-acceptance-v1', hostKey: plan.hostKey, sourceKey: source.value.sourceKey, proof, acceptedAt: new Date().toISOString() };
    plan.owners[owner] = { ...plan.owners[owner], changed: false, acceptance };
    savePlan(path, plan);
    return { ok: true, value: acceptance };
  } catch (error) { return { ok: false, error: { code: 'host-owner-proof-unavailable', message: String(error) } }; }
}
function observeUnit(unit) {
  const state = execFileSync('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'LoadState', '-p', 'InvocationID'], { encoding: 'utf8' });
  const fields = Object.fromEntries(state.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (fields.LoadState === 'not-found') return { state: 'absent', invocationId: null };
  return { state: fields.ActiveState, invocationId: fields.ActiveState === 'active' ? fields.InvocationID : null };
}
export function ownerNeedsActivation(root, plan, owner, observe = observeUnit) {
  try {
    const entry = plan.owners?.[owner];
    if (plan.protocol !== 'pi-host-plan-v1' || !(owner in ownerScopes) || !entry || typeof entry.changed !== 'boolean') return { ok: false, error: { code: 'host-plan-invalid' } };
    const candidate = verifyOwner(root, plan, owner, plan.candidate);
    if (!candidate.ok) return candidate;
    const acceptance = entry.acceptance;
    if (!acceptance) return { ok: true, value: { changed: entry.changed } };
    if (acceptance.protocol !== 'pi-host-owner-acceptance-v1' || acceptance.hostKey !== plan.hostKey || acceptance.sourceKey !== entry.candidateKey || !validProof(acceptance.proof)) return { ok: false, error: { code: 'host-owner-proof-invalid' } };
    const source = verifyOwner(root, plan, owner, acceptance.proof.runningCommit);
    if (!source.ok) return source;
    const changed = acceptance.proof.units.some(unit => { const actual = observe(unit.unit); return actual.state !== unit.state || actual.invocationId !== unit.invocationId; });
    return { ok: true, value: { changed } };
  } catch (error) { return { ok: false, error: { code: 'host-owner-proof-unavailable', message: String(error) } }; }
}
export function hostPlan(root, candidate, previous, path, hostFile) {
  try {
    const candidateKeys = sourceKeys(root, candidate, ownerScopes);
    const previousKeys = /^[a-f0-9]{40}$/.test(previous) ? sourceKeys(root, previous, ownerScopes) : {};
    const configuration = JSON.parse(readFileSync(hostFile, 'utf8'));
    const hostHash = createHash('sha256').update(JSON.stringify(configuration));
    const hostInputsCache = join(dirname(path), '.pi-stack-host-inputs');
    for (const path of [configuration.models, ...(configuration.packages ?? []).filter(value => typeof value === 'string' && value.startsWith('/'))].filter(Boolean)) {
      hostHash.update(path).update(digest(path, hostInputsCache));
    }
    const people = process.env.PI_REMOTE_PERSONS_DIR;
    if (people && existsSync(people)) for (const file of readdirSync(people).filter(file => file.endsWith('.json')).sort()) hostHash.update(file).update(readFileSync(join(people, file)));
    const hostKey = hostHash.digest('hex');
    const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const configurationChanged = prior?.protocol !== 'pi-host-plan-v1' || prior.hostKey !== hostKey;
    const owners = Object.fromEntries(Object.entries(candidateKeys).map(([owner, candidateKey]) => {
      const acceptance = !configurationChanged && prior.owners?.[owner]?.acceptance?.sourceKey === candidateKey ? prior.owners[owner].acceptance : null;
      const pending = prior?.protocol === 'pi-host-plan-v1' && prior.state !== 'accepted';
      const previousKey = pending ? prior.owners?.[owner]?.previousKey ?? null : previousKeys[owner] ?? null;
      return [owner, { candidateKey, previousKey,
        changed: acceptance ? false : configurationChanged || candidateKey !== previousKey || (pending && prior.owners?.[owner]?.changed !== false),
        ...(acceptance ? { acceptance } : {}) }];
    }));
    const value = { protocol: 'pi-host-plan-v1', state: 'prepared', candidate, previous: previous || null, hostKey, configurationChanged, owners };
    savePlan(path, value);
    return { ok: true, value };
  } catch (error) { return { ok: false, error: { code: 'host-plan-unavailable', message: String(error) } }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, ...args] = process.argv.slice(2);
  const result = operation === 'create' ? hostPlan(...args) : operation === 'verify-owner'
    ? verifyOwner(args[0], JSON.parse(readFileSync(args[1], 'utf8')), args[2], args[3])
    : operation === 'accept-owner' ? acceptOwner(args[0], args[1], args[2], args[3], JSON.parse(readFileSync(0, 'utf8')))
    : operation === 'needs-activation' ? ownerNeedsActivation(args[0], JSON.parse(readFileSync(args[1], 'utf8')), args[2])
    : { ok: false, error: { code: 'host-plan-operation-invalid' } };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 66;
}
