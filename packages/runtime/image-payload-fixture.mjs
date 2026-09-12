import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchImagePayload } from "./patch-image-payload.mjs";
import { MODEL_PAYLOAD_LIMITS } from "./model-payload.mjs";

export async function fixtureProvider(sourcePath, patched) {
  const root = await mkdtemp(join(tmpdir(), "pi-image-provider-"));
  try {
    let source = await readFile(sourcePath, "utf8");
    if (!patched && source.includes("/* Pi Stack bounded model payload */")) throw new Error("Baseline fixture needs freshly installed, unpatched pinned dependencies");
    if (patched) source = patchImagePayload(source, new URL("./model-payload.mjs", import.meta.url).href, "anthropic-messages");
    const require = createRequire(pathToFileURL(sourcePath));
    source = source.replace(/(\bfrom\s*|\bimport\s*)(["'])([^"']+)\2/g, (match, prefix, quote, specifier) => {
      if (specifier.startsWith("node:") || specifier.startsWith("file:")) return match;
      const path = specifier.startsWith(".") ? resolve(dirname(sourcePath), specifier) : require.resolve(specifier);
      return `${prefix}${quote}${pathToFileURL(path).href}${quote}`;
    });
    const path = join(root, "provider.mjs");
    await writeFile(path, source);
    return { ...await import(pathToFileURL(path).href), close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function captureRequest(provider, model, context) {
  let wireBody;
  const result = await provider.stream(model, context, {
    apiKey: "sk-ant-oat-offline-fixture", maxTokens: 1024, maxRetries: 0,
    fetch: async (_url, init) => {
      assert.equal(typeof init.body, "string");
      wireBody = init.body;
      const events = [
        { type: "message_start", message: { id: "offline", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.ok(wireBody);
  return { bytes: Buffer.byteLength(wireBody, "utf8"), payload: JSON.parse(wireBody), diagnostics: result.diagnostics ?? [] };
}

export async function measureIncident(context) {
  const { getModel } = await import("@earendil-works/pi-ai/compat");
  const { convertToLlm } = await import(new URL("./core/messages.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const model = getModel("anthropic", "claude-fable-5-1");
  assert.ok(model, "Pinned incident model must exist");
  const original = JSON.stringify(context);
  const nativeImages = context.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image") : []);
  const input = { ...context, messages: convertToLlm(context.messages) };
  const sdk = fileURLToPath(new URL("./api/anthropic-messages.js", import.meta.resolve("@earendil-works/pi-ai")));
  const chunks = fileURLToPath(new URL("./bundle/chunks/", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const bundled = join(chunks, (await readdir(chunks)).find(name => name.startsWith("anthropic-messages-") && name.endsWith(".js")));
  const receipts = {};
  for (const [name, path, patched] of [["before", sdk, false], ["sdk", sdk, true], ["cli", bundled, true]]) {
    const provider = await fixtureProvider(path, patched);
    try {
      const request = await captureRequest(provider, model, input);
      const images = [];
      const visit = value => {
        if (value?.type === "image") images.push(value.source);
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      visit(request.payload);
      receipts[name] = { httpBodyBytes: request.bytes, images: images.length, imageBase64Bytes: images.reduce((sum, image) => sum + image.data.length, 0) };
      assert.equal(images.length, nativeImages.length);
      if (patched) {
        assert.ok(request.bytes <= MODEL_PAYLOAD_LIMITS.requestBytes);
        assert.ok(images.every(image => image.data.length <= MODEL_PAYLOAD_LIMITS.imageBytes));
        assert.equal(request.diagnostics.find(item => item.details?.stage === "http-body")?.details.bytes, request.bytes);
      }
    } finally { await provider.close(); }
  }
  assert.equal(JSON.stringify(context), original, "Canonical context must not be mutated");
  assert.deepEqual(receipts.sdk, receipts.cli);
  return { contextBytes: Buffer.byteLength(original), contextSha256: createHash("sha256").update(original).digest("hex"), messages: context.messages.length, limits: MODEL_PAYLOAD_LIMITS, ...receipts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node image-payload-fixture.mjs COPIED_CONTEXT_JSON");
  console.log(JSON.stringify(await measureIncident(JSON.parse(await readFile(process.argv[2], "utf8"))), null, 2));
}
