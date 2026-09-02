export function threadsInOrder<T extends { id: string }>(threads: T[], ids: string[]): T[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const ordered = ids.flatMap((id) => {
    const thread = byId.get(id);
    return thread ? [thread] : [];
  });
  const named = new Set(ids);
  ordered.push(...threads.filter((thread) => !named.has(thread.id)));
  return ordered;
}

export function moveThreadToIndex<T extends { id: string }>(threads: T[], id: string, targetIndex: number): T[] {
  const sourceIndex = threads.findIndex((thread) => thread.id === id);
  if (sourceIndex < 0) return threads;
  const ordered = [...threads];
  const [thread] = ordered.splice(sourceIndex, 1);
  if (!thread) return threads;
  ordered.splice(Math.max(0, Math.min(targetIndex, ordered.length)), 0, thread);
  return ordered;
}
