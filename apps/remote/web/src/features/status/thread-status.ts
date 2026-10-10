import type { Session } from "../../types";
import type { Room, RoomSnapshot } from "../../../../shared/rooms";
import { assertNever } from "../../../../shared/explicit-state";
import type { ThreadLifecycle } from "../../../../../../packages/orchestrator/src/threads/lifecycle";

export type StatusKey = "working" | "typing" | "waiting" | "stopping" | "reporting_error" | "error" | "archived" | "idle" | "offline";
export interface ThreadStatus {
  key: StatusKey; label: string; short: string; title?: string;
  busy: boolean; attention: boolean; since?: number; lastActivityAt?: number;
}
export const STATUS_REPORTING_ERROR: ThreadStatus = { key: "reporting_error", label: "Status unavailable", short: "Status unavailable", busy: false, attention: true, title: "The execution owner did not supply a lifecycle observation." };
type StatusSession = Pick<Session, "lifecycle" | "idleUnread"> & Partial<Pick<Session, "lastActivityAt" | "humanAttention">>;

function lifecycleStatus(lifecycle: ThreadLifecycle, unread: boolean, lastActivityAt?: number): ThreadStatus {
  switch (lifecycle.kind) {
    case "idle": return { key: "idle", label: "Idle", short: "Idle", busy: false, attention: unread };
    case "archived": return { key: "archived", label: "Archived", short: "Archived", busy: false, attention: false };
    case "cancelling": return { key: "stopping", label: "Cancelling", short: "Cancelling", busy: true, attention: false };
    case "failed": return { key: "error", label: "Failed", short: "Failed", title: lifecycle.reason, busy: false, attention: true };
    case "waiting": return { key: "waiting", label: `Waiting for ${lifecycle.target === "agents" ? "agent results" : lifecycle.target === "dispatch" ? "execution" : lifecycle.target}`, short: "Waiting", ...("reason" in lifecycle ? { title: lifecycle.reason } : {}), busy: false, attention: false, since: lifecycle.since };
    case "working": {
      const typing = lifecycle.phase === "responding";
      return { key: typing ? "typing" : "working", label: typing ? "Typing" : "Working", short: typing ? "Typing" : "Working", busy: true, attention: false, title: lifecycle.detail, since: lifecycle.since, lastActivityAt };
    }
  }
  return assertNever(lifecycle, "Thread lifecycle");
}
export function threadStatus(session: StatusSession): ThreadStatus {
  if (!session.lifecycle) return STATUS_REPORTING_ERROR;
  const status = lifecycleStatus(session.lifecycle, session.idleUnread, session.lastActivityAt);
  return { ...status, attention: status.attention && session.humanAttention === true };
}
export function monoThreadStatus(session: StatusSession): ThreadStatus {
  const status = threadStatus(session);
  if (status.key === "waiting" || status.key === "stopping") return { key: "working", label: "Working", short: "Working", busy: true, attention: false };
  if (status.key === "working" || status.key === "typing") return { ...status, title: undefined };
  return status;
}
export function roomThreadStatus(room: Room | RoomSnapshot): ThreadStatus {
  if (!room.lifecycle) return { ...STATUS_REPORTING_ERROR, title: room.error || STATUS_REPORTING_ERROR.title };
  return lifecycleStatus(room.lifecycle, false, room.lastActivityAt);
}
export const OFFLINE_STATUS: ThreadStatus = { key: "offline", label: "Disconnected", short: "Disconnected", busy: false, attention: true };
export function attentionRank(status: ThreadStatus): number {
  switch (status.key) {
    case "error": case "reporting_error": return 0;
    case "idle": return status.attention ? 2 : 21;
    case "working": case "typing": case "stopping": return 10;
    case "waiting": return 11;
    case "archived": return 30;
    case "offline": return 40;
  }
  return assertNever(status.key, "Status attention rank");
}
export type StatusGlyph = "working" | "waiting" | "held" | "stopping" | "done" | "unread" | "error" | "archived" | "offline";
export function statusGlyph(status: ThreadStatus): StatusGlyph {
  switch (status.key) {
    case "working": case "typing": return "working";
    case "waiting": return "waiting";
    case "stopping": return "stopping";
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
  if (!status.busy && status.key !== "waiting") return {};
  return { ...(status.since ? { elapsed: elapsed(status.since, now) } : {}),
    ...(status.key !== "waiting" && status.lastActivityAt && now - status.lastActivityAt >= 15_000 ? { quiet: elapsed(status.lastActivityAt, now) } : {}) };
}
