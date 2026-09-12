import { createRequire, findPackageJSON } from "node:module";
import { expect, test } from "vitest";
import { imagePreview } from "../src/extension/image-preview.js";
import { boundedModelImage } from "../../runtime/model-payload.mjs";

const photon = createRequire(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!)("@silvia-odwyer/photon-node");

test("generated previews are bounded and identify the unchanged original", async () => {
  const pixels = new Uint8Array(1024 * 1536 * 4);
  let random = 42;
  for (let index = 0; index < pixels.length; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    pixels[index] = index % 4 === 3 ? 255 : random >>> 24;
  }
  const image = new photon.PhotonImage(pixels, 1024, 1536);
  let bytes: Buffer;
  try { bytes = Buffer.from(image.get_bytes()); } finally { image.free(); }
  const original = Buffer.from(bytes);
  const preview = await imagePreview(bytes, "/render/original.png", boundedModelImage);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.image.data.length).toBeLessThanOrEqual(384 * 1024);
  expect(preview.metadata).toMatchObject({ originalPath: "/render/original.png", originalWidth: 1024, originalHeight: 1536, originalBytes: bytes.length, changed: true });
  expect(preview.text).toContain(preview.metadata.originalSha256);
  expect(bytes.equals(original)).toBe(true);
});

test("preview failure names the saved original and does not imply generation failed", async () => {
  const preview = await imagePreview(Buffer.from("invalid PNG"), "/render/original.png", boundedModelImage);
  expect(preview.ok).toBe(false);
  if (preview.ok) return;
  expect(preview.error).toContain("Image saved at /render/original.png");
  expect(preview.error).toContain("original is intact");
  expect(preview.error).toContain("No generation retry");
});
