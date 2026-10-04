import type { Session } from "../../types";

export type StatusKey =
  | "running" | "thinking" | "responding" | "preparing_tool" | "waiting_for_model" | "waiting_for_capacity" | "waiting_to_retry"
  | "tool" | "compacting" | "retrying" | "awaiting" | "stopping" | "error"
  | "stopped" | "archived" | "idle" | "offline";

export interface ThreadStatus {
  key: StatusKey;
  label: string;
  short: string;
  title?: string;
  busy: boolean;
  attention: boolean;
  since?: number;
  lastActivityAt?: number;
}

function toolName(tool: string) {
  return tool.replace(/^functions\./, "").replaceAll("_", " ");
}

export const UNKNOWN_ACTIVITY: ThreadStatus = {
  key: "running", label: "Activity unknown", short: "Activity unknown", busy: true, attention: false,
  title: "The execution is marked running, but no current phase is reported. This does not confirm progress.",
};

function toolStatus(activeTools: string[]): ThreadStatus {
  const tools = activeTools.map(toolName);
  if (tools.length === 1) return { key: "tool", label: `Running ${tools[0]}`, short: tools[0]!, busy: true, attention: false };
  if (tools.length === 2) return { key: "tool", label: `Running ${tools[0]} and ${tools[1]}`, short: "2 tools", busy: true, attention: false };
  if (tools.length > 2) return { key: "tool", label: `Running ${tools.length} tools`, short: `${tools.length} tools`, title: tools.join(", "), busy: true, attention: false };
  return { ...UNKNOWN_ACTIVITY, title: "The execution reports a tool phase, but no active tool is identified." };
}

function executionStatus(session: Pick<Session, "activity" | "activeTools">): ThreadStatus {
  switch (session.activity) {
    case "thinking": return { key: "thinking", label: "Thinking", short: "Thinking", busy: true, attention: false };
    case "responding": return { key: "responding", label: "Writing response", short: "Writing", busy: true, attention: false };
    case "preparing_tool": return { key: "preparing_tool", label: "Preparing tool call", short: "Preparing tool", busy: true, attention: false };
    case "waiting_for_model": return { key: "waiting_for_model", label: "Waiting for model", short: "Waiting for model", busy: true, attention: false };
    case "waiting_for_capacity": return { key: "waiting_for_capacity", label: "Waiting for capacity", short: "Waiting for capacity", busy: true, attention: false };
    case "waiting_to_retry": return { key: "waiting_to_retry", label: "Waiting to retry", short: "Waiting to retry", busy: true, attention: false };
    case "waiting_on_tool": return toolStatus(session.activeTools);
    case "compacting": return { key: "compacting", label: "Compacting context", short: "Compacting", busy: true, attention: false };
    case "retrying": return { key: "retrying", label: "Retrying model request", short: "Retrying", busy: true, attention: false };
    default: return UNKNOWN_ACTIVITY;
  }
}

type StatusSession = Pick<Session, "state" | "held" | "activity" | "activeTools" | "idleUnread" | "archivedAt">
  & Partial<Pick<Session, "activitySince" | "lastActivityAt" | "activityDetail" | "executionError">>;

export function threadStatus(session: StatusSession): ThreadStatus {
  if (session.archivedAt) return { key: "archived", label: "Archived", short: "Archived", busy: false, attention: false };
  if (session.executionError) return { key: "error", label: session.held && session.state === "running" ? "Stop failed" : "Execution error", short: "Error", title: session.executionError, busy: session.state === "running", attention: true };
  if (session.held && session.state === "running") return { key: "stopping", label: "Stopping", short: "Stopping", busy: true, attention: false, title: "Cancellation has been requested, but the runtime has not confirmed it." };
  if (session.held) return { key: "stopped", label: "Stopped", short: "Stopped", busy: false, attention: true };
  if (session.state === "running") {
    const status = executionStatus(session);
    return { ...status,
      ...(session.activitySince ? { since: session.activitySince } : {}),
      ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
      ...(session.activityDetail ? { title: [status.title, session.activityDetail].filter(Boolean).join(" · ") } : {}),
    };
  }
  if (session.activity === "awaiting") return { key: "awaiting", label: "Waiting on workers", short: "Workers", busy: true, attention: false };
  return { key: "idle", label: "Idle", short: "Idle", busy: false, attention: session.idleUnread };
}

export const OFFLINE_STATUS: ThreadStatus = { key: "offline", label: "Offline", short: "Offline", busy: false, attention: true };

export function attentionRank(status: ThreadStatus): number {
  if (status.key === "error") return 0;
  if (status.key === "stopped") return 1;
  if (status.key === "idle" && status.attention) return 2;
  switch (status.key) {
    case "tool": case "running": case "thinking": case "responding": case "preparing_tool": case "waiting_for_model": case "waiting_for_capacity": case "waiting_to_retry": case "compacting": case "retrying": case "stopping": return 10;
    case "awaiting": return 11;
    case "idle": return 21;
    case "archived": return 30;
    case "offline": return 40;
  }
}

function elapsed(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function activityTiming(status: ThreadStatus, now: number): { elapsed?: string; quiet?: string } {
  if (!status.busy) return {};
  return {
    ...(status.since ? { elapsed: elapsed(status.since, now) } : {}),
    ...(status.lastActivityAt && now - status.lastActivityAt >= 15_000
      ? { quiet: `No activity update for ${elapsed(status.lastActivityAt, now)}` } : {}),
  };
}
