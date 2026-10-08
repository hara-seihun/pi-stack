import type { ThreadApi } from "pi-orchestrator/api";
import type { SourceResult } from "./source-transcripts";

export interface RecentHistoryMessage { role: "user" | "assistant"; text: string }

export async function readRecentHistoryMessages(inspect: ThreadApi["inspect"], sessionId: string, limit: number,
  contentText: (content: unknown) => string): Promise<SourceResult<RecentHistoryMessage[]>> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64)
    return { ok: false, error: { code: "invalid_request", message: "Recent history limit must be between 0 and 64" } };
  if (!limit) return { ok: true, value: [] };
  const found: RecentHistoryMessage[] = [];
  let before = Number.MAX_SAFE_INTEGER;
  let revision: string | undefined;
  // Voice needs recent conversation, not an unbounded scan through tool-only history.
  for (let pageIndex = 0; pageIndex < 4 && found.length < limit; pageIndex++) {
    const inspected = await inspect(sessionId, { contextRecords: { before, limit: 32, ...(revision ? { revision } : {}) } });
    if (!inspected.ok) return inspected;
    const page = inspected.value.contextRecords;
    if (!page) return { ok: false, error: { code: "invalid_source", message: "The thread owner did not return native history" } };
    revision = page.source.revision;
    for (const record of [...page.records].reverse()) {
      const message = record.message;
      if (message?.role !== "user" && message?.role !== "assistant") continue;
      const text = contentText(message.content).trim();
      if (text) found.push({ role: message.role, text });
      if (found.length === limit) break;
    }
    const first = page.records[0]?.index;
    if (first === undefined || first === 0) break;
    before = first;
  }
  return { ok: true, value: found.reverse() };
}
