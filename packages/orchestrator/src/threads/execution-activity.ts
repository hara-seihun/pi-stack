import { isCompactionFailure, isRateLimitError } from "../provider-errors.js";

export type ExecutionPhase = "queued" | "admitting" | "starting" | "preparing" | "finishing" | "cancelling" | "recovering"
  | "thinking" | "responding" | "preparing_tool" | "waiting_for_model" | "waiting_on_agents" | "waiting_on_tool" | "compacting" | "retrying" | "waiting_for_capacity" | "waiting_to_retry";

export interface ExecutionActivitySnapshot {
  activity?: ExecutionPhase;
  activitySince?: number;
  lastActivityAt?: number;
  activityDetail?: string;
}

export interface ExecutionActivity extends ExecutionActivitySnapshot { activityTools: Set<string>; activityAgentTools: Set<string> }

export function createExecutionActivity(): ExecutionActivity { return { activityTools: new Set(), activityAgentTools: new Set() }; }

export function executionActivitySnapshot(state: ExecutionActivitySnapshot): ExecutionActivitySnapshot {
  return { activity: state.activity, activitySince: state.activitySince, lastActivityAt: state.lastActivityAt, activityDetail: state.activityDetail };
}

const phases = new Set<ExecutionPhase>(["queued", "admitting", "starting", "preparing", "finishing", "cancelling", "recovering", "thinking", "responding", "preparing_tool", "waiting_for_model", "waiting_on_agents", "waiting_on_tool", "compacting", "retrying", "waiting_for_capacity", "waiting_to_retry"]);

export function executionWaitActivity(metadata?: Record<string, any>): ExecutionActivitySnapshot | undefined {
  const provider = metadata?.providerWait, admission = metadata?.admissionWait, startup = metadata?.startupFailure;
  const wait = provider ?? admission ?? startup;
  if (!wait) return undefined;
  const capacity = provider ? isRateLimitError(String(provider.failure ?? "")) && !isCompactionFailure(String(provider.failure ?? "")) : !!admission;
  let activityDetail = capacity ? "Waiting for model capacity" : provider ? "Waiting to retry a provider failure" : "Runtime startup failed; retry scheduled";
  if (Number.isFinite(wait.retryAt)) activityDetail += `; next retry ${new Date(wait.retryAt).toISOString()}`;
  const since = Number.isFinite(wait.since) ? wait.since : undefined;
  return { activity: capacity ? "waiting_for_capacity" : "waiting_to_retry", activitySince: since,
    lastActivityAt: Number.isFinite(wait.lastActivityAt) ? wait.lastActivityAt : since, activityDetail };
}

export function restoreExecutionActivity(state: ExecutionActivity, snapshot: Record<string, any>): void {
  state.activityTools = new Set((Array.isArray(snapshot.tools) ? snapshot.tools : []).map((tool: any) => String(tool.toolCallId)));
  state.activityAgentTools = new Set((Array.isArray(snapshot.tools) ? snapshot.tools : []).filter((tool: any) => tool.toolName === "thread_await").map((tool: any) => String(tool.toolCallId)));
  state.activity = phases.has(snapshot.activity) ? snapshot.activity as ExecutionPhase
    : state.activityTools.size ? "waiting_on_tool" : snapshot.isThinking ? "thinking" : undefined;
  state.activitySince = state.activity && Number.isFinite(snapshot.activitySince) ? snapshot.activitySince : undefined;
  state.lastActivityAt = Number.isFinite(snapshot.lastActivityAt) ? snapshot.lastActivityAt : undefined;
  state.activityDetail = state.activity && typeof snapshot.activityDetail === "string" ? snapshot.activityDetail : undefined;
}

export function settleExecutionActivity(state: ExecutionActivity): void {
  state.activity = undefined; state.activitySince = undefined; state.activityDetail = undefined; state.activityTools.clear(); state.activityAgentTools.clear();
}

/** Only production events advance the clock. Inspection and transport heartbeats do not. */
export function observeExecutionActivity(state: ExecutionActivity, event: Record<string, any>, now = Date.now()): boolean {
  const at = typeof event.emittedAt === "number" ? event.emittedAt : now;
  let phase: ExecutionPhase = "preparing", detail = "Preparing next runtime step";
  const update = event.assistantMessageEvent;
  switch (event.type) {
    case "owner_execution_phase":
      if (!phases.has(event.activity)) return false;
      phase = event.activity; detail = String(event.activityDetail ?? ""); break;
    case "agent_start":
      state.activityTools.clear(); state.activityAgentTools.clear(); detail = "Preparing context and runtime hooks"; break;
    case "model_request_start":
      phase = "waiting_for_model"; detail = "Model request sent; waiting for output"; break;
    case "message_start":
      return false;
    case "message_update":
      switch (update?.type) {
        case "text_start": case "text_delta": phase = "responding"; detail = "Response text streaming"; break;
        case "thinking_start": case "thinking_delta": phase = "thinking"; detail = "Reasoning output streaming"; break;
        case "toolcall_start": case "toolcall_delta": phase = "preparing_tool"; detail = "Tool-call arguments streaming"; break;
        case "text_end": detail = "Processing completed response block"; break;
        case "thinking_end": detail = "Processing completed reasoning block"; break;
        case "toolcall_end": detail = "Dispatching completed tool call"; break;
        default: return false;
      }
      break;
    case "message_end":
      if (event.message?.role !== "assistant") return false;
      detail = "Processing completed assistant message"; break;
    case "tool_execution_start": case "tool_execution_update":
      state.activityTools.add(String(event.toolCallId));
      if (event.toolName === "thread_await") state.activityAgentTools.add(String(event.toolCallId));
      phase = "waiting_on_tool"; detail = "Tool execution observed"; break;
    case "tool_execution_end":
      state.activityTools.delete(String(event.toolCallId)); state.activityAgentTools.delete(String(event.toolCallId)); detail = "Integrating tool results"; break;
    case "auto_retry_start":
      phase = "retrying"; detail = "Model retry scheduled";
      if (Number.isFinite(event.attempt)) detail += ` (attempt ${event.attempt})`;
      if (Number.isFinite(event.delayMs)) detail += `; delay ${event.delayMs} ms`;
      break;
    case "compaction_start": case "auto_compaction_start":
      phase = "compacting"; detail = "Context compaction started"; break;
    case "auto_retry_end": detail = "Preparing retry continuation"; break;
    case "compaction_end": case "auto_compaction_end": detail = "Integrating compacted context"; break;
    case "agent_end": case "agent_settled":
      state.activityTools.clear(); phase = "finishing"; detail = "Synchronizing final execution result"; break;
    case "thread_settled": case "thread_error":
      settleExecutionActivity(state); state.lastActivityAt = Math.max(state.lastActivityAt ?? at, at); return true;
    default: return false;
  }
  if (state.activityTools.size && !["compacting", "retrying", "cancelling", "finishing", "recovering"].includes(phase)) {
    phase = state.activityAgentTools.size === state.activityTools.size ? "waiting_on_agents" : "waiting_on_tool";
    detail = phase === "waiting_on_agents" ? "Waiting for child settlement" : "Tool execution observed";
  }
  if (phase !== state.activity || detail !== state.activityDetail) state.activitySince = at;
  state.activity = phase; state.activityDetail = detail; state.lastActivityAt = Math.max(state.lastActivityAt ?? at, at);
  return true;
}
