import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const helpers = stripTypeScriptTypes(readFileSync(new URL("../orchestrator/src/shared-custody.ts", import.meta.url), "utf8")).replace(/^export /gm, "");
const marker = "// PiStack shared filesystem custody\n";

function replace(source, before, after, count = 1) {
  const parts = source.split(before);
  if (parts.length !== count + 1) throw new Error(`Pinned Pi shared custody write boundary changed: ${before}`);
  return parts.join(after);
}

export function patchSharedCustody(source) {
  if (source.startsWith(marker + helpers)) return source;
  if (source.includes(marker)) throw new Error("Pi shared custody helper differs; rebuild the immutable dependency tree");
  if (source.includes("export class SessionManager")) {
    if (!source.includes("function writeSessionFileDurably")) throw new Error("Apply session durability before shared custody");
    source = source.replace(/\bmkdirSync\(/g, "custodyMkdirSync(").replace(/\bopenSync\(/g, "custodyOpenSync(");
  } else if (source.includes("export class FileSettingsStorage") || source.includes("export class FileAuthStorageBackend")) {
    if (source.includes("export class FileSettingsStorage")) source = replace(source, 'writeFileSync(path, next, "utf-8")', 'custodyReplaceFileSync(path, next)');
    source = source.replace(/\bmkdirSync\(/g, "custodyMkdirSync(").replace(/\bwriteFileSync\(/g, "custodyWriteFileSync(");
    source = replace(source, "lockfile.lockSync(path, { realpath: false })", "lockfile.lockSync(path, { realpath: false, fs: custodyLockFs })");
    if (source.includes("export class FileAuthStorageBackend")) {
      source = replace(source, "lockfile.lock(this.authPath, {", "lockfile.lock(this.authPath, {\n                    fs: custodyLockFs,");
    }
  } else throw new Error("Pinned Pi shared custody storage source not found");
  return marker + helpers + "\n" + source;
}

export function patchSharedCustodyCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const paths = ["session-manager", "settings-manager", "auth-storage"].map(name => join(base, `core/${name}.js`));
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    const patched = patchSharedCustody(source);
    if (patched !== source) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-shared-custody.mjs NODE_MODULES");
  patchSharedCustodyCopies(resolve(process.argv[2]));
}
