import type { CoreAgent, CoreCommand, CoreOutput, CoreSessionOptions } from "./contracts.js";

export interface PiWork {
  id: string;
  task: string;
  status: "running" | "complete";
  result?: string;
  delivered?: boolean;
}
export interface PiNode extends CoreAgent {
  cwd: string;
  sessionFile: string;
  provider?: string;
  thinkingLevel?: string;
  busy: boolean;
  work?: PiWork;
  workspace?: { repo: string; root: string; path?: string };
}
export interface PiSnapshot {
  name?: string;
  nativeSessionId: string;
  sessionFile: string;
  cwd: string;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  messages: Record<string, unknown>[];
  entries: Record<string, unknown>[];
}
export interface PiNative {
  command(command: CoreCommand): Promise<void>;
  snapshot(): PiSnapshot;
  inject(customType: string, data: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}
export interface PiDelegate {
  task: string;
  threadId?: string;
  newThread?: boolean;
  model?: string;
  thinkingLevel?: string;
  cwd?: string;
  workspace?: { repo: string; root: string };
}
export interface PiToolsHost {
  delegate(parentId: string, requestId: string, request: PiDelegate): Promise<unknown>;
  list(parentId?: string): CoreAgent[];
  read(id: string, offset?: number, limit?: number): Promise<unknown>;
  control(id: string, command: CoreCommand, callerId?: string): Promise<void>;
  beforeReplace(id: string): Promise<void>;
}
export type OpenPiNative = (options: CoreSessionOptions, node: PiNode, tools: PiToolsHost,
  output: (event: CoreOutput) => void, exit: (code?: number) => void) => Promise<PiNative>;
