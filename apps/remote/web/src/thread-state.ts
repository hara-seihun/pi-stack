import type { Session } from "./types";

export function activeThread(session: Session | null) {
  return session?.state === "running";
}

export const working = activeThread;

export function conversationThreads(sessions: Session[]) {
  return sessions.filter(session => session.foreground === true || session.foreground === undefined && !session.parentId && session.origin !== "fleet" && !session.watchList);
}

export function conversationTab(session: Session): "chats" {
  return "chats";
}

/** The composer's primary button: Stop while the thread runs and the box is
 * empty, otherwise Send. */
export function composerAction(session: Session | null, draft: string): "send" | "stop" | "resume" {
  if (draft.trim()) return "send";
  if (activeThread(session) || session && !session.held && !session.archivedAt && (session.waitingOnAgents || session.wakeSchedule || session.activity === "awaiting")) return "stop";
  return "send";
}
