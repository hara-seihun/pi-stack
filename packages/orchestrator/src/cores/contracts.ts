export const CORE_IDS = ["pi", "codex"] as const;
export type CoreId = typeof CORE_IDS[number];
export type CoreOperationState = "pending" | "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface CoreResult { text: string }
export type CoreOperationKind = "prompt" | "steer" | "follow_up" | "compact" | "abort";
export interface CoreOperation {
  workId: string;
  state: CoreOperationState;
  kind?: CoreOperationKind;
  agentId?: string;
  error?: string;
  result?: CoreResult;
}
export interface CoreExecutionSnapshot {
  revision: number;
  status: "idle" | "running" | "stopping" | "blocked";
  operations: CoreOperation[];
}
export type CoreDispatch = { workId: string; agentId?: string } & (
  | { kind: "prompt" | "steer" | "follow_up"; message: string; images?: { type?: "image"; data: string; mimeType: string }[] }
  | { kind: "compact"; customInstructions?: string }
  | { kind: "abort" }
);
export type CoreFailureKind = "unavailable" | "rejected" | "unknown" | "unsupported";
export type CoreOutcome<T> = { ok: true; value: T } | { ok: false; error: { kind: CoreFailureKind; message: string } };

export interface CoreExecutionUpdate { type: "execution_update"; execution: CoreExecutionSnapshot }
export interface CoreResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  errorKind?: CoreFailureKind;
}
/** Engine presentation payloads are not execution evidence. */
export type CorePresentationEvent = Record<string, unknown> & { type:
  | "agent_start" | "agent_end" | "agent_settled" | "turn_start" | "turn_end"
  | "message_start" | "message_update" | "message_end" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
  | "core_agent" | "core_child_event" | "core_error" | "core_exit" | "core_native_session" | "core_run_cancelled"
  | "context_update" | "conversation_replaced" | "queue_update" | "extension_ui_request"
  | "compaction_start" | "compaction_end" | "auto_compaction_start" | "auto_compaction_end"
  | "auto_retry_start" | "auto_retry_end" | "extension_error" | "extension_notification" };
export type CoreOutput = CoreExecutionUpdate | CoreResponse | CorePresentationEvent;
export interface CoreCommand {
  type: "prompt" | "steer" | "follow_up" | "abort" | "close" | "clear_queue"
    | "get_state" | "get_messages" | "get_entries" | "get_core_context" | "get_portable_conversation"
    | "get_available_models" | "get_available_thinking_levels" | "get_commands"
    | "core_agents" | "core_agent_read" | "core_agent_command"
    | "compact" | "set_model" | "set_thinking_level" | "set_session_name" | "fork"
    | "new_session" | "switch_session" | "clone" | "get_fork_messages" | "get_tree"
    | "cycle_model" | "cycle_thinking_level" | "abort_retry" | "extension_ui_response" | "set_steering_mode" | "set_follow_up_mode"
    | "get_session_stats" | "get_last_assistant_text" | "set_auto_compaction" | "set_auto_retry" | "bash" | "abort_bash" | "export_html";
  id?: string;
  workId?: string;
  message?: string;
  images?: { type?: "image"; data: string; mimeType: string }[];
  agentId?: string;
  parentId?: string;
  action?: CoreCommand["type"];
  resume?: boolean;
  provider?: string;
  modelId?: string;
  model?: string;
  thinkingLevel?: string;
  level?: string;
  name?: string;
  entryId?: string;
  parentSession?: string;
  sessionPath?: string;
  sessionFile?: string;
  customInstructions?: string;
  since?: number;
  offset?: number;
  limit?: number;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  mode?: string;
  enabled?: boolean;
  command?: string;
  outputPath?: string;
  streamingBehavior?: "steer" | "followUp";
}

export interface CoreSessionOptions {
  cwd: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** Stable PiStack thread/run identity, independent of the engine's native session ID. */
  sessionId: string;
  /** Private durable directory for this root's native and portable state. */
  stateDir: string;
  /** An explicit cross-engine handoff, not a replay of the last user request. */
  transfer?: PortableConversation;
}

export interface CoreSession {
  command(command: CoreCommand): Promise<void>;
  close(): Promise<void>;
}
export type OpenCoreSession = (
  options: CoreSessionOptions,
  output: (event: CoreOutput) => void,
  exit: (code?: number) => void,
) => Promise<CoreSession>;

export interface PortableConversation {
  version: 1;
  sourceCore: CoreId;
  messages: Record<string, unknown>[];
  agents: CoreAgent[];
}
export interface CoreAgent {
  id: string;
  parentId: string | null;
  name: string;
  model?: string;
  state: "running" | "idle" | "failed" | "cancelled";
  nativeSessionId?: string;
}

export interface CoreCapabilities {
  core: CoreId;
  nativeChildren: boolean;
  fork: boolean;
  compact: boolean;
  steer: boolean;
}

export const isCoreId = (value: unknown): value is CoreId => CORE_IDS.includes(value as CoreId);
export function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
