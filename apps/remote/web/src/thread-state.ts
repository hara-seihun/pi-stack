import type { Session } from "./types";

export function activeThread(session: Session | null) {
  return session?.state === "running";
}

export const working = activeThread;

export function conversationThreads(sessions: Session[]) {
  return sessions.filter(session => !session.parentId && session.origin !== "fleet" && !session.watchList);
}

export function workerThreads(sessions: Session[]) {
  const live = sessions.filter(session => !session.archivedAt);
  const parents = new Set(live.map(session => session.parentId).filter(Boolean));
  return live.filter(session => session.parentId || session.origin === "fleet" || session.watchList || parents.has(session.id) || session.hasChildren);
}

/** The composer's primary button: Stop while the thread runs and the box is
 * empty, otherwise Send. */
export function composerAction(session: Session | null, draft: string): "send" | "stop" | "resume" {
  if (draft.trim()) return "send";
  if (activeThread(session) || session && !session.held && !session.archivedAt && (session.waitingOnAgents || session.wakeSchedule || session.activity === "awaiting")) return "stop";
  if (session?.held && session.queuedMessages?.length) return "resume";
  return "send";
}
