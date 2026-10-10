import type { Session } from "./types";
import { lifecycleControl } from "../../../../packages/orchestrator/src/threads/lifecycle";

export function activeThread(session: Session | null) {
  return session?.lifecycle.kind === "working" || session?.lifecycle.kind === "cancelling";
}

export const working = activeThread;

export function conversationThreads(sessions: Session[]) {
  return sessions.filter(session => session.foreground === true || session.foreground === undefined && !session.parentId && session.origin !== "fleet" && !session.watchList);
}

export function conversationTab(session: Session): "chats" {
  return "chats";
}

export function composerAction(session: Session | null, draft: string): "send" | "stop" | "cancel_wait" | "resume" {
  if (draft.trim() || !session) return "send";
  const action = lifecycleControl(session.lifecycle);
  return action === "none" ? "send" : action;
}
