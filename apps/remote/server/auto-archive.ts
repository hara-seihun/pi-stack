import type { Thread, ThreadApi } from "pi-orchestrator/api";

export function autoArchiveDelay(value: string | undefined): number {
  const delay = Number(value ?? 0);
  if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("PI_REMOTE_AUTO_ARCHIVE_AFTER_MS must be a nonnegative integer");
  return delay;
}

/**
 * Archives conversations nobody has touched for `afterMs` along with their
 * workers, and workers whose conversation is already archived or gone. An
 * unread conversation stays, and keeps its ancestors; an unread worker does
 * not, because its reader is the agent above it, which has already finished.
 * A worker whose conversation is archived or gone is archived outright once it
 * stops running, queued messages and all.
 */
export async function archiveInactiveThreads(api: ThreadApi, afterMs: number, now = Date.now(), stopped = () => false, isUnread: (thread: Thread) => boolean = () => false): Promise<number> {
  if (afterMs <= 0) return 0;
  const cutoff = now - afterMs;
  const threads = new Map<string, Thread>();
  let cursor: string | undefined;
  do {
    if (stopped()) return 0;
    const page = await api.list({ limit: 100, cursor });
    if (!page.ok) throw new Error(page.error.message);
    for (const thread of page.value.threads) threads.set(thread.id, thread);
    cursor = page.value.nextCursor;
  } while (cursor);
  const unread = (thread: Thread) => !thread.parentId && isUnread(thread);
  const orphaned = (thread: Thread) => { const parent = thread.parentId ? threads.get(thread.parentId) : null; return Boolean(thread.parentId) && (!parent || Boolean(parent.metadata?.archived)); };
  const blocked = new Set<string>();
  for (const thread of threads.values()) {
    if (thread.metadata?.archived) continue;
    if (thread.updatedAt < cutoff && thread.state !== "running" && thread.pendingMessages === 0 && !unread(thread)) continue;
    let id: string | null = thread.id;
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id); blocked.add(id); id = threads.get(id)?.parentId ?? null;
    }
  }
  let archived = 0;
  for (const thread of threads.values()) {
    if (stopped()) break;
    if (thread.metadata?.archived || unread(thread)) continue;
    const orphan = orphaned(thread);
    if (blocked.has(thread.id) && !orphan) continue;
    // An orphan only has to stop running. Its queued messages came from the
    // conversation that is gone, so they are archived with it rather than
    // keeping it current; the owner still refuses while a model is generating.
    if (orphan && thread.state === "running") continue;
    const result = await api.control(orphan ? { threadId: thread.id, action: "update", archived: true } : { threadId: thread.id, action: "archiveInactive", inactiveBefore: cutoff });
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.metadata?.archived) archived++;
  }
  return archived;
}

export function startAutoArchive(api: ThreadApi, afterMs: number, report: (error: unknown) => void, isUnread: (thread: Thread) => boolean = () => false): () => void {
  if (!afterMs) return () => {};
  let stopped = false, running = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try { await archiveInactiveThreads(api, afterMs, Date.now(), () => stopped, isUnread); }
    catch (error) { report(error); }
    finally { running = false; }
  }, 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
