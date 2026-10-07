import type { ContextEntry, TranscriptItemBody } from "../../types";

export type MessageBodyResult = { ok: true; value: ContextEntry }
  | { ok: false; error: { code: "body-unavailable" | "invalid-body"; message: string } };

export function completeMessageEntry(entry: ContextEntry, body: TranscriptItemBody | undefined): MessageBodyResult {
  if (!body) return { ok: false, error: { code: "body-unavailable", message: "The complete message could not be loaded." } };
  if (body.kind !== entry.kind || body.kind === "toolCall" || typeof body.text !== "string")
    return { ok: false, error: { code: "invalid-body", message: "The complete message body is invalid." } };
  const { textTruncated, ...fields } = entry;
  return { ok: true, value: { ...fields, text: body.text, signature: `${entry.signature}:complete` } };
}

export async function loadMessageEntry(entry: ContextEntry, load: () => Promise<TranscriptItemBody | undefined>): Promise<MessageBodyResult> {
  if (!entry.textTruncated) return { ok: true, value: entry };
  try { return completeMessageEntry(entry, await load()); }
  catch (cause) { return { ok: false, error: { code: "body-unavailable", message: cause instanceof Error ? cause.message : "The complete message could not be loaded." } }; }
}
