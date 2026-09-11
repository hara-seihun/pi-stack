import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function patchCompactionCut(source) {
  const starts = [...source.matchAll(/function findCutPoint\d*\(/gu)].map(match => match.index);
  if (!starts.length) throw new Error("Pinned Pi cut-point function not found");
  for (const start of starts.reverse()) {
    const end = source.indexOf("SUMMARIZATION_", start);
    if (end < 0) throw new Error("Pinned Pi cut-point boundary changed");
    const section = source.slice(start, end);
    if (section.includes("cutPoints.findLast(index=>index<=i)")) continue;
    const loop = /for\s*\(let (c\d*)\s*=\s*0;\s*\1\s*<\s*cutPoints\.length;\s*\1\+\+\)/u;
    if (!loop.test(section)) throw new Error("Pinned Pi cut-point search changed");
    const patched = section.replace(loop, "cutIndex = cutPoints.findLast(index=>index<=i) ?? cutPoints[0]; $&");
    source = source.slice(0, start) + patched + source.slice(end);
  }
  return source;
}

export function patchCompactionCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const sdk = join(base, "core/compaction/compaction.js");
  const chunks = join(base, "bundle/chunks");
  const paths = [sdk, ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => /function findCutPoint\d*\(/u.test(readFileSync(path, "utf8")))];
  if (paths.length < 2) throw new Error("Pinned Pi bundled cut-point function not found");
  for (const path of paths) {
    const source = readFileSync(path, "utf8"), patched = patchCompactionCut(source);
    if (source !== patched) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-compaction-cut.mjs NODE_MODULES");
  patchCompactionCopies(resolve(process.argv[2]));
}
