import type { Activity, Session } from "./types";

export function activeThread(session: Session | null) {
  return session?.state === "running";
}

export const working = activeThread;

export function composerAction(session: Session | null, draft: string): "send" | "stop" {
  return activeThread(session) && !draft.trim() ? "stop" : "send";
}

export function conversationThreads(sessions: Session[]) {
  return sessions.filter(session => !session.parentId && session.origin !== "fleet");
}

export function orchestratorThreads(sessions: Session[]) {
  const seen = new Set<string>();
  return sessions.filter(session => {
    if (seen.has(session.id) || (!session.parentId && session.origin !== "fleet")) return false;
    seen.add(session.id);
    return true;
  });
}

export function activityLabel(activity: Activity = "idle", tool = "") {
  if (activity === "waiting_on_tool" && tool) return `WAITING ON ${tool.toUpperCase()}`;
  return activity.replaceAll("_", " ").toUpperCase();
}
export function activityColor(activity: Activity = "idle", idleUnread = false) {
  if (activity === "idle" && idleUnread) return "var(--success)";
  return activity === "idle" || activity === "stopped" ? "var(--muted)" : "var(--accent)";
}
