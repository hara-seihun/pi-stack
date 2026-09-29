import type { Session } from "./protocol";

/** A fleet thread that settled longer ago than this leaves the always-carried list. */
export const RECENT_FLEET_MS = 60 * 60_000;

const working = (session: Session) => session.state === "running" || session.activity !== "idle";

/**
 * The sessions every client carries on every connection: all of the person's
 * own threads, and only the fleet threads that are working, recent, selected,
 * above one of those, or a direct worker of a working thread. The fleet keeps
 * thousands of settled threads; they belong to the Workers screen's "All"
 * view, which subscribes to them separately, not to every chat opening.
 */
export function streamSessions(sessions: Session[], selected: string | null | undefined, now = Date.now()): Session[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const kept = new Set<string>();
  const keep = (session: Session | undefined) => {
    for (let cursor = session; cursor && !kept.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) kept.add(cursor.id);
  };
  for (const session of sessions) {
    if (session.origin !== "fleet" || session.id === selected || working(session) || Date.parse(session.updatedAt) >= now - RECENT_FLEET_MS) keep(session);
  }
  for (const session of sessions) {
    const parent = session.parentId ? byId.get(session.parentId) : undefined;
    if (parent && working(parent)) kept.add(session.id);
  }
  return kept.size === sessions.length ? sessions : sessions.filter(session => kept.has(session.id));
}

/** Everything the "All" workers view lists that the always-carried list may omit. */
export function fleetSessions(sessions: Session[]): Session[] {
  return sessions.filter(session => session.origin === "fleet");
}
