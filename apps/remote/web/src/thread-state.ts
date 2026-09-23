import type { Session } from "./types";

export function activeThread(session: Session | null) {
  return session?.state === "running";
}

export const working = activeThread;

export function conversationThreads(sessions: Session[]) {
  return sessions.filter(session => !session.parentId && session.origin !== "fleet");
}

/** The composer's primary button: Stop while the thread runs and the box is
 * empty, otherwise Send. */
export function composerAction(session: Session | null, draft: string): "send" | "stop" | "resume" {
  if (draft.trim()) return "send";
  if (activeThread(session)) return "stop";
  if (session?.held && session.queuedMessages?.length) return "resume";
  return "send";
}
