import type { Thread, ThreadState } from "pi-orchestrator/api";
import type { ToolProgress } from "./tool-progress";
import type { Activity } from "./protocol";

export function runningChildParents(...sources: Iterable<Pick<Thread, "parentId" | "state">>[]): Set<string> {
  const parents = new Set<string>();
  for (const source of sources) for (const thread of source) {
    if (thread.parentId && thread.state === "running") parents.add(thread.parentId);
  }
  return parents;
}

export function threadActivity(state: ThreadState, live?: LiveProjection, hasRunningChildren = false): Activity {
  if (state === "idle" && hasRunningChildren) return "awaiting";
  if (state !== "running") return state;
  return live?.compacting ? "compacting" : live?.retrying ? "retrying"
    : live?.activeTools.size ? "waiting_on_tool" : live?.thinkingActive ? "thinking" : state;
}

/** Disposable visual state. None of these fields admits or completes work. */
export interface LiveProjection {
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
  return { sessionId, compacting: false, compactionContextHash: null, retrying: false,
    liveText: "", liveThinking: "", thinkingBlockStart: 0, thinkingActive: false,
    toolProgress: new Map(), pendingContextTextLength: 0, pendingContextThinkingLength: 0,
    pendingContextFinalization: null, activeTools: new Map() };
}

export function restoreLiveProjection(live: LiveProjection, snapshot: Record<string, any>): void {
  live.liveText = live.liveText.slice(0, live.pendingContextTextLength) + String(snapshot.text ?? "");
  live.liveThinking = live.liveThinking.slice(0, live.pendingContextThinkingLength) + String(snapshot.thinking ?? "");
  live.thinkingActive = Boolean(snapshot.isThinking);
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
