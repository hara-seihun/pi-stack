import { chownSync, chmodSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function custodyVerifier(path, source, action) {
  if (action !== 'prepare' && action !== 'verify') return { ok: false, error: { code: 'custody-verifier-action-invalid' } };
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { ok: false, error: { code: 'custody-verifier-file-invalid' } };
    const bytes = readFileSync(path);
    if (!bytes.equals(readFileSync(source)) || bytes.toString().split('\n')[0] !== '#!/usr/local/bin/bun') return { ok: false, error: { code: 'custody-verifier-source-invalid' } };
    if (action === 'prepare') {
      if (process.getuid() !== 0) return { ok: false, error: { code: 'custody-verifier-root-required' } };
      chownSync(path, 0, 0);
      chmodSync(path, 0o555);
    }
    const prepared = lstatSync(path);
    if (prepared.uid !== 0 || prepared.gid !== 0 || (prepared.mode & 0o777) !== 0o555) return { ok: false, error: { code: 'custody-verifier-custody-invalid' } };
    return { ok: true, value: { path, uid: 0, gid: 0, mode: '555', interpreter: '/usr/local/bin/bun' } };
  } catch (error) { return { ok: false, error: { code: 'custody-verifier-filesystem', message: String(error) } }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = custodyVerifier(...process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 66;
}
