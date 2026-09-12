import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { boundedModelImage, boundedModelPayload, checkModelRequestBytes, imageRepresentationText, MODEL_PAYLOAD_LIMITS, modelPayloadFetch, payloadJsonBytes, prepareModelPayload } from "./model-payload.mjs";
import { IMAGE_PAYLOAD_APIS, patchImagePayload, patchImagePayloadCopies, patchOriginalImageCustody, patchRequestByteClassification } from "./patch-image-payload.mjs";
import { captureRequest, fixtureProvider } from "./image-payload-fixture.mjs";

const photon = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("@silvia-odwyer/photon-node");
function png(width = 1, height = 1) {
  const pixels = new Uint8Array(width * height * 4);
  let random = 42;
  for (let i = 0; i < pixels.length; i += 4) {
    for (let c = 0; c < 3; c++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; pixels[i + c] = random >>> 24; }
    pixels[i + 3] = 255;
  }
  const image = new photon.PhotonImage(pixels, width, height);
  try { return Buffer.from(image.get_bytes()); } finally { image.free(); }
}
const small = png(), large = png(1024, 1536);

test("large images keep useful dimensions, fit encoded bytes, and reuse conversion results", async () => {
  const original = Buffer.from(large);
  const first = await boundedModelImage(large, "image/png");
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await boundedModelImage(large.toString("base64"), "image/png");
  assert.equal(first, second);
  assert.ok(first.value.data.length <= MODEL_PAYLOAD_LIMITS.imageBytes);
  assert.ok(Math.max(first.value.metadata.width, first.value.metadata.height) >= 256);
  assert.equal(first.value.metadata.originalWidth, 1024);
  assert.match(imageRepresentationText(first.value.metadata), /sha256:/);
  assert.deepEqual(large, original);
});

test("conversion failures, invalid base64, and impossible budgets are explicit", async () => {
  assert.equal((await boundedModelImage("not base64", "image/png")).error.kind, "image_encoding");
  assert.equal((await boundedModelImage(Buffer.from("broken"), "image/png")).error.kind, "image_conversion");
  assert.equal((await boundedModelImage(small, "image/svg+xml")).error.kind, "image_format");
  assert.equal((await boundedModelImage(small, "image/png", 4)).error.kind, "image_budget");
});

test("all provider image representations are bounded without changing source or tool arguments", async () => {
  const data = large.toString("base64");
  const native = { type: "image", mimeType: "image/png", data };
  const imageUrl = `data:image/png;base64,${data}`;
  const blocks = [native, { type: "image", source: { type: "base64", media_type: "image/png", data } },
    { type: "image_url", image_url: { url: imageUrl, detail: "high" } }, { type: "image_url", imageUrl },
    { type: "input_image", image_url: imageUrl }, { inlineData: { data, mimeType: "image/png" } },
    { image: { format: "png", source: { bytes: new Uint8Array(large) } } }];
  const tool = { type: "tool_use", name: "keep", input: { content: [native] } };
  const payload = { messages: [{ role: "user", content: [...blocks, tool] }] };
  const result = await boundedModelPayload(payload);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.value.images.length, blocks.length);
  assert.equal(result.value.payload.messages[0].content.length, blocks.length * 2 + 1);
  assert.equal(result.value.payload.messages[0].content.at(-1), tool);
  assert.equal(native.data, data);
  assert.ok(result.value.images.every(image => image.encodedBytes <= MODEL_PAYLOAD_LIMITS.imageBytes));
  assert.equal(result.value.payload.messages[0].content[5].image_url.detail, "high");
});

test("Gemini function response metadata stays in its response object, not image-only parts", async () => {
  const payload = { contents: [{ parts: [{ functionResponse: { name: "read", response: { output: "saved" }, parts: [{ inlineData: { data: small.toString("base64"), mimeType: "image/png" } }] } }] }] };
  const result = await boundedModelPayload(payload);
  assert.equal(result.ok, true);
  const response = result.value.payload.contents[0].parts[0].functionResponse;
  assert.equal(response.parts.length, 1);
  assert.equal(response.response.output, "saved");
  assert.equal(response.response.imageRepresentations.length, 1);
  assert.deepEqual(Object.keys(response.parts[0]), ["inlineData"]);
});

test("images introduced by a payload hook are normalized, including checkpoint input", async () => {
  const payload = await prepareModelPayload({ input: [] }, {}, { onPayload: () => ({ input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${large.toString("base64")}` }] }] }) });
  assert.equal(payload.input[0].content[0].type, "input_text");
  assert.ok(payload.input[0].content[1].image_url.length < MODEL_PAYLOAD_LIMITS.imageBytes + 100);
  const error = await boundedModelPayload({ messages: [{ content: Array.from({ length: 193 }, () => ({ type: "image", data: small.toString("base64"), mimeType: "image/png" })) }] });
  assert.equal(error.error.kind, "image_budget");
});

test("request byte accounting measures UTF-8, not characters or tokens, and stops before fetch", async () => {
  assert.equal(payloadJsonBytes({ text: "🌍" }), Buffer.byteLength('{"text":"🌍"}'));
  assert.equal(checkModelRequestBytes(MODEL_PAYLOAD_LIMITS.requestBytes).ok, true);
  const over = checkModelRequestBytes(MODEL_PAYLOAD_LIMITS.requestBytes + 1);
  assert.equal(over.error.kind, "request_bytes");
  let called = false;
  const fetch = modelPayloadFetch(async () => { called = true; return new Response("ok"); });
  await assert.rejects(() => fetch("https://offline.invalid", { body: "x".repeat(MODEL_PAYLOAD_LIMITS.requestBytes + 1) }), /http-body.*byte budget/);
  assert.equal(called, false);
  const oversized = await boundedModelPayload({ messages: [{ content: "x".repeat(MODEL_PAYLOAD_LIMITS.requestBytes) }] });
  assert.equal(oversized.error.kind, "request_bytes");
});

test("all ten SDK and CLI patches match, are idempotent, and parse", () => {
  const ai = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
  const agent = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const chunks = join(agent, "bundle/chunks");
  const copies = [];
  for (const api of IMAGE_PAYLOAD_APIS) {
    const bundle = readdirSync(chunks).filter(name => name === `${api}.js` || name.startsWith(`${api}-`) && name.endsWith(".js"));
    assert.equal(bundle.length, 1);
    for (const path of [join(ai, `api/${api}.js`), join(chunks, bundle[0])]) {
      copies.push(path);
      const source = readFileSync(path, "utf8");
      const patched = patchImagePayload(source, "./model-payload.mjs", api);
      assert.equal(patchImagePayload(patched, "./model-payload.mjs", api), patched);
      const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: patched, encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  const ingress = [join(agent, "utils/image-process.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async function processImage("))];
  assert.equal(ingress.length, 2);
  for (const path of ingress) {
    copies.push(path);
    const patched = patchOriginalImageCustody(readFileSync(path, "utf8"));
    assert.equal(patchOriginalImageCustody(patched), patched);
    const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: patched, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  const overflow = [join(ai, "utils/overflow.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("function isContextOverflow("))];
  assert.equal(overflow.length, 2);
  copies.push(...overflow);
  const staging = mkdtempSync(join(tmpdir(), "pi-image-install-"));
  try {
    const modules = dirname(dirname(dirname(ai)));
    for (const path of new Set(copies)) {
      const destination = join(staging, relative(modules, path));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
    const paths = patchImagePayloadCopies(staging);
    const installed = paths.map(path => readFileSync(path, "utf8"));
    patchImagePayloadCopies(staging);
    assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), installed);
    for (const path of paths) {
      const syntax = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  assert.throws(() => patchImagePayload("upstream changed", "./helper.mjs", "anthropic"), /boundary changed/);
});

test("HTTP byte refusals do not trigger token compaction; genuine token overflow still does", () => {
  const path = fileURLToPath(new URL("./utils/overflow.js", import.meta.resolve("@earendil-works/pi-ai")));
  const source = patchRequestByteClassification(readFileSync(path, "utf8")).replaceAll("export function", "function");
  const classify = new Function(`${source}\nreturn isContextOverflow;`)();
  for (const errorMessage of ['413 {"error":{"type":"request_too_large"}}', "413 status code (no body)", "PI_MODEL_PAYLOAD_request_bytes: 21000000 bytes"]) {
    assert.equal(classify({ stopReason: "error", errorMessage }), false);
  }
  assert.equal(classify({ stopReason: "error", errorMessage: "prompt is too long: 210000 tokens > 200000 maximum" }), true);
});

test("supported image ingress retains original bytes instead of resizing persisted history", async () => {
  const path = fileURLToPath(new URL("./utils/image-process.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const source = patchOriginalImageCustody(readFileSync(path, "utf8")).replace(/^import .*;$/gm, "").replace("export async function", "async function");
  const processImage = new Function("Buffer", `${source}\nreturn processImage;`)(Buffer);
  const result = await processImage(large, "image/png", { autoResizeImages: true });
  assert.equal(result.ok, true);
  assert.equal(result.data, large.toString("base64"));
  assert.deepEqual(result.hints, []);
});

test("real Anthropic SDK and bundled serializers send bounded images and representation notes", async () => {
  const { getModel } = await import("@earendil-works/pi-ai/compat");
  const model = getModel("anthropic", "claude-fable-5-1");
  const agent = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const chunks = join(agent, "bundle/chunks");
  const paths = [fileURLToPath(new URL("./api/anthropic-messages.js", import.meta.resolve("@earendil-works/pi-ai"))), join(chunks, readdirSync(chunks).find(name => name.startsWith("anthropic-messages-") && name.endsWith(".js")))];
  for (const path of paths) {
    const provider = await fixtureProvider(path, true);
    try {
      const request = await captureRequest(provider, model, { messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: large.toString("base64") }] }] });
      assert.ok(request.bytes < MODEL_PAYLOAD_LIMITS.imageBytes + 3000);
      assert.match(request.payload.messages[0].content[0].text, /Model image representation/);
      assert.equal(request.payload.messages[0].content[1].source.media_type, "image/jpeg");
      let fetched = false;
      const unsupported = await provider.stream({ ...model, input: ["text"] }, { messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: small.toString("base64") }] }] }, { apiKey: "offline", fetch: async () => { fetched = true; throw new Error("Must not send"); } }).result();
      assert.equal(fetched, false);
      assert.match(unsupported.errorMessage, /image_support.*Select a vision model/);
    } finally { await provider.close(); }
  }
});
