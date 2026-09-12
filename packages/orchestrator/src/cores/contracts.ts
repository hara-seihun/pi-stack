export const CORE_IDS = ["pi", "codex"] as const;
export type CoreId = typeof CORE_IDS[number];
export type CoreOutput = Record<string, unknown> & { type: string };
export type CoreCommand = Record<string, unknown> & { type: string; id?: string };

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
