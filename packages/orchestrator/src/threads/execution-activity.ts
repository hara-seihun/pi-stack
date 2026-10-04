import { isCompactionFailure, isRateLimitError } from "../provider-errors.js";

export type ExecutionPhase = "thinking" | "responding" | "preparing_tool" | "waiting_for_model" | "waiting_on_tool" | "compacting" | "retrying" | "waiting_for_capacity" | "waiting_to_retry";

export interface ExecutionActivitySnapshot {
  activity?: ExecutionPhase;
  activitySince?: number;
  lastActivityAt?: number;
  activityDetail?: string;
}

export interface ExecutionActivity extends ExecutionActivitySnapshot {
  activityTools: Set<string>;
}

export function createExecutionActivity(): ExecutionActivity {
  return { activityTools: new Set() };
}

export function executionActivitySnapshot(state: ExecutionActivitySnapshot): ExecutionActivitySnapshot {
  return { activity: state.activity, activitySince: state.activitySince,
    lastActivityAt: state.lastActivityAt, activityDetail: state.activityDetail };
}

const phases = new Set<ExecutionPhase>(["thinking", "responding", "preparing_tool", "waiting_for_model", "waiting_on_tool", "compacting", "retrying", "waiting_for_capacity", "waiting_to_retry"]);

export function executionWaitActivity(metadata?: Record<string, any>): ExecutionActivitySnapshot | undefined {
  const provider = metadata?.providerWait;
  const admission = metadata?.admissionWait;
  const startup = metadata?.startupFailure;
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
  const phase = phases.has(snapshot.activity) ? snapshot.activity as ExecutionPhase
    : state.activityTools.size ? "waiting_on_tool" : snapshot.isThinking ? "thinking" : undefined;
  state.activity = phase;
  state.activitySince = phase && Number.isFinite(snapshot.activitySince) ? snapshot.activitySince : undefined;
  state.lastActivityAt = Number.isFinite(snapshot.lastActivityAt) ? snapshot.lastActivityAt : undefined;
  state.activityDetail = phase && typeof snapshot.activityDetail === "string" ? snapshot.activityDetail : undefined;
}

export function settleExecutionActivity(state: ExecutionActivity): void {
  state.activity = undefined;
  state.activitySince = undefined;
  state.activityDetail = undefined;
  state.activityTools.clear();
}

/** Only production events advance the clock. Inspection and transport heartbeats do not. */
export function observeExecutionActivity(state: ExecutionActivity, event: Record<string, any>, now = Date.now()): boolean {
  const at = typeof event.emittedAt === "number" ? event.emittedAt : now;
  let phase: ExecutionPhase | undefined;
  let detail: string | undefined;
  const update = event.assistantMessageEvent;
  switch (event.type) {
    case "agent_start":
      settleExecutionActivity(state);
      break;
    case "model_request_start":
      phase = "waiting_for_model";
      detail = "Model request started; no output received";
      break;
    case "message_start":
      if (event.message?.role !== "assistant") return false;
      break;
    case "message_update":
      switch (update?.type) {
        case "text_start": case "text_delta":
          phase = "responding"; detail = "Response text streaming"; break;
        case "thinking_start": case "thinking_delta":
          phase = "thinking"; detail = "Reasoning output streaming"; break;
        case "toolcall_start": case "toolcall_delta":
          phase = "preparing_tool"; detail = "Tool-call arguments streaming"; break;
        case "text_end": case "thinking_end": case "toolcall_end":
          break;
        default: return false;
      }
      break;
    case "message_end":
      if (event.message?.role !== "assistant") return false;
      break;
    case "tool_execution_start": case "tool_execution_update":
      state.activityTools.add(String(event.toolCallId));
      phase = "waiting_on_tool"; detail = "Tool execution observed";
      break;
    case "tool_execution_end":
      state.activityTools.delete(String(event.toolCallId));
      break;
    case "auto_retry_start":
      phase = "retrying";
      detail = "Model retry scheduled";
      if (Number.isFinite(event.attempt)) detail += ` (attempt ${event.attempt})`;
      if (Number.isFinite(event.delayMs)) detail += `; delay ${event.delayMs} ms`;
      break;
    case "compaction_start": case "auto_compaction_start":
      phase = "compacting"; detail = "Context compaction started"; break;
    case "auto_retry_end": case "compaction_end": case "auto_compaction_end":
      break;
    case "agent_end": case "agent_settled": case "thread_settled": case "thread_error":
      settleExecutionActivity(state);
      break;
    default: return false;
  }
  if (state.activityTools.size && phase !== "compacting" && phase !== "retrying") {
    phase = "waiting_on_tool";
    detail = "Tool execution observed";
  }
  if (phase !== state.activity) state.activitySince = phase ? at : undefined;
  state.activity = phase;
  state.activityDetail = detail;
  state.lastActivityAt = Math.max(state.lastActivityAt ?? at, at);
  return true;
}
