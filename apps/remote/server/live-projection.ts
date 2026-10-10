import { createExecutionActivity, restoreExecutionActivity, settleExecutionActivity, type ExecutionActivity, type Thread } from "pi-orchestrator/api";
import type { ToolProgress } from "./tool-progress";
import type { Session } from "./protocol";

export function projectThreadActivity(thread: Pick<Thread, "lifecycle" | "executionActivity">): Pick<Session, "lifecycle" | "activity" | "activitySince" | "lastActivityAt" | "activityDetail" | "activeTools" | "executionError"> {
  const lifecycle = thread.lifecycle;
  const empty = { lifecycle, activeTools: [] as string[] };
  switch (lifecycle.kind) {
    case "idle": case "archived": return { ...empty, activity: "idle" };
    case "cancelling": return { ...empty, activity: "cancelling" };
    case "failed": return { ...empty, activity: "status_error", executionError: lifecycle.reason };
    case "waiting": return { ...empty, activity: "awaiting", activitySince: lifecycle.since, activityDetail: lifecycle.reason };
    case "working": return { lifecycle, activity: lifecycle.phase, activitySince: lifecycle.since,
      activityDetail: lifecycle.detail, lastActivityAt: thread.executionActivity?.lastActivityAt,
      activeTools: thread.executionActivity?.activeTools ?? [] };
  }
}

/** Disposable visual state. None of these fields admits or completes work. */
export interface LiveProjection extends ExecutionActivity {
  sessionId: string;
  compacting: boolean;
  retrying: boolean;
  liveText: string;
  liveThinking: string;
  thinkingBlockStart: number;
  thinkingActive: boolean;
  toolProgress: Map<string, ToolProgress>;
  activeTools: Map<string, string>;
}

export function createLiveProjection(sessionId: string): LiveProjection {
  return { ...createExecutionActivity(), sessionId, compacting: false, retrying: false,
    liveText: "", liveThinking: "", thinkingBlockStart: 0, thinkingActive: false,
    toolProgress: new Map(), activeTools: new Map() };
}

export function restoreLiveProjection(live: LiveProjection, snapshot: Record<string, any>): void {
  restoreExecutionActivity(live, snapshot);
  live.compacting = live.activity === "compacting";
  live.retrying = live.activity === "retrying";
  if (typeof snapshot.text === "string") live.liveText = snapshot.text;
  if (typeof snapshot.thinking === "string") live.liveThinking = snapshot.thinking;
  live.thinkingActive = live.activity === "thinking";
  live.thinkingBlockStart = 0;
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools : [];
  live.activeTools = new Map(tools.map(tool => [String(tool.toolCallId), String(tool.toolName)]));
  for (const [id, tool] of live.toolProgress) if (!tool.result && !live.activeTools.has(id)) live.toolProgress.delete(id);
  for (const tool of tools) {
    const id = String(tool.toolCallId);
    if (!live.toolProgress.has(id)) live.toolProgress.set(id, {
      id, name: String(tool.toolName), args: tool.args, startedAt: Date.now(), observedStart: true, output: "",
    });
  }
}

export function settleLiveProjection(live: LiveProjection): void {
  settleExecutionActivity(live);
  live.compacting = false;
  live.retrying = false;
  live.thinkingActive = false;
  live.activeTools.clear();
  for (const [id, tool] of live.toolProgress) if (!tool.result) live.toolProgress.delete(id);
  live.liveText = "";
  live.liveThinking = "";
  live.thinkingBlockStart = 0;
}
