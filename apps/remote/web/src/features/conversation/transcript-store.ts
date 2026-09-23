// The client holds one window of transcript heads per open session: the
// generation it belongs to, how many items the generation has, and the heads
// it has seen, ordered by seq. The stream pushes the newest window and every
// change; older pages arrive only when the person asks for them.
//
// A generation is the identity of the list prefix. Compaction, a fork or tree
// navigation start a new one, and the window is replaced rather than merged.

import { API } from "../../../../server/api";
import type { TranscriptItemHead, TranscriptPage } from "../../../../server/protocol";
import { piFetch } from "../../client";

export interface TranscriptWindow {
  generation: string;
  total: number;
  /** Ascending by seq. */
  items: TranscriptItemHead[];
}

export const emptyTranscript: TranscriptWindow = { generation: "", total: 0, items: [] };

export interface TranscriptEvent {
  generation: string;
  total: number;
  reset: boolean;
  items: TranscriptItemHead[];
}

/** Upsert by seq, keeping the list ordered and free of duplicates. */
export function mergeHeads(current: readonly TranscriptItemHead[], incoming: readonly TranscriptItemHead[]): TranscriptItemHead[] {
  if (!incoming.length) return [...current];
  const bySeq = new Map(current.map(item => [item.seq, item]));
  for (const item of incoming) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function applyTranscriptEvent(current: TranscriptWindow | null, event: TranscriptEvent): TranscriptWindow {
  const sameGeneration = current && current.generation === event.generation;
  if (event.reset || !sameGeneration) return { generation: event.generation, total: event.total, items: mergeHeads([], event.items) };
  return { generation: event.generation, total: event.total, items: mergeHeads(current.items, event.items) };
}

/** True while the generation holds items older than the window's first head. */
export function hasEarlier(window: TranscriptWindow | null): boolean {
  if (!window || !window.items.length) return false;
  return window.items[0].seq > 0;
}

/** The subscription cursor: what the client already holds for this session. */
export function transcriptCursor(window: TranscriptWindow | null): { generation: string; after: number } | null {
  if (!window || !window.generation || !window.items.length) return null;
  return { generation: window.generation, after: window.items.at(-1)!.seq };
}

export type TranscriptFetch = (path: string) => Promise<Response>;

const request: TranscriptFetch = path => piFetch(path, { headers: { accept: "application/json" }, cache: "no-store" });

export type PageResult =
  | { ok: true; page: TranscriptPage }
  /** The generation moved; the answer carries the window that replaced it. */
  | { ok: false; generation: string; page: TranscriptPage | null };

export async function fetchTranscriptPage(
  sessionId: string,
  query: { generation?: string; before?: number; limit?: number },
  fetcher: TranscriptFetch = request,
): Promise<PageResult> {
  const response = await fetcher(API.sessionTranscript.path({ sessionId }, {
    generation: query.generation || undefined,
    before: query.before,
    limit: query.limit,
  }));
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  // The generation moved under the request; the answer carries the current one.
  if (response.status === 409) {
    const generation = String(body.generation || "");
    const page = Array.isArray(body.items) ? { sessionId, generation, total: Number(body.total) || body.items.length, items: body.items } as TranscriptPage : null;
    return { ok: false, generation, page };
  }
  if (!response.ok) throw new Error(body.error || `Transcript page returned HTTP ${response.status}`);
  return { ok: true, page: body as TranscriptPage };
}

export const EARLIER_PAGE_SIZE = 60;

/**
 * One "Show earlier" step. A 409 means the thread compacted or forked while
 * the person was reading: the newest window of the current generation replaces
 * what the client holds.
 */
export async function loadEarlier(
  sessionId: string,
  window: TranscriptWindow,
  { limit = EARLIER_PAGE_SIZE, fetcher = request }: { limit?: number; fetcher?: TranscriptFetch } = {},
): Promise<{ window: TranscriptWindow; reset: boolean }> {
  const before = window.items[0]?.seq ?? 0;
  const older = await fetchTranscriptPage(sessionId, { generation: window.generation, before, limit }, fetcher);
  if (older.ok) {
    return {
      window: { generation: older.page.generation, total: older.page.total, items: mergeHeads(window.items, older.page.items) },
      reset: false,
    };
  }
  // The 409 already carries the newest window; only ask again if it did not.
  const replacement = older.page ?? await fetchTranscriptPage(sessionId, { generation: older.generation, limit }, fetcher)
    .then(result => result.ok ? result.page : result.page);
  if (!replacement) throw new Error("The transcript generation kept moving");
  return {
    window: { generation: replacement.generation, total: replacement.total, items: mergeHeads([], replacement.items) },
    reset: true,
  };
}
