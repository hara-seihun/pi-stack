import type { Session } from "./types";

export function partitionThreads(sessions: Session[]) {
  return {
    interactive: sessions.filter(session => !session.subagent),
    subagents: sessions.filter(session => Boolean(session.subagent)),
  };
}

export function threadDrawerTab(session: Session | undefined): "threads" | "agents" {
  return session?.subagent ? "agents" : "threads";
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
export function activityColor(activity = "IDLE") {
  const normalized = normalizedActivity(activity);
  return ["FAILED", "ERROR", "ABORTING"].includes(normalized) ? "var(--danger)" : ["IDLE", "DONE", "KILLED", "STOPPED"].includes(normalized) ? "var(--muted)" : "var(--accent)";
}
