import { type Thread, type ThreadApi } from "pi-orchestrator/api";

export function autoArchiveDelay(value: string | undefined): number {
  const delay = Number(value ?? 0);
  if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("PI_REMOTE_AUTO_ARCHIVE_AFTER_MS must be a nonnegative integer");
  return delay;
}

/** Retention is per agent. Launch provenance never closes another agent. */
export async function archiveInactiveThreads(api: ThreadApi, afterMs: number, now = Date.now(), stopped = () => false,
  isUnread: (thread: Thread) => boolean = () => false, isLive: (thread: Thread) => boolean = () => false): Promise<number> {
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
  const unread = isUnread;
  const expired = (thread: Thread) => {
    if (thread.updatedAt >= cutoff) return false;
    const viewedAt = thread.metadata?.autoArchiveViewedAt;
    const viewed = typeof viewedAt === "number" && Number.isSafeInteger(viewedAt) && viewedAt > 0;
    return viewed && viewedAt >= thread.updatedAt && viewedAt < cutoff;
  };
  const blocked = new Set<string>();
  for (const thread of threads.values()) {
    if (thread.metadata?.archived) continue;
    if (thread.waitingOnAgents || thread.dependencies?.length) blocked.add(thread.id);
  }
  let archived = 0;
  for (const thread of threads.values()) {
    if (stopped()) break;
    if (thread.metadata?.archived || unread(thread) || isLive(thread)) continue;
    if (blocked.has(thread.id) || !expired(thread) || thread.state !== "idle" || thread.pendingMessages > 0) continue;
    const result = await api.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: cutoff });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    if (result.value.metadata?.archived) archived++;
  }
  return archived;
}

export function startAutoArchive(api: ThreadApi, afterMs: number, report: (error: unknown) => void,
  isUnread: (thread: Thread) => boolean = () => false, isLive: (thread: Thread) => boolean = () => false): () => void {
  if (!afterMs) return () => {};
  let stopped = false, running = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try { await archiveInactiveThreads(api, afterMs, Date.now(), () => stopped, isUnread, isLive); }
    catch (error) { report(error); }
    finally { running = false; }
  }, 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
