import type { Session } from "./types";

const ACTIVE_THREAD_STATES = new Set(["QUEUED", "STARTING", "RUNNING", "STOPPING"]);

export function activeThread(session: Session | null) {
  return Boolean(session && ACTIVE_THREAD_STATES.has(normalizedActivity(session.state)));
}

export const working = activeThread;

export function orchestratorThreads(sessions: Session[]) {
  const seen = new Set<string>();
  return sessions.filter(session => {
    if (seen.has(session.id) || (!session.parentId && session.origin !== "fleet")) return false;
    seen.add(session.id);
    return true;
  });
}

export function normalizedActivity(activity = "IDLE") {
  return activity.trim().toUpperCase().replace(/[\s-]+/g, "_") || "IDLE";
}
export function activityLabel(activity = "IDLE", tool = "") {
  const normalized = normalizedActivity(activity);
  if (normalized === "WAITING_ON_TOOL") return tool ? `WAITING ON ${tool.toUpperCase()}` : "WAITING ON TOOL";
  if (normalized === "RUNNING") return "WORKING";
  return normalized.replaceAll("_", " ");
}
export function activityColor(activity = "IDLE", idleUnread = false) {
  const normalized = normalizedActivity(activity);
  if (normalized === "IDLE" && idleUnread) return "var(--success)";
  return ["FAILED", "ERROR", "STOPPING", "INTERRUPTED"].includes(normalized) ? "var(--danger)" : ["IDLE", "DONE", "KILLED", "STOPPED"].includes(normalized) ? "var(--muted)" : "var(--accent)";
}
