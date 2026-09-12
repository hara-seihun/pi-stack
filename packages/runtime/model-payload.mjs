import { createHash } from "node:crypto";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

export const MODEL_PAYLOAD_LIMITS = Object.freeze({
  requestBytes: 20 * 1024 * 1024,
  imageBytes: 384 * 1024,
  totalImageBytes: 12 * 1024 * 1024,
  minImageBytes: 64 * 1024,
  maxDimension: 1568,
  minDimension: 256,
  cacheBytes: 32 * 1024 * 1024,
});
const success = value => ({ ok: true, value });
const failure = (kind, message, details = {}) => ({ ok: false, error: { kind, message, ...details } });
const hash = data => createHash("sha256").update(data).digest("hex");
const cache = new Map();
let cacheBytes = 0;
let codec;
function loadCodec() {
  if (!codec) {
    const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
    if (!manifest) throw new Error("Pi coding-agent image codec dependency is missing");
    codec = Promise.all([
      Promise.resolve().then(() => createRequire(manifest)("@silvia-odwyer/photon-node")),
      import(new URL("./dist/utils/exif-orientation.js", pathToFileURL(manifest)).href),
    ]).then(([photon, { applyExifOrientation }]) => ({ photon, applyExifOrientation }));
  }
  return codec;
}

export function imageRepresentationText(metadata) {
  return `[Model image representation: ${metadata.width}x${metadata.height} ${metadata.mimeType}, ${metadata.encodedBytes} base64 bytes; original ${metadata.originalWidth}x${metadata.originalHeight} ${metadata.originalMimeType}, ${metadata.originalBytes} bytes, sha256:${metadata.originalSha256}. ${metadata.changed ? "Preview only; full original remains at its source." : "Original encoding retained."}${metadata.alphaFlattened ? " Transparency composited on white." : ""}${metadata.firstFrameOnly ? " Static first-frame representation of GIF." : ""}]`;
}

async function convertImage(bytes, mimeType, maxBytes) {
  let image;
  try {
    const { photon, applyExifOrientation } = await loadCodec();
    const raw = photon.PhotonImage.new_from_byteslice(bytes);
    image = applyExifOrientation(photon, raw, bytes);
    if (image !== raw) raw.free();
    const originalWidth = image.get_width(), originalHeight = image.get_height();
    const metadata = { originalWidth, originalHeight, originalMimeType: mimeType, originalBytes: bytes.length, originalSha256: hash(bytes) };
    const originalData = bytes.toString("base64");
    if (image === raw && Math.max(originalWidth, originalHeight) <= MODEL_PAYLOAD_LIMITS.maxDimension && originalData.length <= maxBytes) {
      return success({ data: originalData, mimeType, metadata: { ...metadata, width: originalWidth, height: originalHeight, mimeType, encodedBytes: originalData.length, changed: false } });
    }
    let scale = Math.min(1, MODEL_PAYLOAD_LIMITS.maxDimension / Math.max(originalWidth, originalHeight));
    while (true) {
      const width = Math.max(1, Math.round(originalWidth * scale)), height = Math.max(1, Math.round(originalHeight * scale));
      const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
      let opaque;
      try {
        const encode = (buffer, outputMimeType, alphaFlattened = false) => {
          const data = Buffer.from(buffer).toString("base64");
          return data.length <= maxBytes ? success({ data, mimeType: outputMimeType, metadata: { ...metadata, width, height, mimeType: outputMimeType, encodedBytes: data.length, changed: true, alphaFlattened, firstFrameOnly: mimeType === "image/gif" } }) : undefined;
        };
        const png = encode(resized.get_bytes(), "image/png");
        if (png) return png;
        const pixels = resized.get_raw_pixels();
        let alphaFlattened = false;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3];
          if (alpha === 255) continue;
          alphaFlattened = true;
          for (let c = 0; c < 3; c++) pixels[i + c] = Math.round((pixels[i + c] * alpha + 255 * (255 - alpha)) / 255);
          pixels[i + 3] = 255;
        }
        opaque = new photon.PhotonImage(pixels, width, height);
        for (const quality of [85, 70, 55]) {
          const jpeg = encode(opaque.get_bytes_jpeg(quality), "image/jpeg", alphaFlattened);
          if (jpeg) return jpeg;
        }
      } finally { opaque?.free(); resized.free(); }
      if (Math.max(width, height) <= MODEL_PAYLOAD_LIMITS.minDimension) break;
      scale = Math.max(MODEL_PAYLOAD_LIMITS.minDimension / Math.max(originalWidth, originalHeight), scale * 0.75);
    }
    return failure("image_budget", `Image cannot fit ${maxBytes} base64 bytes without reducing its longest edge below ${MODEL_PAYLOAD_LIMITS.minDimension}px`, metadata);
  } catch (error) {
    return failure("image_conversion", `Image conversion failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { image?.free(); }
}

export async function boundedModelImage(input, mimeType, maxBytes = MODEL_PAYLOAD_LIMITS.imageBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MODEL_PAYLOAD_LIMITS.minImageBytes || maxBytes > MODEL_PAYLOAD_LIMITS.imageBytes) return failure("image_budget", `Image budget must be ${MODEL_PAYLOAD_LIMITS.minImageBytes}..${MODEL_PAYLOAD_LIMITS.imageBytes} base64 bytes`);
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) return failure("image_format", `Unsupported model image MIME type: ${mimeType}`);
  if (typeof input === "string" && (!input.length || input.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input))) return failure("image_encoding", "Model image is not valid padded base64");
  if (typeof input !== "string" && !(input instanceof Uint8Array)) return failure("image_encoding", "Model image must contain base64 text or image bytes");
  const bytes = typeof input === "string" ? Buffer.from(input, "base64") : Buffer.from(input);
  const key = `${hash(bytes)}:${mimeType}:${maxBytes}`;
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached.promise; }
  const entry = { promise: convertImage(bytes, mimeType, maxBytes), bytes: 0 };
  cache.set(key, entry);
  const result = await entry.promise;
  if (!result.ok) { if (cache.get(key) === entry) cache.delete(key); return result; }
  entry.bytes = result.value.data.length;
  if (cache.get(key) === entry) cacheBytes += entry.bytes;
  while (cacheBytes > MODEL_PAYLOAD_LIMITS.cacheBytes || cache.size > 128) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey); cacheBytes -= old.bytes;
  }
  return result;
}

function imageSlot(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "image" && typeof node.data === "string") return { data: node.data, mimeType: node.mimeType, replace: image => ({ ...node, data: image.data, mimeType: image.mimeType }), text: text => ({ type: "text", text }) };
  if (node.type === "image" && node.source?.type === "base64") return { data: node.source.data, mimeType: node.source.media_type, replace: image => ({ ...node, source: { ...node.source, data: image.data, media_type: image.mimeType } }), text: text => ({ type: "text", text }) };
  if (node.inlineData?.mimeType?.startsWith("image/")) return { data: node.inlineData.data, mimeType: node.inlineData.mimeType, replace: image => ({ ...node, inlineData: { ...node.inlineData, data: image.data, mimeType: image.mimeType } }), text: text => ({ text }) };
  if (node.image?.source?.bytes) return { data: node.image.source.bytes, mimeType: `image/${node.image.format === "jpg" ? "jpeg" : node.image.format}`, replace: image => ({ ...node, image: { ...node.image, format: image.mimeType.slice(6), source: { bytes: Buffer.from(image.data, "base64") } } }), text: text => ({ text }) };
  const urlKey = "imageUrl" in node ? "imageUrl" : "image_url";
  const url = typeof node[urlKey] === "string" ? node[urlKey] : node[urlKey]?.url;
  if (["image_url", "input_image"].includes(node.type) && typeof url === "string" && url.startsWith("data:")) {
    const match = /^data:(image\/[^;,]+);base64,(.*)$/s.exec(url);
    if (!match) return { data: "", mimeType: "invalid data URL" };
    return { data: match[2], mimeType: match[1], replace: image => ({ ...node, [urlKey]: typeof node[urlKey] === "string" ? `data:${image.mimeType};base64,${image.data}` : { ...node[urlKey], url: `data:${image.mimeType};base64,${image.data}` } }), text: text => ({ type: node.type === "input_image" ? "input_text" : "text", text }) };
  }
}
const childKeys = new Set(["messages", "content", "contents", "parts", "input", "output", "context", "functionResponse"]);
function collectSlots(node, slots = []) {
  if (Array.isArray(node)) { for (const child of node) collectSlots(child, slots); return slots; }
  if (!node || typeof node !== "object") return slots;
  const slot = imageSlot(node);
  if (slot) { slots.push({ node, slot }); return slots; }
  if (["tool_use", "toolCall", "function_call"].includes(node.type)) return slots;
  for (const [key, value] of Object.entries(node)) if (childKeys.has(key)) collectSlots(value, slots);
  return slots;
}

export function payloadJsonBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value?.type === "Buffer" && Array.isArray(value.data) ? Buffer.from(value.data).toString("base64") : value), "utf8");
}
export function checkModelRequestBytes(bytes, stage = "provider-payload-json") {
  return bytes <= MODEL_PAYLOAD_LIMITS.requestBytes ? success({ bytes, stage, limit: MODEL_PAYLOAD_LIMITS.requestBytes }) : failure("request_bytes", `Model request ${stage} is ${bytes} bytes; limit ${MODEL_PAYLOAD_LIMITS.requestBytes} bytes. This is a byte budget, not a token/context overflow. No images or history were dropped. Reduce the selected context or use explicit compaction.`, { bytes, stage, limit: MODEL_PAYLOAD_LIMITS.requestBytes });
}

export async function boundedModelPayload(payload) {
  const slots = collectSlots(payload);
  const maxBytes = Math.min(MODEL_PAYLOAD_LIMITS.imageBytes, Math.floor(MODEL_PAYLOAD_LIMITS.totalImageBytes / Math.max(1, slots.length)));
  if (maxBytes < MODEL_PAYLOAD_LIMITS.minImageBytes) return failure("image_budget", `${slots.length} images exceed the aggregate model image budget. Select fewer images explicitly; none were dropped.`);
  const replacements = new Map();
  for (const { node, slot } of slots) {
    const result = await boundedModelImage(slot.data, slot.mimeType, maxBytes);
    if (!result.ok) return result;
    replacements.set(node, { image: slot.replace(result.value), text: slot.text(imageRepresentationText(result.value.metadata)), metadata: result.value.metadata });
  }
  function rewrite(node, functionParts = false) {
    if (Array.isArray(node)) return node.flatMap(child => {
      const replacement = replacements.get(child);
      return replacement ? functionParts ? [replacement.image] : [replacement.text, replacement.image] : [rewrite(child)];
    });
    if (!node || typeof node !== "object") return node;
    if (["tool_use", "toolCall", "function_call"].includes(node.type)) return node;
    const result = { ...node };
    for (const [key, value] of Object.entries(node)) if (childKeys.has(key)) {
      if (key === "functionResponse" && value?.parts) {
        const representations = value.parts.flatMap(part => replacements.has(part) ? [replacements.get(part).metadata] : []);
        result[key] = { ...value, parts: rewrite(value.parts, true), response: { ...value.response, ...(representations.length ? { imageRepresentations: representations } : {}) } };
      } else result[key] = rewrite(value);
    }
    return result;
  }
  const value = slots.length ? rewrite(payload) : payload;
  const budget = checkModelRequestBytes(payloadJsonBytes(value));
  return budget.ok ? success({ payload: value, measurement: budget.value, images: [...replacements.values()].map(item => item.metadata) }) : budget;
}

// Pi provider hooks use exceptions to terminate their existing error event streams.
export function assertModelImageSupport(context, model) {
  if (Array.isArray(model.input) && !model.input.includes("image") && collectSlots(context).length) throw new Error(`PI_MODEL_PAYLOAD_image_support: ${model.id} does not accept images. Select a vision model; images were not silently removed.`);
}
function recordMeasurement(output, details) {
  if (output) output.diagnostics = [...(output.diagnostics ?? []), { type: "pi_model_payload", timestamp: Date.now(), details }];
}
export async function prepareModelPayload(payload, model, options, output) {
  const replacement = await options?.onPayload?.(payload, model);
  const selected = replacement === undefined ? payload : replacement;
  assertModelImageSupport(selected, model);
  const result = await boundedModelPayload(selected);
  if (!result.ok) throw new Error(`PI_MODEL_PAYLOAD_${result.error.kind}: ${result.error.message}`);
  recordMeasurement(output, { ...result.value.measurement, images: result.value.images });
  return result.value.payload;
}

export function modelPayloadJson(payload, stage, output) {
  const json = JSON.stringify(payload);
  const result = checkModelRequestBytes(Buffer.byteLength(json, "utf8"), stage);
  if (!result.ok) throw new Error(`PI_MODEL_PAYLOAD_${result.error.kind}: ${result.error.message}`);
  recordMeasurement(output, result.value);
  return json;
}

export function modelPayloadFetch(fetch = globalThis.fetch, output) {
  return async (input, init) => {
    let bytes;
    const body = init?.body;
    if (typeof body === "string") bytes = Buffer.byteLength(body, "utf8");
    else if (body instanceof Uint8Array) bytes = body.byteLength;
    else if (body instanceof ArrayBuffer) bytes = body.byteLength;
    else if (input instanceof Request && body === undefined) bytes = (await input.clone().arrayBuffer()).byteLength;
    else if (body != null) throw new Error("PI_MODEL_PAYLOAD_body_type: Cannot measure this model request body before transmission");
    if (bytes !== undefined) {
      const result = checkModelRequestBytes(bytes, "http-body");
      if (!result.ok) throw new Error(`PI_MODEL_PAYLOAD_${result.error.kind}: ${result.error.message}`);
      recordMeasurement(output, result.value);
    }
    return fetch(input, init);
  };
}
