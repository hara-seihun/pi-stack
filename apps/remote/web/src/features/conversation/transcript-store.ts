// The client holds the authoritative recent window plus any older pages the
// person explicitly loaded. The stream replaces its recent region in full;
// older pages arrive only when the person asks for them.
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
export const TRANSCRIPT_HEAD_BUDGET = 600;
export const TRANSCRIPT_HEAD_BYTES = 8 * 1024 * 1024;

export function boundTranscriptHeads(items: readonly TranscriptItemHead[], direction: "older" | "newer"): TranscriptItemHead[] {
  const source = direction === "older" ? items : [...items].reverse();
  const held: TranscriptItemHead[] = [];
  let bytes = 0;
  for (const head of source) {
    const size = JSON.stringify(head).length * 2;
    if (held.length >= TRANSCRIPT_HEAD_BUDGET || held.length && bytes + size > TRANSCRIPT_HEAD_BYTES) break;
    held.push(head);
    bytes += size;
  }
  return direction === "older" ? held : held.reverse();
}
export interface VisibleTranscriptRange { from: number; to: number }

function withoutBody(head: TranscriptItemHead): TranscriptItemHead {
  if (!head.body) return head;
  const { body: _body, ...metadata } = head;
  return metadata;
}

export interface TranscriptEvent {
  generation: string;
  total: number;
  items: TranscriptItemHead[];
}

/** Upsert by seq, keeping the list ordered and free of duplicates. */
export function mergeHeads(current: readonly TranscriptItemHead[], incoming: readonly TranscriptItemHead[]): TranscriptItemHead[] {
  if (!incoming.length) return [...current];
  const bySeq = new Map(current.map(item => [item.seq, item]));
  for (const item of incoming) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function applyTranscriptEvent(current: TranscriptWindow | null, event: TranscriptEvent, visible: VisibleTranscriptRange | null = null): TranscriptWindow {
  if (!current || current.generation !== event.generation) return { generation: event.generation, total: event.total, items: boundTranscriptHeads(event.items, "newer") };
  const first = event.items[0]?.seq ?? event.total;
  const older = current.items.filter(item => item.seq < first && item.seq < event.total).map(withoutBody);
  const candidate = [...older, ...event.items];
  const tail = boundTranscriptHeads(candidate, "newer");
  const readingOlder = hasNewer(current) && first > (current.items.at(-1)?.seq ?? -1) + 1
    || !!visible && !!tail.length && visible.from < tail[0].seq;
  if (readingOlder) {
    const updates = new Map(event.items.map(item => [item.seq, item]));
    return { generation: event.generation, total: event.total, items: current.items.filter(item => item.seq < event.total).map(item => updates.get(item.seq) ?? withoutBody(item)) };
  }
  return { generation: event.generation, total: event.total, items: tail };
}

export function hasNewer(window: TranscriptWindow | null): boolean {
  return !!window?.items.length && window.items.at(-1)!.seq < window.total - 1;
}

/** True while the generation holds items older than the window's first head. */
export function hasEarlier(window: TranscriptWindow | null): boolean {
  if (!window || !window.items.length) return false;
  return window.items[0].seq > 0;
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

export async function loadLatest(sessionId: string, fetcher: TranscriptFetch = request): Promise<TranscriptWindow> {
  const result = await fetchTranscriptPage(sessionId, { limit: EARLIER_PAGE_SIZE }, fetcher);
  const page = result.page;
  if (!page) throw new Error("The transcript generation kept moving");
  return { generation: page.generation, total: page.total, items: boundTranscriptHeads(page.items, "newer") };
}

export async function loadNewer(sessionId: string, window: TranscriptWindow, fetcher: TranscriptFetch = request): Promise<{ window: TranscriptWindow; reset: boolean }> {
  const before = Math.min(window.total, (window.items.at(-1)?.seq ?? -1) + 1 + EARLIER_PAGE_SIZE);
  const result = await fetchTranscriptPage(sessionId, { generation: window.generation, before, limit: EARLIER_PAGE_SIZE }, fetcher);
  if (!result.ok) return { window: await loadLatest(sessionId, fetcher), reset: true };
  return { window: { generation: result.page.generation, total: result.page.total, items: boundTranscriptHeads(mergeHeads(window.items.map(withoutBody), result.page.items), "newer") }, reset: false };
}

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
      window: { generation: older.page.generation, total: older.page.total, items: boundTranscriptHeads(mergeHeads(window.items.map(withoutBody), older.page.items), "older") },
      reset: false,
    };
  }
  // The 409 already carries the newest window; only ask again if it did not.
  const replacement = older.page ?? await fetchTranscriptPage(sessionId, { generation: older.generation, limit }, fetcher)
    .then(result => result.ok ? result.page : result.page);
  if (!replacement) throw new Error("The transcript generation kept moving");
  return {
    window: { generation: replacement.generation, total: replacement.total, items: boundTranscriptHeads(replacement.items, "newer") },
    reset: true,
  };
}
