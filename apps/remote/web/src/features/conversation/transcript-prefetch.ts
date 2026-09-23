// A conversation opens a beat after the finger lands on its row. That beat is
// enough for its newest window to be on the way: pressing an inbox or worker
// row, and opening a notification, ask for `GET /v1/sessions/:id/transcript`
// here, and the thread paints from the answer instead of waiting for the
// stream to subscribe and reply. The stream's reset window supersedes it.
//
// Cost is the reason for every bound in this file. A window is a few kilobytes
// of heads, so a wrong guess is cheap; a wrong guess repeated is not. Nothing
// is asked for twice within the freshness window, only a handful of threads
// are held, and the arrival prefetch stays off a metered or slow connection.

import { fetchTranscriptPage, type TranscriptFetch, type TranscriptWindow } from "./transcript-store";

/** How long a prefetched window is worth using or worth not asking for again. */
export const PREFETCH_FRESH_MS = 30_000;
/** Threads prefetched when the inbox first arrives. */
export const ARRIVAL_PREFETCH_LIMIT = 3;
const MAX_HELD = 8;

interface Held { at: number; window: Promise<TranscriptWindow | null> }

const held = new Map<string, Held>();

function request(sessionId: string, fetcher?: TranscriptFetch): Promise<TranscriptWindow | null> {
  return fetchTranscriptPage(sessionId, {}, fetcher).then((result) => {
    // A 409 cannot happen without a generation; either way the answer carries
    // the newest window when there is one.
    const page = result.ok ? result.page : result.page;
    return page ? { generation: page.generation, total: page.total, items: [...page.items] } : null;
  }, () => null);
}

/** Starts loading a thread's newest window, unless a fresh one is already held. */
export function prefetchTranscript(sessionId: string, options: { fetcher?: TranscriptFetch } = {}) {
  if (!sessionId) return;
  const existing = held.get(sessionId);
  if (existing && Date.now() - existing.at < PREFETCH_FRESH_MS) return;
  held.set(sessionId, { at: Date.now(), window: request(sessionId, options.fetcher) });
  for (const [id] of [...held].sort((a, b) => a[1].at - b[1].at).slice(0, Math.max(0, held.size - MAX_HELD))) held.delete(id);
}

/** The window prefetched for this thread, if one was and it is still fresh. It is used once. */
export async function takePrefetchedWindow(sessionId: string): Promise<TranscriptWindow | null> {
  const entry = held.get(sessionId);
  if (!entry) return null;
  held.delete(sessionId);
  if (Date.now() - entry.at > PREFETCH_FRESH_MS) return null;
  const window = await entry.window;
  return window && window.items.length ? window : null;
}

/** Forgets everything held, for a person or environment change. */
export function forgetPrefetchedTranscripts() {
  held.clear();
}

/**
 * Whether speculative loading is welcome on this connection: never under Data
 * Saver, and only on 4g when the browser says what the connection is.
 */
export function prefetchWelcome(connection = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  return !connection.effectiveType || connection.effectiveType === "4g";
}

interface PrefetchCandidate { id: string; idleUnread: boolean; updatedAt: string; archivedAt: string | null }

/**
 * The threads a person is most likely to open when the inbox arrives: the ones
 * that finished while they were away, newest first. Returns what it asked for.
 */
export function prefetchUnreadThreads(sessions: readonly PrefetchCandidate[], options: { limit?: number; fetcher?: TranscriptFetch; welcome?: boolean } = {}): string[] {
  if (!(options.welcome ?? prefetchWelcome())) return [];
  const targets = sessions
    .filter(session => session.idleUnread && !session.archivedAt)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, options.limit ?? ARRIVAL_PREFETCH_LIMIT);
  for (const target of targets) prefetchTranscript(target.id, { fetcher: options.fetcher });
  return targets.map(target => target.id);
}
