import type { AgentSessionEvent, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent, StopReason } from "@earendil-works/pi-ai";

// Every SDK variant must be classified here when the SDK changes.
const sdkEvents = {
  agent_start: true, agent_end: true, agent_settled: true,
  turn_start: true, turn_end: true,
  message_start: true, message_update: true, message_end: true,
  tool_execution_start: true, tool_execution_update: true, tool_execution_end: true,
  queue_update: true, compaction_start: true, compaction_end: true,
  entry_appended: true, session_info_changed: true, thinking_level_changed: true,
  auto_retry_start: true, auto_retry_end: true,
  summarization_retry_scheduled: true, summarization_retry_attempt_start: true, summarization_retry_finished: true,
  bash_execution_update: true,
} satisfies Record<AgentSessionEvent["type"], true>;

export const RUNTIME_EVENT_TYPES = {
  ...sdkEvents,
  response: true, extension_ui_request: true, extension_error: true, user_bash: true,
  auto_compaction_start: true, auto_compaction_end: true,
  owner_execution_phase: true, model_request_start: true,
  session_changed: true,
  command_settled: true, runner_attached: true,
  thread_settled: true, thread_error: true, thread_message_inserted: true,
} as const;
export type RuntimeEventType = keyof typeof RUNTIME_EVENT_TYPES;
export type RuntimeEvent = { [K in RuntimeEventType]: Record<string, unknown> & { type: K; emittedAt?: number } }[RuntimeEventType];

const assistantEvents = {
  start: true, text_start: true, text_delta: true, text_end: true,
  thinking_start: true, thinking_delta: true, thinking_end: true,
  toolcall_start: true, toolcall_delta: true, toolcall_end: true,
  done: true, error: true,
} satisfies Record<AssistantMessageEvent["type"], true>;
export type AssistantUpdate = { [K in keyof typeof assistantEvents]: Record<string, unknown> & { type: K } }[keyof typeof assistantEvents];

const extensionMethods = { select: true, confirm: true, input: true, editor: true, notify: true,
  setStatus: true, setWidget: true, setTitle: true, set_editor_text: true,
} satisfies Record<RpcExtensionUIRequest["method"], true>;
export type ExtensionUIMethod = keyof typeof extensionMethods;

const stopReasons = { pending: true, stop: true, length: true, toolUse: true, error: true, aborted: true, deferred: true } satisfies Record<StopReason, true>;
export function requireAssistantStopReason(value: unknown): StopReason {
  if (typeof value !== "string" || !Object.hasOwn(stopReasons, value)) throw new Error(`Unknown assistant stop reason: ${String(value)}`);
  return value as StopReason;
}

export type VariantResult<T> = { ok: true; value: T } | { ok: false; error: string };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function parseRuntimeEvent(value: unknown): VariantResult<RuntimeEvent> {
  if (!object(value) || typeof value.type !== "string") return { ok: false, error: "Runtime event requires an object with a string type" };
  if (!Object.hasOwn(RUNTIME_EVENT_TYPES, value.type)) return { ok: false, error: `Unknown runtime event type: ${value.type.slice(0, 160)}` };
  if (value.emittedAt !== undefined && (typeof value.emittedAt !== "number" || !Number.isFinite(value.emittedAt))) return { ok: false, error: `Invalid emittedAt for runtime event ${value.type}` };
  if (value.type === "message_update") {
    const update = parseAssistantUpdate(value.assistantMessageEvent);
    if (!update.ok) return update;
  }
  if ((value.type === "agent_settled" || value.type === "thread_settled") && value.outcome !== undefined && value.outcome !== "complete" && value.outcome !== "failed" && value.outcome !== "cancelled") return { ok: false, error: `Unknown settlement outcome: ${String(value.outcome)}` };
  if ((value.type === "message_start" || value.type === "message_update" || value.type === "message_end") && object(value.message) && value.message.role === "assistant" && value.message.stopReason !== undefined && (typeof value.message.stopReason !== "string" || !Object.hasOwn(stopReasons, value.message.stopReason))) return { ok: false, error: `Unknown assistant stop reason: ${String(value.message.stopReason)}` };
  if (value.type === "extension_ui_request" && (typeof value.method !== "string" || !Object.hasOwn(extensionMethods, value.method))) return { ok: false, error: `Unknown extension UI method: ${String(value.method)}` };
  if (value.type === "summarization_retry_attempt_start" && value.source !== "compaction" && value.source !== "branchSummary") return { ok: false, error: `Unknown summarization retry source: ${String(value.source)}` };
  return { ok: true, value: value as RuntimeEvent };
}

export function parseAssistantUpdate(value: unknown): VariantResult<AssistantUpdate> {
  if (!object(value) || typeof value.type !== "string") return { ok: false, error: "Assistant message update requires a string type" };
  if (!Object.hasOwn(assistantEvents, value.type)) return { ok: false, error: `Unknown assistant message update type: ${value.type.slice(0, 160)}` };
  return { ok: true, value: value as AssistantUpdate };
}

export function requireRuntimeEvent(value: unknown): RuntimeEvent {
  const result = parseRuntimeEvent(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
export function requireAssistantUpdate(value: unknown): AssistantUpdate {
  const result = parseAssistantUpdate(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
export function assertNever(value: never): never {
  const variant: unknown = value;
  const name = object(variant) ? variant.type ?? variant.state ?? variant.kind ?? "object" : variant;
  throw new Error(`Unhandled closed variant: ${String(name).slice(0, 160)}`);
}
