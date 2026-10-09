import { readFileSync, lstatSync, readlinkSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export function isLegacyCapturePackage(configuredRoot, legacy, target, legacySource) {
  if (configuredRoot !== legacy && configuredRoot !== target) return false;
  try {
    return readFileSync(join(legacy, '.pi-stack-commit'), 'utf8').trim() === legacySource
      && readFileSync(join(configuredRoot, '.pi-stack-commit'), 'utf8').trim() === legacySource
      && realpathSync(join(configuredRoot, 'server/context-mirror.ts')) === join(legacy, 'server/context-mirror.ts')
      && realpathSync(join(configuredRoot, 'package.json')) === join(legacy, 'package.json');
  } catch { return false; }
}

function installCopy(source, path, transform = bytes => bytes) {
  const bytes = transform(readFileSync(source));
  try {
    const previous = lstatSync(path);
    if (previous.isSymbolicLink()) {
      if (readlinkSync(path) !== source) throw new Error('Maintenance package path has unrelated link custody');
    } else if (!previous.isFile() || !readFileSync(path).equals(bytes)) throw new Error('Maintenance copied module has unrelated source custody');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o644, flush: true }); renameSync(temporary, path);
  return createHash('sha256').update(bytes).digest('hex');
}

// The capture extension has two declared names: immutable old source and its
// selected maintenance alias. Both retain exactly one old dependency graph.
export function stageLegacyRemoteIdentity(legacy, target, legacySource) {
  if (!/^[0-9a-f]{40}$/.test(legacySource) || !legacy.startsWith('/') || !target.startsWith('/')
    || realpathSync(legacy) !== resolve(legacy) || realpathSync(target) !== resolve(target)
    || readFileSync(join(legacy, '.pi-stack-commit'), 'utf8').trim() !== legacySource
    || readFileSync(join(target, '.pi-stack-commit'), 'utf8').trim() !== legacySource) throw new Error('Maintenance package identity is not bound to the selected immutable source');
  const mainSource = join(legacy, 'server/main.ts'), serverSource = join(legacy, 'server/server.ts');
  const main = readFileSync(mainSource, 'utf8'), server = readFileSync(serverSource, 'utf8');
  const packageDeclaration = 'const PACKAGE_ROOT = realpathSync(join(import.meta.dir, ".."));';
  const comparison = 'if (configuredRoot !== PACKAGE_ROOT) {';
  if (!main.includes('await import("./server")') || server.split(packageDeclaration).length !== 2
    || server.split(comparison).length !== 2) throw new Error('Selected old Remote has no supported local package identity seam');
  const helper = fileURLToPath(import.meta.url);
  const patched = `import { isLegacyCapturePackage } from ${JSON.stringify(helper)};\n` + server
    .replace(packageDeclaration, `const PACKAGE_ROOT = realpathSync(${JSON.stringify(legacy)});`)
    .replace(comparison, `if (!isLegacyCapturePackage(configuredRoot, PACKAGE_ROOT, ${JSON.stringify(target)}, ${JSON.stringify(legacySource)})) {`);
  if (!isLegacyCapturePackage(legacy, legacy, target, legacySource) || !isLegacyCapturePackage(target, legacy, target, legacySource)) throw new Error('Maintenance alias does not retain the immutable old capture package');
  const mainPath = join(target, 'server/main-legacy.ts'), serverPath = join(target, 'server/server.ts');
  return { mainPath, serverPath, legacySource, packageRoot: legacy, capturePackageRoots: [legacy, target],
    hashes: { main: installCopy(mainSource, mainPath), server: installCopy(serverSource, serverPath, () => Buffer.from(patched)) } };
}
