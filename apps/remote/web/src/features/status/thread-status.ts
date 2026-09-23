import type { Session } from "../../types";

export type StatusKey =
  | "running" | "thinking" | "tool" | "compacting" | "retrying" | "awaiting"
  | "stopped" | "archived" | "idle" | "offline";

export interface ThreadStatus {
  key: StatusKey;
  /** Sentence-case label, e.g. "Running bash". */
  label: string;
  /** Short form for dense rows, e.g. "bash". */
  short: string;
  /** Extra detail shown when the visible label cannot name every tool. */
  title?: string;
  /** True while the thread has current work. */
  busy: boolean;
  /** True when the person should look at it. */
  attention: boolean;
}

function toolName(tool: string) {
  return tool.replace(/^functions\./, "").replaceAll("_", " ");
}

function toolStatus(activeTools: string[]): ThreadStatus {
  const tools = activeTools.map(toolName);
  if (tools.length === 1) return { key: "tool", label: `Running ${tools[0]}`, short: tools[0]!, busy: true, attention: false };
  if (tools.length === 2) return { key: "tool", label: `Running ${tools[0]} and ${tools[1]}`, short: "2 tools", busy: true, attention: false };
  if (tools.length > 2) return { key: "tool", label: `Running ${tools.length} tools`, short: `${tools.length} tools`, title: tools.join(", "), busy: true, attention: false };
  return { key: "tool", label: "Running a tool", short: "Tool", busy: true, attention: false };
}

export function threadStatus(session: Pick<Session, "state" | "held" | "activity" | "activeTools" | "idleUnread" | "archivedAt">): ThreadStatus {
  if (session.archivedAt) return { key: "archived", label: "Archived", short: "Archived", busy: false, attention: false };
  if (session.held) return { key: "stopped", label: "Stopped", short: "Stopped", busy: false, attention: true };
  if (session.state === "running") {
    switch (session.activity) {
      case "thinking": return { key: "thinking", label: "Thinking", short: "Thinking", busy: true, attention: false };
      case "waiting_on_tool": return toolStatus(session.activeTools);
      case "compacting": return { key: "compacting", label: "Compacting context", short: "Compacting", busy: true, attention: false };
      case "retrying": return { key: "retrying", label: "Retrying", short: "Retrying", busy: true, attention: false };
      default: return { key: "running", label: "Working", short: "Working", busy: true, attention: false };
    }
  }
  if (session.activity === "awaiting") return { key: "awaiting", label: "Waiting on workers", short: "Workers", busy: true, attention: false };
  return { key: "idle", label: "Idle", short: "Idle", busy: false, attention: session.idleUnread };
}

export const OFFLINE_STATUS: ThreadStatus = { key: "offline", label: "Offline", short: "Offline", busy: false, attention: true };

/** Sort weight for the inbox: lower comes first. */
export function attentionRank(status: ThreadStatus): number {
  if (status.key === "stopped") return 1;
  if (status.key === "idle" && status.attention) return 2;
  switch (status.key) {
    case "tool": case "running": case "thinking": case "compacting": case "retrying": return 10;
    case "awaiting": return 11;
    case "idle": return 21;
    case "archived": return 30;
    case "offline": return 40;
  }
}
