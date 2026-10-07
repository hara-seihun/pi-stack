import type { Session } from "./protocol";

/** A quiet background agent older than this leaves the always-carried list. */
export const RECENT_FLEET_MS = 60 * 60_000;

const working = (session: Session) => session.state === "running" || session.state === "waiting" || session.activity !== "idle";

/** Foreground, selected, working and recent agents, with useful launch provenance. */
export function streamSessions(sessions: Session[], selected: string | null | undefined, now = Date.now()): Session[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const kept = new Set<string>();
  const keep = (session: Session | undefined) => {
    for (let cursor = session; cursor && !kept.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) kept.add(cursor.id);
  };
  for (const session of sessions) {
    if (session.foreground || session.id === selected || working(session) || Date.parse(session.updatedAt) >= now - RECENT_FLEET_MS) keep(session);
  }
  for (const session of sessions) {
    const parent = session.parentId ? byId.get(session.parentId) : undefined;
    if (parent && working(parent)) kept.add(session.id);
  }
  return kept.size === sessions.length ? sessions : sessions.filter(session => kept.has(session.id));
}

/** Retained stream resource for clients using the preceding protocol. */
export function fleetSessions(sessions: Session[]): Session[] {
  return sessions.filter(session => session.origin === "fleet");
}
