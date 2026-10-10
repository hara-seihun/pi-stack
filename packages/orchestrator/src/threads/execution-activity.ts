import { isRunnerCapacityFailure } from "./runner-capacity.js";
import { isCompactionFailure, isRateLimitError } from "../provider-errors.js";
import { assertNever, requireAssistantUpdate, requireRuntimeEvent, type RuntimeEvent } from "./runtime-events.js";

export const EXECUTION_PHASES = ["queued", "admitting", "starting", "preparing", "finishing", "cancelling", "recovering", "thinking", "responding", "preparing_tool", "waiting_for_model", "waiting_on_agents", "waiting_on_tool", "compacting", "retrying", "waiting_for_capacity", "waiting_to_retry"] as const;
export type ExecutionPhase = typeof EXECUTION_PHASES[number];

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

const phases: ReadonlySet<unknown> = new Set(EXECUTION_PHASES);
export function requireExecutionPhase(value: unknown): ExecutionPhase {
  if (!phases.has(value)) throw new Error(`Unknown execution activity phase: ${String(value)}`);
  return value as ExecutionPhase;
}

export function executionWaitActivity(metadata?: Record<string, any>): ExecutionActivitySnapshot | undefined {
  const acknowledgement = metadata?.acknowledgementWait;
  if (acknowledgement) return { activity: "recovering", activitySince: acknowledgement.since, lastActivityAt: acknowledgement.since,
    activityDetail: acknowledgement.overdue ? "Input acknowledgement unconfirmed; checking native custody without replay" : "Input acknowledgement pending; native recovery may still be compacting" };
  const provider = metadata?.providerWait, admission = metadata?.admissionWait, startup = metadata?.startupFailure;
  const wait = provider ?? admission ?? startup;
  if (!wait) return undefined;
  const runnerCapacity = !provider && !admission && !!startup && isRunnerCapacityFailure(String(startup.error ?? ""));
  const capacity = provider ? isRateLimitError(String(provider.failure ?? "")) && !isCompactionFailure(String(provider.failure ?? "")) : !!admission || runnerCapacity;
  const globalCapacity = !!admission && String(admission.message ?? "").startsWith("Global agent capacity:");
    let activityDetail = globalCapacity ? String(admission.message) : runnerCapacity ? "Waiting for runner capacity" : capacity ? "Waiting for model capacity" : provider ? "Waiting to retry a provider failure" : "Runtime startup failed; retry scheduled";
  if (Number.isFinite(wait.retryAt)) activityDetail += `; next retry ${new Date(wait.retryAt).toISOString()}`;
  const since = Number.isFinite(wait.since) ? wait.since : undefined;
  return { activity: capacity ? "waiting_for_capacity" : "waiting_to_retry", activitySince: since,
    lastActivityAt: Number.isFinite(wait.lastActivityAt) ? wait.lastActivityAt : since, activityDetail };
}

export function restoreExecutionActivity(state: ExecutionActivity, snapshot: Record<string, any>): void {
  const restoredPhase = snapshot.activity === undefined ? undefined : requireExecutionPhase(snapshot.activity);
  state.activityTools = new Set((Array.isArray(snapshot.tools) ? snapshot.tools : []).map((tool: any) => String(tool.toolCallId)));
  state.activityAgentTools = new Set((Array.isArray(snapshot.tools) ? snapshot.tools : []).filter((tool: any) => tool.toolName === "thread_await").map((tool: any) => String(tool.toolCallId)));
  state.activity = restoredPhase !== undefined ? restoredPhase
    : state.activityTools.size ? "waiting_on_tool" : snapshot.isThinking ? "thinking" : undefined;
  state.activitySince = state.activity && Number.isFinite(snapshot.activitySince) ? snapshot.activitySince : undefined;
  state.lastActivityAt = Number.isFinite(snapshot.lastActivityAt) ? snapshot.lastActivityAt : undefined;
  state.activityDetail = state.activity && typeof snapshot.activityDetail === "string" ? snapshot.activityDetail : undefined;
}

export function settleExecutionActivity(state: ExecutionActivity): void {
  state.activity = undefined; state.activitySince = undefined; state.activityDetail = undefined; state.activityTools.clear(); state.activityAgentTools.clear();
}

type ActivityObservation = { phase: ExecutionPhase; detail: string } | "settled" | undefined;
function assistantActivity(value: unknown): ActivityObservation {
  const update = requireAssistantUpdate(value);
  switch (update.type) {
    case "text_start": case "text_delta": return { phase: "responding", detail: "Response text streaming" };
    case "thinking_start": case "thinking_delta": return { phase: "thinking", detail: "Reasoning output streaming" };
    case "toolcall_start": case "toolcall_delta": return { phase: "preparing_tool", detail: "Tool-call arguments streaming" };
    case "text_end": return { phase: "preparing", detail: "Processing completed response block" };
    case "thinking_end": return { phase: "preparing", detail: "Processing completed reasoning block" };
    case "toolcall_end": return { phase: "preparing", detail: "Dispatching completed tool call" };
    // Start is a header; message_end owns terminal processing, not stream metadata.
    case "start": case "done": case "error": return undefined;
  }
  return assertNever(update);
}
function activityObservation(state: ExecutionActivity, event: RuntimeEvent): ActivityObservation {
  switch (event.type) {
    case "owner_execution_phase": return { phase: requireExecutionPhase(event.activity), detail: String(event.activityDetail ?? "") };
    case "agent_start":
      state.activityTools.clear(); state.activityAgentTools.clear();
      return { phase: "preparing", detail: "Preparing context and runtime hooks" };
    case "model_request_start": return { phase: "waiting_for_model", detail: "Model request sent; waiting for output" };
    case "message_update": return assistantActivity(event.assistantMessageEvent);
    case "message_end":
      if ((event.message as { role?: string } | undefined)?.role !== "assistant") return undefined;
      return { phase: "preparing", detail: "Processing completed assistant message" };
    case "tool_execution_start": case "tool_execution_update":
      state.activityTools.add(String(event.toolCallId));
      if (event.toolName === "thread_await") state.activityAgentTools.add(String(event.toolCallId));
      return { phase: "waiting_on_tool", detail: "Tool execution observed" };
    case "tool_execution_end":
      state.activityTools.delete(String(event.toolCallId)); state.activityAgentTools.delete(String(event.toolCallId));
      return { phase: "preparing", detail: "Integrating tool results" };
    case "auto_retry_start": case "summarization_retry_scheduled": {
      let detail = event.type === "auto_retry_start" ? "Model retry scheduled" : "Context summarization retry scheduled";
      if (typeof event.attempt === "number" && Number.isFinite(event.attempt)) detail += ` (attempt ${event.attempt})`;
      if (typeof event.delayMs === "number" && Number.isFinite(event.delayMs)) detail += `; delay ${event.delayMs} ms`;
      return { phase: "retrying", detail };
    }
    case "summarization_retry_attempt_start": return { phase: "compacting", detail: "Context summarization retry started" };
    case "compaction_start": case "auto_compaction_start": return { phase: "compacting", detail: "Context compaction started" };
    case "auto_retry_end": return { phase: "preparing", detail: "Preparing retry continuation" };
    case "compaction_end": case "auto_compaction_end": case "summarization_retry_finished": return { phase: "preparing", detail: "Integrating compacted context" };
    case "agent_end": case "agent_settled":
      state.activityTools.clear(); state.activityAgentTools.clear();
      return { phase: "finishing", detail: "Synchronizing final execution result" };
    case "thread_settled": case "thread_error": return "settled";
    // Inspection, UI, persistence, transport and direct RPC shell output do not prove agent progress.
    case "message_start": case "turn_start": case "turn_end": case "queue_update":
    case "entry_appended": case "session_info_changed": case "thinking_level_changed":
    case "response": case "extension_ui_request": case "extension_error": case "user_bash": case "bash_execution_update":
    case "session_changed":
    case "command_settled": case "runner_attached": case "thread_message_inserted":
    case "tool_operation_result": case "thread_landed": return undefined;
  }
  return assertNever(event);
}

/** Only production events advance the clock. Inspection and transport heartbeats do not. */
export function observeExecutionActivity(state: ExecutionActivity, input: unknown, now = Date.now()): boolean {
  const event = requireRuntimeEvent(input);
  const at = event.emittedAt ?? now;
  const observation = activityObservation(state, event);
  if (observation === undefined) return false;
  if (observation === "settled") {
    settleExecutionActivity(state); state.lastActivityAt = Math.max(state.lastActivityAt ?? at, at); return true;
  }
  let { phase, detail } = observation;
  if (state.activityTools.size && !["compacting", "retrying", "cancelling", "finishing", "recovering"].includes(phase)) {
    phase = state.activityAgentTools.size === state.activityTools.size ? "waiting_on_agents" : "waiting_on_tool";
    detail = phase === "waiting_on_agents" ? "Waiting for child settlement" : "Tool execution observed";
  }
  if (phase !== state.activity || detail !== state.activityDetail) state.activitySince = at;
  state.activity = phase; state.activityDetail = detail; state.lastActivityAt = Math.max(state.lastActivityAt ?? at, at);
  return true;
}
