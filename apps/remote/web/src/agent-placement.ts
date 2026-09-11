import type { AgentRun, Session } from "./types";

export function partitionThreads(sessions: Session[]) {
  return {
    interactive: sessions.filter(session => !session.subagent),
    subagents: sessions.filter(isActiveSubagent),
  };
}

export function isActiveAgentRun(run: AgentRun): boolean {
  return ["queued", "starting", "running", "waiting"].includes(run.status);
}

export function isActiveSubagent(session: Session): boolean {
  return Boolean(session.subagent) && !session.archivedAt && ["STARTING", "RUNNING", "ABORTING"].includes(session.state);
}

export function subagentRoot(session: Session, sessions: Session[]): string {
  const byId = new Map(sessions.map(item => [item.id, item]));
  const seen = new Set([session.id]);
  let parentId = session.subagent!.parentSessionId;
  while (!seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent?.subagent) return parentId;
    parentId = parent.subagent.parentSessionId;
  }
  return session.subagent!.parentSessionId;
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
