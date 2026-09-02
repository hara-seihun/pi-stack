// @ts-check

/**
 * @template {{id:string}} T
 * @param {T[]} threads
 * @param {string[]} ids
 * @returns {T[]}
 */
export function threadsInOrder(threads, ids) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const named = new Set(ids);
  ordered.push(...threads.filter((thread) => !named.has(thread.id)));
  return /** @type {T[]} */ (ordered);
}

/**
 * @template {{id:string}} T
 * @param {T[]} threads
 * @param {string} id
 * @param {number} targetIndex
 * @returns {T[]}
 */
export function moveThreadToIndex(threads, id, targetIndex) {
  const sourceIndex = threads.findIndex((thread) => thread.id === id);
  if (sourceIndex < 0) return threads;
  const ordered = [...threads];
  const [thread] = ordered.splice(sourceIndex, 1);
  ordered.splice(Math.max(0, Math.min(targetIndex, ordered.length)), 0, thread);
  return ordered;
}
