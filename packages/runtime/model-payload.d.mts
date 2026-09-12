export interface ModelImageMetadata {
  originalWidth: number;
  originalHeight: number;
  originalMimeType: string;
  originalBytes: number;
  originalSha256: string;
  width: number;
  height: number;
  mimeType: string;
  encodedBytes: number;
  changed: boolean;
  alphaFlattened?: boolean;
  firstFrameOnly?: boolean;
}
export type ModelImageResult =
  | { ok: true; value: { data: string; mimeType: string; metadata: ModelImageMetadata } }
  | { ok: false; error: { kind: "image_budget" | "image_format" | "image_encoding" | "image_conversion"; message: string } };
export function boundedModelImage(input: string | Uint8Array, mimeType: string, maxBytes?: number): Promise<ModelImageResult>;
export function imageRepresentationText(metadata: ModelImageMetadata): string;
