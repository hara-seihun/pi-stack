import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helper = readFileSync(new URL("./anthropic-tool-schema.js", import.meta.url), "utf8").replace("export function", "function");
const marker = "// PiStack Anthropic tool schemas";
const endMarker = "// End PiStack Anthropic tool schemas";
const before = `        const schema = parameters;
        const legacyInputSchema = {
            type: "object",
            properties: schema.properties ?? {},
            required: schema.required ?? [],
        };
        const inputSchema = strict === true
            ? {
                ...parameters,
                ...legacyInputSchema,
            }
            : legacyInputSchema;`;
const after = "        const inputSchema = anthropicToolSchema(parameters);";
const bundleBefore = 'schema=parameters,legacyInputSchema={type:"object",properties:schema.properties??{},required:schema.required??[]},inputSchema=strict===!0?{...parameters,...legacyInputSchema}:legacyInputSchema';
const bundleAfter = "inputSchema=anthropicToolSchema(parameters)";

export function patchAnthropicToolSchema(source) {
  const start = source.indexOf("function convertTools(");
  const end = source.indexOf("function mapStopReason(", start);
  if (start < 0 || end < 0) throw new Error("Pinned Anthropic tool-schema conversion not found");
  const converter = source.slice(start, end);
  if (converter.includes(after) || converter.includes(bundleAfter)) {
    const helperStart = source.indexOf(marker);
    const helperEnd = source.indexOf(endMarker, helperStart);
    if (helperStart < 0 || helperEnd < 0) throw new Error("Patched Anthropic tool-schema helper not found");
    return source.slice(0, helperStart) + `${marker}\n${helper}${endMarker}` + source.slice(helperEnd + endMarker.length);
  }
  const anchor = converter.includes(before) ? [before, after] : [bundleBefore, bundleAfter];
  if (converter.split(anchor[0]).length !== 2) throw new Error("Pinned Anthropic tool schema changed; review its conversion");
  return source.slice(0, start) + `${marker}\n${helper}${endMarker}\n` + converter.replace(anchor[0], anchor[1]) + source.slice(end);
}

export function patchAnthropicToolSchemas(nodeModules) {
  const sdk = join(nodeModules, "@earendil-works/pi-ai/dist/api/anthropic-messages.js");
  const chunks = join(nodeModules, "@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const bundled = readdirSync(chunks).filter(name => /^anthropic-messages-.*\.js$/.test(name));
  if (bundled.length !== 1) throw new Error("Pinned Anthropic bundle must have one messages provider");
  for (const path of [sdk, join(chunks, bundled[0])]) {
    const source = readFileSync(path, "utf8");
    const patched = patchAnthropicToolSchema(source);
    if (patched !== source) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-anthropic-tool-schema.mjs NODE_MODULES");
  patchAnthropicToolSchemas(resolve(process.argv[2]));
}
