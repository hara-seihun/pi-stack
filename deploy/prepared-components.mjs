import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { pathToFileURL } from 'node:url';

const components = ['runtime', 'orchestrator', 'remote', 'tools'];
export function digest(directory, cacheDirectory) {
  const signature = createHash('sha256');
  function scan(path, relative) {
    const info = lstatSync(path, { bigint: true });
    signature.update(JSON.stringify([relative, String(info.dev), String(info.ino), String(info.mode), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]));
    if (info.isSymbolicLink()) signature.update(JSON.stringify([readlinkSync(path), realpathSync(path)]));
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) scan(join(path, name), join(relative, name));
  }
  scan(directory, '.');
  const key = signature.digest('hex');
  const cache = cacheDirectory && join(cacheDirectory, `${createHash('sha256').update(directory).digest('hex')}.json`);
  if (cache && existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    if (saved.signature === key && /^[a-f0-9]{64}$/.test(saved.sha256)) return saved.sha256;
  }
  const hash = createHash('sha256');
  function visit(path, relative) {
    const info = lstatSync(path);
    hash.update(JSON.stringify([relative, info.mode & 0o777]));
    if (info.isSymbolicLink()) hash.update(JSON.stringify(['link', readlinkSync(path), realpathSync(path)]));
    else if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), join(relative, name));
    else if (info.isFile()) hash.update(readFileSync(path));
    else throw new Error(`Unsupported prepared artifact: ${path}`);
  }
  visit(directory, '.');
  const sha256 = hash.digest('hex');
  if (cache) {
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o755 });
    const temporary = `${cache}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ signature: key, sha256 }));
    // Cache loss is harmless: authoritative acceptance remains the immutable receipt.
    try { linkSync(temporary, cache); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      unlinkSync(cache); linkSync(temporary, cache);
    } finally { unlinkSync(temporary); }
  }
  return sha256;
}
export function preparedComponents(releases, commit, action) {
  try {
    if (!/^[a-f0-9]{40}$/.test(commit) || !['record', 'verify'].includes(action)) return { ok: false, error: { code: 'prepared-input-invalid' } };
    const artifacts = components.map(component => {
      const path = resolve(releases, component, commit);
      if (readFileSync(join(path, '.pi-stack-commit'), 'utf8').trim() !== commit) throw new Error(`Prepared ${component} source mismatch`);
      return { component, path, sha256: digest(path, resolve(releases, '.prepared', '.hashes')) };
    });
    const directory = resolve(releases, '.prepared');
    const receipt = join(directory, `${commit}.json`);
    const value = { protocol: 'prepared-components-v1', commit, artifacts };
    const matchesReceipt = () => JSON.stringify(JSON.parse(readFileSync(receipt, 'utf8'))) === JSON.stringify(value);
    const changed = { ok: false, error: { code: 'prepared-artifact-changed', receipt } };
    if (action === 'verify' || existsSync(receipt)) {
      if (!matchesReceipt()) return changed;
    } else {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      const temporary = `${receipt}.${process.pid}.tmp`;
      const fd = openSync(temporary, 'wx', 0o644);
      try {
        try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(temporary, receipt); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!matchesReceipt()) return changed;
        }
        const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      } finally { unlinkSync(temporary); }
    }
    return { ok: true, value: { ...value, receipt } };
  } catch (error) { return { ok: false, error: { code: 'prepared-artifact-unavailable', message: String(error) } }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = preparedComponents(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 66;
}
