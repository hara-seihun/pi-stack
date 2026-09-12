import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE_PAYLOAD_APIS = ["anthropic-messages", "azure-openai-responses", "bedrock-converse-stream", "google-generative-ai", "google-vertex", "mistral-conversations", "openai-codex-responses", "openai-completions", "openai-responses", "pi-messages"];
const marker = "/* Pi Stack bounded model payload */";
export function patchImagePayload(source, helperImport, api) {
  if (source.includes(marker)) return source;
  const hook = /await options\?\.onPayload\?\.\((\w+),\s*model\)/g;
  if ([...source.matchAll(hook)].length !== 1) throw new Error(`Pinned Pi ${api} payload boundary changed`);
  source = source.replace(hook, "await prepareModelPayload($1,model,options,output)");
  const stream = /\bstream\s*=\s*\(model,\s*context,\s*options(?:\s*=\s*\{\})?\)\s*=>\s*\{/.exec(source);
  const boundary = stream && /\btry\s*\{/.exec(source.slice(stream.index));
  if (!stream || !boundary) throw new Error(`Pinned Pi ${api} stream boundary changed`);
  const insertion = stream.index + boundary.index + boundary[0].length;
  let entry = "assertModelImageSupport(context,model);";
  if (!["google-generative-ai", "google-vertex", "bedrock-converse-stream"].includes(api)) {
    if ([...source.matchAll(/options\?\.fetch/g)].length !== 1) throw new Error(`Pinned Pi ${api} fetch boundary changed`);
    entry += "options={...options,fetch:modelPayloadFetch(options?.fetch,output)};";
  }
  source = source.slice(0, insertion) + entry + source.slice(insertion);
  if (api === "openai-codex-responses") {
    const send = /socket\.send\(JSON\.stringify\(\{\s*type:\s*"response\.create",\s*\.\.\.requestBody\s*\}\)\)/g;
    if ([...source.matchAll(send)].length !== 1) throw new Error("Pinned Pi Codex WebSocket send boundary changed");
    source = source.replace(send, 'socket.send(modelPayloadJson({type:"response.create",...requestBody},"websocket-frame",output))');
  }
  return `${marker}\nimport { prepareModelPayload, modelPayloadFetch, modelPayloadJson, assertModelImageSupport } from ${JSON.stringify(helperImport)};\n${source}`;
}

export function patchOriginalImageCustody(source) {
  const custodyMarker = "/* Pi Stack original image custody */";
  if (source.includes(custodyMarker)) return source;
  const boundary = /async function processImage\(bytes,\s*mimeType,\s*options\)\s*\{/g;
  if ([...source.matchAll(boundary)].length !== 1) throw new Error("Pinned Pi image ingress boundary changed");
  return source.replace(boundary, match => `${match}${custodyMarker}\nconst originalMimeType = normalizeSupportedImageMimeType(mimeType);\nif (originalMimeType) return { ok: true, data: Buffer.from(bytes).toString("base64"), mimeType: originalMimeType, hints: [] };\n`);
}

export function patchRequestByteClassification(source) {
  const byteMarker = "/* Pi Stack request bytes are not tokens */";
  if (source.includes(byteMarker)) return source;
  const boundary = /function isContextOverflow\((\w+),\s*contextWindow\)\s*\{/g;
  if ([...source.matchAll(boundary)].length !== 1) throw new Error("Pinned Pi context overflow boundary changed");
  return source.replace(boundary, (match, message) => `${match}${byteMarker}\nif (${message}.stopReason === "error" && /PI_MODEL_PAYLOAD_|request_too_large|^413(?:\\s|$)/i.test(${message}.errorMessage ?? "")) return false;\n`);
}

export function patchImagePayloadCopies(nodeModules) {
  const ai = join(nodeModules, "@earendil-works/pi-ai/dist");
  const chunks = join(nodeModules, "@earendil-works/pi-coding-agent/dist/bundle/chunks");
  const helper = join(ai, "model-payload.mjs");
  const changes = [];
  for (const api of IMAGE_PAYLOAD_APIS) {
    const bundled = readdirSync(chunks).filter(name => name === `${api}.js` || name.startsWith(`${api}-`) && name.endsWith(".js"));
    if (bundled.length !== 1) throw new Error(`Expected one bundled ${api} provider, found ${bundled.length}`);
    for (const path of [join(ai, `api/${api}.js`), join(chunks, bundled[0])]) {
      const source = readFileSync(path, "utf8");
      const specifier = relative(dirname(path), helper).split("\\").join("/");
      changes.push({ path, source, patched: patchImagePayload(source, specifier.startsWith(".") ? specifier : `./${specifier}`, api) });
    }
  }
  const ingress = [join(nodeModules, "@earendil-works/pi-coding-agent/dist/utils/image-process.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async function processImage("))];
  if (ingress.length !== 2) throw new Error(`Expected two image ingress consumers, found ${ingress.length}`);
  for (const path of ingress) {
    const source = readFileSync(path, "utf8");
    changes.push({ path, source, patched: patchOriginalImageCustody(source) });
  }
  const overflow = [join(ai, "utils/overflow.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("function isContextOverflow("))];
  if (overflow.length !== 2) throw new Error(`Expected two overflow classifiers, found ${overflow.length}`);
  for (const path of overflow) {
    const previous = changes.find(change => change.path === path);
    const source = previous?.patched ?? readFileSync(path, "utf8");
    if (previous) previous.patched = patchRequestByteClassification(source);
    else changes.push({ path, source, patched: patchRequestByteClassification(source) });
  }
  copyFileSync(new URL("./model-payload.mjs", import.meta.url), helper);
  for (const { path, source, patched } of changes) if (source !== patched) writeFileSync(path, patched);
  return changes.map(change => change.path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-image-payload.mjs NODE_MODULES");
  patchImagePayloadCopies(resolve(process.argv[2]));
}
