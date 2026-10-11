import type { TranscriptItemHead } from "../../../../server/protocol";
import { validateTranscriptHead } from "../../../../shared/state-validation";
import { monoMessage } from "../../app/mono";
import { SILENT_TURN_TEXT } from "pi-orchestrator/manager-turn";
import { EARLIER_PAGE_SIZE, fetchTranscriptPage, hasEarlier, mergeHeads, type TranscriptFetch, type TranscriptWindow } from "./transcript-store";

export function conversationHead(head: TranscriptItemHead, mono: boolean): boolean {
  if (mono && head.monoVisibility === "hidden") return false;
  if (head.kind === "user") return monoMessage(head);
  return head.kind === "assistant" && !!head.text.trim() && head.text !== SILENT_TURN_TEXT;
}

export function conversationCount(window: TranscriptWindow, mono: boolean): number {
  return window.items.filter(head => conversationHead(head, mono)).length;
}

export type VisibleHistoryResult =
  | { ok: true; window: TranscriptWindow; reset: boolean }
  | { ok: false; window: TranscriptWindow; reset: boolean; error: { kind: "cancelled" } | { kind: "unavailable"; message: string } };

export async function loadVisibleEarlier(sessionId: string, initial: TranscriptWindow, options: {
  mono: boolean;
  budget: number;
  signal: AbortSignal;
  fetcher?: TranscriptFetch;
  onPage(window: TranscriptWindow, reset: boolean): void;
}): Promise<VisibleHistoryResult> {
  let window = initial;
  let reset = false;
  let remaining = options.budget;
  const visible = (head: TranscriptItemHead) => conversationHead(head, options.mono);
  if (!Number.isSafeInteger(remaining) || remaining < 0) return { ok: false, window, reset, error: { kind: "unavailable", message: "Invalid conversation page budget" } };
  try {
    while (remaining > 0 && hasEarlier(window)) {
      if (options.signal.aborted) return { ok: false, window, reset, error: { kind: "cancelled" } };
      const before = window.items[0].seq;
      const result = await fetchTranscriptPage(sessionId, { generation: window.generation, before, limit: EARLIER_PAGE_SIZE }, options.fetcher, options.signal);
      if (options.signal.aborted) return { ok: false, window, reset, error: { kind: "cancelled" } };
      const page = result.page;
      if (!page || typeof page.generation !== "string" || !page.generation || !Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.items)
        || page.total > 0 && !page.items.length) return { ok: false, window, reset, error: { kind: "unavailable", message: "The transcript returned an invalid replacement page" } };
      page.items.forEach(head => validateTranscriptHead(head));
      if (!result.ok) {
        if (page.items.some((head, index) => head.seq >= page.total || index > 0 && head.seq !== page.items[index - 1].seq + 1)
          || page.items.length > 0 && page.items.at(-1)!.seq !== page.total - 1) return { ok: false, window, reset, error: { kind: "unavailable", message: "The replacement transcript page is not contiguous" } };
        if (reset) return { ok: false, window, reset, error: { kind: "unavailable", message: "The transcript generation kept moving" } };
        reset = true;
        window = { generation: page.generation, total: page.total, items: mergeHeads([], page.items) };
        remaining = EARLIER_PAGE_SIZE - conversationCount(window, options.mono);
      } else {
        const incoming = mergeHeads([], page.items);
        if (page.generation !== window.generation || page.total < before || !incoming.length || incoming[0].seq < 0 || incoming.at(-1)!.seq !== before - 1
          || incoming.some((head, index) => index > 0 && head.seq !== incoming[index - 1].seq + 1)) {
          return { ok: false, window, reset, error: { kind: "unavailable", message: "Earlier history returned a non-contiguous page; retry loading" } };
        }
        remaining -= incoming.filter(visible).length;
        window = { generation: page.generation, total: page.total, items: mergeHeads(window.items, incoming) };
      }
      options.onPage(window, reset);
    }
    return { ok: true, window, reset };
  } catch (cause) {
    return options.signal.aborted
      ? { ok: false, window, reset, error: { kind: "cancelled" } }
      : { ok: false, window, reset, error: { kind: "unavailable", message: cause instanceof Error ? cause.message : String(cause) } };
  }
}
