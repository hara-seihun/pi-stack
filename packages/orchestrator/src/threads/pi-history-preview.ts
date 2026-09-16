import type { ThreadHistory } from "./contracts.js";

const chunkSize = 24_000;
const previewSize = 4_000;
export function visibleEntry(entry: Record<string, unknown>): string {
  return JSON.stringify(entry, (key, value: unknown) => {
    if (/^(?:thinkingSignature|textSignature|thoughtSignature|signature|encrypted_content|encryptedContent)$/i.test(key)) return undefined;
    if (typeof value === "string" && /^data:image\//.test(value)) return "[image bytes omitted]";
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const block = value as Record<string, unknown>;
      if (block.type === "image" || block.type === "image_url") {
        return { type: block.type, mimeType: block.mimeType, image: "[image bytes omitted]" };
      }
      if (block.type === "thinking" || block.type === "redacted_thinking") return undefined;
    }
    return value;
  });
}

export function historyPreview(history: ThreadHistory, entryId?: string, offset = 0): Record<string, unknown> {
  return { entries: history.entries.map(entry => {
    const text = visibleEntry(entry);
    const start = entryId ? offset : 0, size = entryId ? chunkSize : previewSize;
    const end = Math.min(text.length, start + size);
    return { entryId: entry.id, type: entry.type, offset: start, text: text.slice(start, end),
      ...(end < text.length ? { nextOffset: end, truncated: true } : {}) };
  }), ...(history.nextCursor ? { nextCursor: history.nextCursor } : {}),
    note: "Image bytes and opaque signatures are omitted. For a truncated entry call thread_read with its entryId and nextOffset as offset. Offsets address this textual preview, not the native file." };
}
