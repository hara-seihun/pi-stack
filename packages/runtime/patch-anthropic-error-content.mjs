import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "Anthropic error tool results require text";

export function patchAnthropicErrorContent(source) {
  const start = source.indexOf("function convertToolResult(msg)");
  const end = source.indexOf("function convertMessages(", start);
  if (start < 0 || end < 0) throw new Error("Pinned Anthropic tool-result conversion not found");
  const converter = source.slice(start, end);
  if (converter.includes(marker)) return source;
  const before = "convertContentBlocks(msg.content)";
  if (converter.split(before).length !== 2) throw new Error("Pinned Anthropic tool-result content changed; review its conversion");
  const after = `convertContentBlocks(msg.isError ? msg.content.map(block => block.type === "text" ? block : ({ type: "text", text: \`[\${block.type} attachment (\${block.mimeType ?? "unknown MIME type"}) preserved in native tool-result history; omitted because ${marker}.]\` })) : msg.content)`;
  return source.slice(0, start) + converter.replace(before, after) + source.slice(end);
}

export function patchAnthropicProviders(nodeModules) {
  const sdk = join(nodeModules, "@earendil-works/pi-ai/dist/api/anthropic-messages.js");
  for (const path of [sdk]) {
    const source = readFileSync(path, "utf8");
    const patched = patchAnthropicErrorContent(source);
    if (patched !== source) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-anthropic-error-content.mjs NODE_MODULES");
  patchAnthropicProviders(resolve(process.argv[2]));
}
