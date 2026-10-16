import { parseRuntimeEvent, type RuntimeEvent, type RuntimeEventType } from "pi-orchestrator/api";

// Observed-only events belong to native history, RPC, scheduling or activity;
// they do not add another message to Remote's display projection.
const presentation = {
  agent_start: "project", agent_end: "observe", agent_settled: "observe",
  turn_start: "observe", turn_end: "observe", queue_update: "observe",
  message_start: "project", message_update: "project", message_end: "project",
  tool_execution_start: "project", tool_execution_update: "project", tool_execution_end: "project",
  compaction_start: "project", compaction_end: "project",
  auto_compaction_start: "observe", auto_compaction_end: "observe",
  auto_retry_start: "project", auto_retry_end: "project",
  entry_appended: "observe", session_info_changed: "observe", thinking_level_changed: "observe",
  summarization_retry_scheduled: "observe", summarization_retry_attempt_start: "observe", summarization_retry_finished: "observe",
  bash_execution_update: "observe", user_bash: "observe",
  response: "project", extension_ui_request: "project", extension_error: "project",
  owner_execution_phase: "observe", model_request_start: "observe",
  session_changed: "observe",
  command_settled: "observe", runner_attached: "observe",
  thread_settled: "project", thread_error: "project", thread_message_inserted: "project",
} satisfies Record<RuntimeEventType, "project" | "observe">;

export function parsePresentationEvent(input: unknown): { ok: true; event: RuntimeEvent; project: boolean } | { ok: false; error: string } {
  const parsed = parseRuntimeEvent(input);
  if (!parsed.ok) return parsed;
  return { ok: true, event: parsed.value, project: presentation[parsed.value.type] === "project" };
}
