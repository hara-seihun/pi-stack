import { createExecutionActivity, executionWaitActivity, restoreExecutionActivity, settleExecutionActivity, validateWaitDependency, type ExecutionActivity, type Thread, type ThreadState } from "pi-orchestrator/api";
import type { ToolProgress } from "./tool-progress";
import type { Activity, Session } from "./protocol";

export function runningChildParents(...sources: Iterable<Pick<Thread, "parentId" | "state"> & Partial<Pick<Thread, "held" | "metadata" | "waitingOnAgents">>>[]): Set<string> {
  const parents = new Set<string>();
  for (const source of sources) for (const thread of source) {
    if (thread.parentId && (thread.state === "running" || !thread.held && !thread.metadata?.archived && (thread.waitingOnAgents || thread.metadata?.agentWait))) parents.add(thread.parentId);
  }
  return parents;
}

export function threadActivity(state: ThreadState, live?: LiveProjection, hasRunningChildren = false): Activity {
  if (state === "idle") return hasRunningChildren ? "awaiting" : "idle";
  if (state === "running") return live?.compacting ? "compacting" : live?.retrying ? "retrying"
    : live?.activeTools.size ? "waiting_on_tool" : live?.activity ?? (live?.thinkingActive ? "thinking" : "status_error");
  state satisfies never;
  throw new Error("Unsupported thread execution state");
}

export function projectThreadActivity(state: ThreadState, live?: LiveProjection, hasRunningChildren = false,
  snapshot?: Thread["executionActivity"], metadata?: Thread["metadata"], held = false): Pick<Session, "activity" | "activitySince" | "lastActivityAt" | "activityDetail" | "activeTools" | "executionError" | "waitingForChildren"> {
  const dependency = metadata?.agentWait as import("pi-orchestrator/api").AgentWait | undefined;
  if (state === "idle" && !held && !metadata?.archived && dependency) {
    const labels = { agents: "Waiting on agents", job: "Waiting for job", deployment: "Waiting for deployment", message: "Waiting for message" } as const;
    const parsed = validateWaitDependency(dependency);
    if (!parsed.ok || typeof dependency.reason !== "string" || !dependency.reason.trim() || !Number.isFinite(dependency.since)) {
      const detail = "Wait reporting defect: missing, unsupported or invalid dependency";
      return { activity: "status_error", activitySince: dependency.since, activityDetail: detail, activeTools: [], executionError: detail };
    }
    return {
      activity: "awaiting", activitySince: dependency.since, activityDetail: `${labels[parsed.value.kind]} · ${dependency.reason}`,
      activeTools: [], executionError: typeof metadata?.executionError === "string" ? metadata.executionError : undefined,
    };
  }
  if (held || metadata?.archived) hasRunningChildren = false;
  const wait = state === "running" ? executionWaitActivity(metadata) : undefined;
  const resuming = snapshot?.activity && !["waiting_for_capacity", "waiting_to_retry"].includes(snapshot.activity)
    && (snapshot.lastActivityAt ?? 0) > (wait?.lastActivityAt ?? wait?.activitySince ?? Infinity);
  if (wait && !resuming) snapshot = { ...wait, activeTools: [] };
  const activity = snapshot ? state !== "running" ? threadActivity(state, undefined, hasRunningChildren) : snapshot.activity ?? "status_error"
    : threadActivity(state, live, hasRunningChildren);
  const evidence = snapshot ?? live;
  return { activity,
    ...(state === "idle" && !held && !metadata?.archived && hasRunningChildren ? { waitingForChildren: true } : {}),
    activitySince: state === "running" ? evidence?.activitySince : undefined,
    lastActivityAt: evidence?.lastActivityAt,
    activityDetail: state === "running" ? evidence?.activityDetail : undefined,
    executionError: typeof metadata?.executionError === "string" && (held || !wait) ? metadata.executionError : undefined,
    activeTools: state === "running" ? snapshot?.activeTools ?? [...(live?.activeTools.values() ?? [])] : [] };
}

/** Disposable visual state. None of these fields admits or completes work. */
export interface LiveProjection extends ExecutionActivity {
  sessionId: string;
  compacting: boolean;
  compactionContextHash: string | null;
  retrying: boolean;
  liveText: string;
  liveThinking: string;
  thinkingBlockStart: number;
  thinkingActive: boolean;
  toolProgress: Map<string, ToolProgress>;
  pendingContextTextLength: number;
  pendingContextThinkingLength: number;
  pendingContextFinalization: string | null;
  activeTools: Map<string, string>;
}

export function createLiveProjection(sessionId: string): LiveProjection {
  return { ...createExecutionActivity(), sessionId, compacting: false, compactionContextHash: null, retrying: false,
    liveText: "", liveThinking: "", thinkingBlockStart: 0, thinkingActive: false,
    toolProgress: new Map(), pendingContextTextLength: 0, pendingContextThinkingLength: 0,
    pendingContextFinalization: null, activeTools: new Map() };
}

export function restoreLiveProjection(live: LiveProjection, snapshot: Record<string, any>): void {
  restoreExecutionActivity(live, snapshot);
  live.compacting = live.activity === "compacting";
  live.retrying = live.activity === "retrying";
  if (typeof snapshot.text === "string") live.liveText = live.liveText.slice(0, live.pendingContextTextLength) + snapshot.text;
  if (typeof snapshot.thinking === "string") live.liveThinking = live.liveThinking.slice(0, live.pendingContextThinkingLength) + snapshot.thinking;
  live.thinkingActive = live.activity === "thinking";
  live.thinkingBlockStart = live.pendingContextThinkingLength;
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
  if (!live.pendingContextFinalization) {
    live.liveText = "";
    live.liveThinking = "";
    live.thinkingBlockStart = 0;
    live.pendingContextTextLength = 0;
    live.pendingContextThinkingLength = 0;
  }
}
