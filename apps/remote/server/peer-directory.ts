import type { Result, Thread, ThreadApi } from "pi-orchestrator/api";

export async function readLivePeers(api: Pick<ThreadApi, "list" | "archived">,
  local: (id: string) => Thread | null, known: ReadonlyMap<string, Thread>): Promise<Result<{ threads: Map<string, Thread>; archivedTotal: number }>> {
  const counted = api.archived({ kind: "count" });
  const next = new Map<string, Thread>();
  let cursor: string | undefined;
  do {
    const page = await api.list({ archived: false, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    if (!page.ok) { await counted; return page; }
    for (const thread of page.value.threads) {
      if (local(thread.id)) { await counted; return { ok: false, error: { code: "conflict", message: `Thread ${thread.id} has two owners` } }; }
      if (thread.metadata?.archived) { await counted; return { ok: false, error: { code: "unavailable", message: "The live thread directory returned an archived record" } }; }
      next.set(thread.id, thread);
    }
    cursor = page.value.nextCursor;
  } while (cursor);
  const count = await counted;
  if (!count.ok) return count;
  if (count.value.kind !== "count" || !Number.isSafeInteger(count.value.total) || count.value.total < 0)
    return { ok: false, error: { code: "unavailable", message: "The thread owner did not return a valid archive count" } };
  const ancestors = await readPeerAncestors(api, [...next.values()], local, known);
  if (!ancestors.ok) return ancestors;
  return { ok: true, value: { threads: ancestors.value, archivedTotal: count.value.total } };
}

export async function readPeerSession(api: Pick<ThreadApi, "list">, id: string,
  local: (id: string) => Thread | null, known: ReadonlyMap<string, Thread>): Promise<Result<Map<string, Thread> | null>> {
  const found = await api.list({ id, limit: 1 });
  if (!found.ok) return found;
  const thread = found.value.threads.find(thread => thread.id === id);
  return thread ? readPeerAncestors(api, [thread], local, known) : { ok: true, value: null };
}

export async function readPeerAncestors(api: Pick<ThreadApi, "list">, threads: readonly Thread[],
  local: (id: string) => Thread | null, known: ReadonlyMap<string, Thread>): Promise<Result<Map<string, Thread>>> {
  const next = new Map(threads.map(thread => [thread.id, thread]));
  const frontier = [...threads];
  for (let position = 0; position < frontier.length; position++) {
    if (frontier.length > 10000) return { ok: false, error: { code: "oversized", message: "The live thread ancestor graph exceeds its 10000-record bound" } };
    const parentId = frontier[position]!.parentId;
    if (!parentId || next.has(parentId) || local(parentId)) continue;
    const cached = known.get(parentId);
    if (cached?.metadata?.archived) { next.set(parentId, cached); frontier.push(cached); continue; }
    const found = await api.list({ id: parentId, limit: 1 });
    if (!found.ok) return found;
    const parent = found.value.threads.find(thread => thread.id === parentId);
    if (!parent) return { ok: false, error: { code: "unavailable", message: `The live thread's ancestor ${parentId} was not found` } };
    next.set(parentId, parent);
    frontier.push(parent);
  }
  return { ok: true, value: next };
}
