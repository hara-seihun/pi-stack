import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, chmodSync } from 'node:fs';
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
    if (prior?.protocol === 'pi-host-plan-v1' && prior.candidate === candidate && prior.hostKey === hostKey && prior.state !== 'accepted') return { ok: true, value: prior };
    const configurationChanged = prior?.protocol !== 'pi-host-plan-v1' || prior.hostKey !== hostKey || prior.state !== 'accepted';
    const owners = Object.fromEntries(Object.entries(candidateKeys).map(([owner, candidateKey]) => [owner, {
      candidateKey, previousKey: previousKeys[owner] ?? null,
      changed: configurationChanged || candidateKey !== previousKeys[owner],
    }]));
    const value = { protocol: 'pi-host-plan-v1', state: 'prepared', candidate, previous: previous || null, hostKey, configurationChanged, owners };
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o644 });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
    return { ok: true, value };
  } catch (error) { return { ok: false, error: { code: 'host-plan-unavailable', message: String(error) } }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, ...args] = process.argv.slice(2);
  const result = operation === 'create' ? hostPlan(...args) : operation === 'verify-owner'
    ? verifyOwner(args[0], JSON.parse(readFileSync(args[1], 'utf8')), args[2], args[3])
    : { ok: false, error: { code: 'host-plan-operation-invalid' } };
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 66;
}
