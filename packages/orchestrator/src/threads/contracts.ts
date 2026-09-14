export type Result<T> = { ok: true; value: T } | { ok: false; error: ThreadError };
export type ThreadError = { code: "not_found" | "invalid_request" | "conflict" | "no_pending_messages" | "unavailable" | "cancellation_failed"; message: string };
export type Delivery = "queue" | "steer" | "hardSteer";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Speed = "standard" | "priority";
export type Admission = "force" | "background";
export type ThreadState = "idle" | "queued" | "starting" | "running" | "stopping" | "stopped" | "interrupted";
export type WorkOutcome = "complete" | "failed" | "cancelled";

export interface ThreadSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
  speed: Speed;
}
export type SettingsOverrides = Partial<ThreadSettings>;
export interface Thread {
  id: string;
  parentId: string | null;
  title: string;
  cwd: string;
  sessionFile: string;
  settings: ThreadSettings;
  admission: Admission;
  state: ThreadState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  pendingMessages: number;
  metadata?: Record<string, unknown>;
}
export interface ThreadMessage {
  id: string;
  threadId: string;
  senderId: string | null;
  text: string;
  images?: unknown[];
  delivery: Delivery;
  source: "explicit" | "notification";
  createdAt: number;
  outcome?: WorkOutcome;
  replyTo?: string;
}
export interface SpawnThread {
  requestId: string;
  id?: string;
  parentId?: string;
  title?: string;
  cwd: string;
  message?: string;
  images?: unknown[];
  settings?: SettingsOverrides;
  admission?: Admission;
  metadata?: Record<string, unknown>;
}
export interface SendThread {
  requestId: string;
  threadId: string;
  senderId?: string;
  text: string;
  images?: unknown[];
  delivery: Delivery;
  source?: "explicit" | "notification";
  replyTo?: string;
}
export interface ThreadList {
  parentId?: string | null;
  state?: ThreadState;
  limit?: number;
  cursor?: string;
}
export interface ThreadPage { threads: Thread[]; nextCursor?: string }
export interface ThreadRead { threadId: string; cursor?: string; limit?: number; entryId?: string; offset?: number }
export interface ThreadHistory { entries: Record<string, unknown>[]; nextCursor?: string }
export type ThreadControl =
  | { threadId: string; action: "stop"; descendants: boolean }
  | { threadId: string; action: "resume" }
  | { threadId: string; action: "settings"; settings: SettingsOverrides };
export interface ThreadApi {
  spawn(input: SpawnThread): Promise<Result<Thread>>;
  send(input: SendThread): Promise<Result<ThreadMessage>>;
  list(input?: ThreadList): Promise<Result<ThreadPage>>;
  read(input: ThreadRead): Promise<Result<ThreadHistory>>;
  control(input: ThreadControl): Promise<Result<Thread>>;
}

export type PiEvent = Record<string, unknown> & { type: string };
export type PiCommand = Record<string, unknown> & { type: string; id?: string };
export interface PiSession {
  command(command: PiCommand): Promise<void>;
  close(): Promise<void>;
}
export interface PiSessionOptions {
  threadId: string;
  cwd: string;
  sessionFile: string;
  args: string[];
  env: Record<string, string | undefined>;
  threads?: ThreadApi;
}
export type OpenPiSession = (options: PiSessionOptions, output: (event: PiEvent) => void, exit: (code?: number) => void) => Promise<PiSession>;
