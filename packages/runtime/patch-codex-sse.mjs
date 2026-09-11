import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function patchCodexSse(source) {
  const start = source.search(/async function\*\s*parseSSE\(/u);
  const end = source.indexOf("OPENAI_BETA_RESPONSES_WEBSOCKETS", start);
  if (start < 0 || end < 0) throw new Error("Pinned Codex SSE parser not found");
  const parser = source.slice(start, end);
  if (parser.includes('buffer.search(/\\r?\\n\\r?\\n/)')) return source;
  const boundaries = /buffer\.indexOf\((?:"\\n\\n"|`\n\n`)\)/gu;
  const advancement = /buffer\.slice\(idx\s*\+\s*2\)/gu;
  if ([...parser.matchAll(boundaries)].length !== 2 || [...parser.matchAll(advancement)].length !== 1) throw new Error("Pinned Codex SSE framing changed; review the owning parser");
  const patched = parser.replace(boundaries, 'buffer.search(/\\r?\\n\\r?\\n/)')
    .replace(advancement, 'buffer.slice(idx).replace(/^\\r?\\n\\r?\\n/, "")');
  return source.slice(0, start) + patched + source.slice(end);
}

export function patchCodexTransports(nodeModules) {
  const sdk = join(nodeModules, "@earendil-works/pi-ai/dist/api/openai-codex-responses.js");
  const chunks = join(nodeModules, "@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const bundles = readdirSync(chunks).filter(name => /^openai-codex-responses-[^.]+\.js$/u.test(name));
  if (bundles.length !== 1) throw new Error(`Expected one bundled Codex provider, found ${bundles.length}`);
  for (const path of [sdk, ...bundles.map(name => join(chunks, name))]) {
    const source = readFileSync(path, "utf8");
    const patched = patchCodexSse(source);
    if (patched !== source) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-codex-sse.mjs NODE_MODULES");
  patchCodexTransports(resolve(process.argv[2]));
}
