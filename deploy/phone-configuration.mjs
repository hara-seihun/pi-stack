import { readFileSync, writeFileSync, statSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, existsSync, fchownSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function atomic(path, bytes, mode, uid, gid) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try { if (uid !== undefined) fchownSync(fd, uid, gid); writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function phoneConfiguration(action, hostFile, revision, canonical, stateRoot = '/var/lib/pi-stack/phone-configurations') {
  try {
    if (!['inspect', 'prepare', 'activate', 'restore'].includes(action) || !/^[0-9a-f]{40}$/.test(revision)
      || !canonical.startsWith('/') || resolve(canonical) !== canonical) throw Error('Explicit Phone configuration action, source revision and canonical path required');
    const host = JSON.parse(readFileSync(hostFile, 'utf8'));
    if (!Object.hasOwn(host, 'phoneConfigurationCandidate')) return { ok: true, value: { kind: 'canonical', path: canonical } };
    const candidate = host.phoneConfigurationCandidate;
    if (typeof candidate !== 'string' || !candidate.startsWith('/') || resolve(candidate) !== candidate || candidate === canonical) throw Error('Phone configuration candidate must be an explicit distinct absolute path');
    const serving = statSync(canonical), prepared = statSync(candidate);
    if (!serving.isFile() || !prepared.isFile() || prepared.uid !== serving.uid || (prepared.mode & 0o077)) throw Error('Phone candidate must be an owner-only regular file of the canonical configuration owner');
    if (action === 'inspect') return { ok: true, value: { kind: 'candidate', path: candidate } };
    const bytes = readFileSync(candidate), current = readFileSync(canonical);
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const receipt = join(stateRoot, `${revision}.json`);
    let state = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null;
    if (state && (state.revision !== revision || state.candidate !== candidate || state.canonical !== canonical
      || state.candidateHash !== hash(bytes))) throw Error('Phone candidate changed after readiness proof');
    const save = () => atomic(receipt, JSON.stringify(state) + '\n', 0o600);
    if (action === 'prepare') {
      if (!state) { state = { revision, candidate, canonical, candidateHash: hash(bytes), canonicalHash: hash(current), phase: 'prepared' }; save(); }
      if (!['prepared', 'active'].includes(state.phase)) throw Error('Phone configuration attempt was already restored');
    } else if (action === 'activate') {
      if (!state) throw Error('Phone candidate lacks a successful readiness receipt');
      if (state.phase === 'prepared') {
        if (hash(current) !== state.canonicalHash) throw Error('Canonical Phone configuration changed after readiness');
        state.capture = current.toString('base64'); state.uid = serving.uid; state.gid = serving.gid; state.mode = serving.mode & 0o777;
        state.phase = 'activating'; save();
      }
      if (state.phase === 'activating') {
        if (![state.canonicalHash, state.candidateHash].includes(hash(current))) throw Error('Phone activation lost canonical custody');
        atomic(canonical, bytes, state.mode, state.uid, state.gid); state.phase = 'active'; save();
      }
      if (state.phase !== 'active' || hash(readFileSync(canonical)) !== state.candidateHash) throw Error('Phone activation has no matching canonical configuration');
    } else {
      if (!state || state.phase === 'prepared' || state.phase === 'restored') return { ok: true, value: { kind: 'candidate', path: canonical, phase: 'restored' } };
      if (!['active', 'activating'].includes(state.phase) || ![state.canonicalHash, state.candidateHash].includes(hash(current))) throw Error('Phone rollback refuses another canonical configuration generation');
      atomic(canonical, Buffer.from(state.capture, 'base64'), state.mode, state.uid, state.gid); state.phase = 'restored'; save();
    }
    return { ok: true, value: { kind: 'candidate', path: canonical, phase: state.phase } };
  } catch (error) { return { ok: false, error: { code: 'phone-configuration-custody', message: String(error) } }; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = phoneConfiguration(...process.argv.slice(2));
  if (!result.ok) { console.error(result.error.message); process.exitCode = 66; }
  else console.log(result.value.path);
}
