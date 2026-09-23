import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const recovery = readFileSync(new URL("./codex-service-recovery.js", import.meta.url), "utf8");

export function patchCodexServiceRecovery(source) {
  const marker = "const codexPreOutputServiceFailures = new WeakMap();";
  if (source.includes(marker)) {
    const start = source.indexOf(marker);
    if (!source.slice(start).trimEnd().endsWith("return result;\n}")) throw new Error("Pinned Codex service recovery suffix changed; review replacement");
    return source.slice(0, start) + recovery;
  }
  const stream = /export const stream =|var stream=/gu;
  const mapper = /async function\*\s*mapCodexEvents\(/gu;
  if ([...source.matchAll(stream)].length !== 1 || [...source.matchAll(mapper)].length !== 1) throw new Error("Pinned Codex stream changed; review service recovery integration");
  return source.replace(stream, match => match.startsWith("export")
    ? "export const stream = streamWithCodexServiceRecovery; const streamAttempt ="
    : "var stream=streamWithCodexServiceRecovery,streamAttempt=")
    .replace(mapper, "async function* mapCodexEventsAttempt(") + `\n${recovery}`;
}

export function patchCodexServiceTransports(nodeModules) {
  const sdk = join(nodeModules, "@earendil-works/pi-ai/dist/api/openai-codex-responses.js");
  const chunks = join(nodeModules, "@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const bundles = readdirSync(chunks).filter(name => /^openai-codex-responses-[^.]+\.js$/u.test(name));
  if (bundles.length !== 1) throw new Error(`Expected one bundled Codex provider, found ${bundles.length}`);
  for (const path of [sdk, ...bundles.map(name => join(chunks, name))]) {
    const source = readFileSync(path, "utf8");
    const patched = patchCodexServiceRecovery(source);
    if (patched !== source) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-codex-service-recovery.mjs NODE_MODULES");
  patchCodexServiceTransports(resolve(process.argv[2]));
}
