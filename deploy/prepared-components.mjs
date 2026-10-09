import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const components = ['runtime', 'orchestrator', 'remote', 'tools'];
function digest(directory) {
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
  return hash.digest('hex');
}
export function preparedComponents(releases, commit, action) {
  try {
    if (!/^[a-f0-9]{40}$/.test(commit) || !['record', 'verify'].includes(action)) return { ok: false, error: { code: 'prepared-input-invalid' } };
    const artifacts = components.map(component => {
      const path = resolve(releases, component, commit);
      if (readFileSync(join(path, '.pi-stack-commit'), 'utf8').trim() !== commit) throw new Error(`Prepared ${component} source mismatch`);
      return { component, path, sha256: digest(path) };
    });
    const directory = resolve(releases, '.prepared');
    const receipt = join(directory, `${commit}.json`);
    const value = { protocol: 'prepared-components-v1', commit, artifacts };
    if (action === 'verify') {
      if (JSON.stringify(JSON.parse(readFileSync(receipt, 'utf8'))) !== JSON.stringify(value)) return { ok: false, error: { code: 'prepared-artifact-changed', receipt } };
    } else {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      const temporary = `${receipt}.${process.pid}.tmp`;
      const fd = openSync(temporary, 'wx', 0o644);
      try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, receipt);
      const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    }
    return { ok: true, value: { ...value, receipt } };
  } catch (error) { return { ok: false, error: { code: 'prepared-artifact-unavailable', message: String(error) } }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = preparedComponents(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 66;
}
