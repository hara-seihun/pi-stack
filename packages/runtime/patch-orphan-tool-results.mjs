import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helper = readFileSync(new URL("./orphan-tool-results.mjs", import.meta.url), "utf8").replace("export function", "function");
const marker = "projectOrphanToolResults(normalizedMessages)";

export function patchOrphanToolResults(source) {
  if (source.includes(marker)) return source;
  const sdk = "downgradeUnsupportedImages(normalizedMessages, model)";
  const bundle = "downgradeUnsupportedImages(normalizedMessages,model)";
  const anchor = source.includes(sdk) ? sdk : bundle;
  if (source.split(anchor).length !== 2 || !source.includes("function transformMessages(")) throw new Error("Pinned provider history transform changed; cannot project orphan receipts");
  return helper + "\n" + source.replace(anchor, anchor.replace("normalizedMessages", marker));
}

export function patchProviders(nodeModules) {
  const sdk = join(nodeModules, "@earendil-works/pi-ai/dist/api/transform-messages.js");
  const chunks = join(nodeModules, "@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const bundled = readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name))
    .filter(path => readFileSync(path, "utf8").includes("function transformMessages("));
  if (bundled.length !== 2) throw new Error("Pinned bundled history-transform copies changed");
  for (const path of [sdk, ...bundled]) {
    const source = readFileSync(path, "utf8");
    const patched = patchOrphanToolResults(source);
    if (patched !== source) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-orphan-tool-results.mjs NODE_MODULES");
  patchProviders(resolve(process.argv[2]));
}
