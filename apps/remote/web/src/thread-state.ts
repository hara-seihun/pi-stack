import type { Session } from "./types";

export function working(session: Session | null) {
  return Boolean(session && ["QUEUED", "RUNNING", "STARTING", "STOPPING"].includes(session.state));
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
