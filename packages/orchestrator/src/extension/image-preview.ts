import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { boundedModelImage } from "../../../runtime/model-payload.mjs";

type ImageConverter = typeof boundedModelImage;
let converter: Promise<ImageConverter> | undefined;
async function runtimeConverter(): Promise<ImageConverter> {
  if (!converter) converter = (async () => {
    const manifest = findPackageJSON("@earendil-works/pi-ai", import.meta.url);
    if (!manifest) throw new Error("Pi AI runtime package is missing");
    const runtime = await import(pathToFileURL(join(dirname(manifest), "dist/model-payload.mjs")).href);
    return runtime.boundedModelImage as ImageConverter;
  })();
  return converter;
}

export async function imagePreview(bytes: Uint8Array, originalPath: string, convert?: ImageConverter) {
  try {
    const result = await (convert ?? await runtimeConverter())(bytes, "image/png");
    if (!result.ok) return { ok: false as const, error: `Image saved at ${originalPath}, but its model preview could not be encoded: ${result.error.message}. The original is intact. No generation retry was made.` };
    const { data, mimeType, metadata } = result.value;
    return {
      ok: true as const,
      image: { type: "image" as const, data, mimeType },
      metadata: { ...metadata, originalPath },
      text: `Model preview: ${metadata.width}x${metadata.height} ${mimeType}, ${metadata.encodedBytes} base64 bytes. Full original: ${originalPath}, ${metadata.originalWidth}x${metadata.originalHeight}, ${metadata.originalBytes} bytes, sha256:${metadata.originalSha256}.`,
    };
  } catch (error) {
    return { ok: false as const, error: `Image saved at ${originalPath}, but preview encoding failed: ${error instanceof Error ? error.message : String(error)}. The original is intact. No generation retry was made.` };
  }
}
