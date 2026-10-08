import type { Session } from "../../types";
import type { Room, RoomSnapshot } from "../../../../shared/rooms";
import { assertNever } from "../../../../shared/explicit-state";
import { validateThreadObservation } from "../../../../shared/state-validation";

export type StatusKey =
  | "queued" | "admitting" | "starting" | "preparing" | "finishing" | "cancelling" | "recovering" | "reporting_error" | "thinking" | "responding" | "preparing_tool" | "waiting_for_model" | "waiting_for_capacity" | "waiting_to_retry"
  | "tool" | "compacting" | "retrying" | "waiting" | "stopping" | "error"
  | "archived" | "idle" | "offline";

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

export const STATUS_REPORTING_ERROR: ThreadStatus = {
  key: "reporting_error", label: "Status reporting error", short: "Status error", busy: true, attention: true,
  title: "The execution owner failed to report its phase. This is a status instrumentation defect, not an execution phase.",
};

function toolStatus(activeTools: string[]): ThreadStatus {
  const tools = activeTools.map(toolName);
  if (tools.length === 1) return { key: "tool", label: `Running ${tools[0]}`, short: tools[0]!, busy: true, attention: false };
  if (tools.length === 2) return { key: "tool", label: `Running ${tools[0]} and ${tools[1]}`, short: "2 tools", busy: true, attention: false };
  if (tools.length > 2) return { key: "tool", label: `Running ${tools.length} tools`, short: `${tools.length} tools`, title: tools.join(", "), busy: true, attention: false };
  return { ...STATUS_REPORTING_ERROR, title: "The execution owner reports a tool phase without identifying the active tool." };
}

function executionStatus(session: Pick<Session, "activity" | "activeTools">): ThreadStatus {
  switch (session.activity) {
    case "queued": return { key: "queued", label: "Queued for execution", short: "Queued", busy: true, attention: false };
    case "admitting": return { key: "admitting", label: "Acquiring model account", short: "Acquiring account", busy: true, attention: false };
    case "starting": return { key: "starting", label: "Preparing agent", short: "Preparing agent", busy: true, attention: false };
    case "preparing": return { key: "preparing", label: "Preparing next step", short: "Preparing step", busy: true, attention: false };
    case "finishing": return { key: "finishing", label: "Saving execution result", short: "Saving result", busy: true, attention: false };
    case "cancelling": return { key: "cancelling", label: "Cancelling execution", short: "Cancelling", busy: true, attention: false };
    case "recovering": return { key: "recovering", label: "Reconnecting to agent", short: "Reconnecting", busy: true, attention: false };
    case "thinking": return { key: "thinking", label: "Thinking", short: "Thinking", busy: true, attention: false };
    case "responding": return { key: "responding", label: "Writing response", short: "Writing", busy: true, attention: false };
    case "preparing_tool": return { key: "preparing_tool", label: "Preparing tool call", short: "Preparing tool", busy: true, attention: false };
    case "waiting_for_model": return { key: "waiting_for_model", label: "Waiting for model", short: "Waiting for model", busy: true, attention: false };
    case "waiting_for_capacity": return { key: "waiting_for_capacity", label: "Waiting for capacity", short: "Waiting for capacity", busy: true, attention: false };
    case "waiting_to_retry": return { key: "waiting_to_retry", label: "Waiting to retry", short: "Waiting to retry", busy: true, attention: false };
    case "waiting_on_agents": return { key: "waiting", label: "Waiting", short: "Waiting", busy: true, attention: false };
    case "waiting_on_tool": return toolStatus(session.activeTools);
    case "compacting": return { key: "compacting", label: "Compacting context", short: "Compacting", busy: true, attention: false };
    case "retrying": return { key: "retrying", label: "Retrying model request", short: "Retrying", busy: true, attention: false };
    case "status_error": return STATUS_REPORTING_ERROR;
    case "idle": case "awaiting": return { ...STATUS_REPORTING_ERROR, title: `Running execution reports the non-execution phase ${session.activity}.` };
  }
  return assertNever(session.activity, "Execution activity");
}

type StatusSession = Pick<Session, "state" | "held" | "activity" | "activeTools" | "idleUnread" | "archivedAt">
  & Partial<Pick<Session, "activitySince" | "lastActivityAt" | "activityDetail" | "executionError" | "waitingOnAgents">>;

export function threadStatus(session: StatusSession): ThreadStatus {
  validateThreadObservation(session);
  if (session.archivedAt) return { key: "archived", label: "Archived", short: "Archived", busy: false, attention: false };
  if (session.activity === "status_error" && !session.held) return { ...STATUS_REPORTING_ERROR,
    ...(session.waitingOnAgents && !Object.hasOwn(session.waitingOnAgents, "kind") ? { label: "Wait type missing", short: "Wait type missing" } : {}),
    busy: session.state === "running", title: session.activityDetail || session.executionError || STATUS_REPORTING_ERROR.title };
  if (session.executionError) return { key: "error", label: session.held && session.state === "running" ? "Cancellation failed" : "Execution error", short: "Error", title: session.executionError, busy: session.state === "running", attention: true };
  if (session.held && session.state === "running") return { key: "stopping", label: "Cancelling", short: "Cancelling", busy: true, attention: false, title: "Cancellation has been requested, but the runtime has not confirmed it." };
  if (session.held) return { key: "idle", label: "Idle", short: "Idle", busy: false, attention: session.idleUnread };
  if (session.state === "running") {
    const status = executionStatus(session);
    return { ...status,
      ...(status.key === "preparing" && session.activityDetail ? { label: session.activityDetail, short: session.activityDetail } : {}),
      ...(session.activitySince ? { since: session.activitySince } : {}),
      ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
      ...(session.activityDetail ? { title: [status.title, session.activityDetail].filter(Boolean).join(" · ") } : {}),
    };
  }
  if (session.state === "waiting") return waitingStatus(session);
  switch (session.activity) {
    case "awaiting": return waitingStatus(session);
    case "status_error": return { ...STATUS_REPORTING_ERROR, busy: false, title: session.activityDetail || STATUS_REPORTING_ERROR.title };
    case "idle": return { key: "idle", label: "Idle", short: "Idle", busy: false, attention: session.idleUnread };
    case "queued": case "admitting": case "starting": case "preparing": case "finishing": case "cancelling": case "recovering":
    case "thinking": case "responding": case "preparing_tool": case "waiting_for_model": case "waiting_for_capacity": case "waiting_to_retry":
    case "waiting_on_agents": case "waiting_on_tool": case "compacting": case "retrying":
      return { ...STATUS_REPORTING_ERROR, busy: false, title: `Idle thread reports the execution phase ${session.activity}.` };
  }
  return assertNever(session.activity, "Idle activity");
}

function waitingStatus(session: StatusSession): ThreadStatus {
  const wait = session.waitingOnAgents;
  if (!wait && session.state !== "waiting") return {
    ...STATUS_REPORTING_ERROR, busy: false, title: "Awaiting thread has no owned waiting state.",
  };
  const status: ThreadStatus = { key: "waiting", label: "Waiting", short: "Waiting", busy: true, attention: false,
    since: session.activitySince ?? wait?.since, title: session.activityDetail ?? wait?.reason };
  if (!wait) return status;
  if (!Object.hasOwn(wait, "kind")) return { ...STATUS_REPORTING_ERROR, label: "Wait type missing", short: "Wait type missing", busy: false, title: "The stored wait has no dependency type. Set an explicitly typed wait to repair it." };
  switch (wait.kind) {
    case "agents": case "job": case "deployment": case "message": return status;
  }
  return assertNever(wait, "Dependency wait");
}

export function roomThreadStatus(room: Room | RoomSnapshot): ThreadStatus {
  if (room.state === undefined || room.activity === undefined) return { ...STATUS_REPORTING_ERROR, busy: false, title: "Room owner did not report state and activity." };
  validateThreadObservation(room);
  if (room.activity === "status_error") return { ...STATUS_REPORTING_ERROR, title: room.activityDetail || room.error || STATUS_REPORTING_ERROR.title };
  return threadStatus({
    state: room.state, held: room.held ?? false, activity: room.activity,
    activeTools: room.activeTools ?? [], activitySince: room.activitySince, lastActivityAt: room.lastActivityAt,
    activityDetail: room.activityDetail, executionError: room.executionError ?? room.error,
    waitingOnAgents: room.waitingOnAgents, idleUnread: false, archivedAt: null,
  });
}

export const OFFLINE_STATUS: ThreadStatus = { key: "offline", label: "Offline", short: "Offline", busy: false, attention: true };

export function attentionRank(status: ThreadStatus): number {
  if (status.key === "error" || status.key === "reporting_error") return 0;
  if (status.key === "idle" && status.attention) return 2;
  switch (status.key) {
    case "queued": case "admitting": case "starting": case "preparing": case "finishing": case "cancelling": case "recovering": case "tool": case "thinking": case "responding": case "preparing_tool": case "waiting_for_model": case "waiting_for_capacity": case "waiting_to_retry": case "compacting": case "retrying": case "stopping": return 10;
    case "waiting": return 11;
    case "idle": return 21;
    case "archived": return 30;
    case "offline": return 40;
  }
  return assertNever(status.key, "Status attention rank");
}

export type StatusGlyph = "working" | "waiting" | "held" | "stopping" | "done" | "unread" | "error" | "archived" | "offline";

export function statusGlyph(status: ThreadStatus): StatusGlyph {
  switch (status.key) {
    case "queued": case "admitting": case "starting": case "preparing": case "finishing": case "recovering": case "thinking": case "responding": case "preparing_tool": case "waiting_for_model": case "tool": case "compacting": case "retrying": return "working";
    case "waiting": return "waiting";
    case "waiting_for_capacity": case "waiting_to_retry": return "held";
    case "cancelling": case "stopping": return "stopping";
    case "idle": return status.attention ? "unread" : "done";
    case "error": case "reporting_error": return "error";
    case "archived": return "archived";
    case "offline": return "offline";
  }
  return assertNever(status.key, "Status glyph");
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
    ...(status.key !== "waiting" && status.lastActivityAt && now - status.lastActivityAt >= 15_000
      ? { quiet: elapsed(status.lastActivityAt, now) } : {}),
  };
}
