import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function patchCompactionErrors(source) {
  if (source.includes("Pi Stack compaction error result")) return source;
  for (const [variable, automatic] of [["result", false], ["extensionResult", true]]) {
    const pattern = new RegExp(`if\\s*\\(\\s*${variable}\\?\\.cancel\\s*\\)`, "g");
    const matches = [...source.matchAll(pattern)];
    // Other session operations also cancel. Restrict the match to the compaction method.
    const start = source.indexOf(automatic ? "async _runAutoCompaction(" : "async compact(customInstructions)");
    const match = matches.find(match => match.index > start);
    if (start < 0 || !match) throw new Error("Pinned Pi compaction result boundary changed");
    const insertion = `if (${variable}?.error) { /* Pi Stack compaction error result */ fromExtension = true; ${automatic ? "this.agent.abort();" : ""} throw new Error(${variable}.error); }\n`;
    source = source.slice(0, match.index) + insertion + source.slice(match.index);
  }
  return source;
}

export function patchCompactionErrorCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const chunks = join(base, "bundle/chunks");
  const paths = [join(base, "core/agent-session.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async _runAutoCompaction("))];
  if (paths.length !== 2) throw new Error(`Expected two Pi compaction consumers, found ${paths.length}`);
  for (const path of paths) {
    const source = readFileSync(path, "utf8"), patched = patchCompactionErrors(source);
    if (source !== patched) writeFileSync(path, patched);
  }
  const types = join(base, "core/extensions/types.d.ts");
  const declaration = readFileSync(types, "utf8");
  const marker = "export interface SessionBeforeCompactResult {";
  if (!declaration.includes(marker)) throw new Error("Pinned Pi compaction result type changed");
  if (!declaration.includes(`${marker}\n    error?: string;`)) writeFileSync(types, declaration.replace(marker, `${marker}\n    error?: string;`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-compaction-errors.mjs NODE_MODULES");
  patchCompactionErrorCopies(resolve(process.argv[2]));
}
