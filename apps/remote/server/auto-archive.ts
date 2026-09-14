import type { Thread, ThreadApi } from "pi-orchestrator/api";

export function autoArchiveDelay(value: string | undefined): number {
  const delay = Number(value ?? 0);
  if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("PI_REMOTE_AUTO_ARCHIVE_AFTER_MS must be a nonnegative integer");
  return delay;
}

export async function archiveInactiveThreads(api: ThreadApi, afterMs: number, now = Date.now(), stopped = () => false): Promise<number> {
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
  const blocked = new Set<string>();
  for (const thread of threads.values()) {
    if (thread.metadata?.archived) continue;
    if (thread.updatedAt < cutoff && ["idle", "stopped"].includes(thread.state) && thread.pendingMessages === 0) continue;
    let id: string | null = thread.id;
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id); blocked.add(id); id = threads.get(id)?.parentId ?? null;
    }
  }
  let archived = 0;
  for (const thread of threads.values()) {
    if (stopped()) break;
    if (thread.metadata?.archived || blocked.has(thread.id)) continue;
    const result = await api.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: cutoff });
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.metadata?.archived) archived++;
  }
  return archived;
}

export function startAutoArchive(api: ThreadApi, afterMs: number, report: (error: unknown) => void): () => void {
  if (!afterMs) return () => {};
  let stopped = false, running = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try { await archiveInactiveThreads(api, afterMs, Date.now(), () => stopped); }
    catch (error) { report(error); }
    finally { running = false; }
  }, 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
