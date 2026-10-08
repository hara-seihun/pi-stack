import type { Database } from "bun:sqlite";
import { CONTEXT_RECORD_BYTES, openIndexedContext, type ContextReadResult } from "./indexed-context";

export interface RecentContextMessage { role: "user" | "assistant"; text: string }

export function readRecentContextMessages(db: Database, sessionId: string, limit: number,
  contentText: (content: unknown) => string): ContextReadResult<RecentContextMessage[]> {
  if (!Number.isSafeInteger(limit) || limit < 0)
    return { ok: false, error: { code: "invalid", detail: "Recent message limit must be a nonnegative safe integer" } };
  const opened = openIndexedContext(db, sessionId);
  if (!opened.ok) return opened;
  if (!opened.value) return { ok: true, value: [] };
  const context = opened.value;
  const window = context.withMessageReader((reader): ContextReadResult<RecentContextMessage[]> => {
    const found: RecentContextMessage[] = [];
    let bytes = 0;
    for (let index = context.messages.length - 1; index >= 0 && found.length < limit; index--) {
      const descriptor = context.messages[index];
      if (descriptor.role !== "user" && descriptor.role !== "assistant") continue;
      bytes += descriptor.bytes;
      if (bytes > CONTEXT_RECORD_BYTES) return { ok: false, error: { code: "oversized",
        detail: "Recent voice context exceeds the 8 MiB window budget", bytes, limit: CONTEXT_RECORD_BYTES } };
      const read = reader.readMessage(descriptor.index);
      if (!read.ok) return read;
      const text = contentText(read.value.content).trim();
      if (text) found.push({ role: descriptor.role, text });
    }
    return { ok: true, value: found.reverse() };
  });
  return window.ok ? window.value : window;
}
