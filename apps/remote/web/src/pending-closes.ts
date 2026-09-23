// A chat the person has just closed leaves the inbox at the tap, not when the
// supervisor has finished stopping its runner. The server stays the truth:
// the row is only hidden while the close it asked for is in flight, comes
// back the moment that close fails, and is forgotten once the server's own
// state no longer lists it.
import type { ChatId } from "../../server/protocol";

export type PendingCloses = ReadonlySet<ChatId>;

export const withClose = (pending: PendingCloses, id: ChatId): PendingCloses => pending.has(id) ? pending : new Set([...pending, id]);
export const withoutClose = (pending: PendingCloses, id: ChatId): PendingCloses => {
  if (!pending.has(id)) return pending;
  const next = new Set(pending); next.delete(id); return next;
};

/** Drops closes the server has already applied; returns the same set when nothing changed so effects settle. */
export function reconcileCloses(pending: PendingCloses, present: Iterable<ChatId>): PendingCloses {
  if (!pending.size) return pending;
  const listed = new Set(present);
  const next = new Set([...pending].filter(id => listed.has(id)));
  return next.size === pending.size ? pending : next;
}

export const hideClosing = <T extends { chat: { id: ChatId } }>(rows: T[], pending: PendingCloses): T[] => pending.size ? rows.filter(row => !pending.has(row.chat.id)) : rows;
