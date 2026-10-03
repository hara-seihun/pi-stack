export const THREAD_EXECUTION_CONTRACT = "unified-threads-v1";
import type { ThreadCreator } from "./caller.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: ThreadError };
export type ThreadError = { code: "not_found" | "invalid_request" | "conflict" | "no_pending_messages" | "unavailable" | "cancellation_failed"; message: string; retryable?: boolean; requestId?: string };
export type Delivery = "queue" | "steer" | "hardSteer";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export const isThinkingLevel = (value: unknown): value is ThinkingLevel => THINKING_LEVELS.some(level => level === value);
import type { Speed } from "./speed.js";
export type { Speed } from "./speed.js";
/** `live` is never requested directly; it comes from a thread mode (see modes.ts). */
export type Admission = "force" | "background" | "live";
export const THREAD_STATES = ["idle", "running"] as const;
export type ThreadState = typeof THREAD_STATES[number];
export const isThreadState = (state: unknown): state is ThreadState => THREAD_STATES.some(value => value === state);
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
  role?: "conversation" | "worker";
  title: string;
  cwd: string;
  sessionFile: string;
  settings: ThreadSettings;
  admission: Admission;
  state: ThreadState;
  held: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  pendingMessages: number;
  metadata?: Record<string, unknown>;
}
export interface ThreadQuestion {
  id: string;
  threadId: string;
  question: string;
  suggestions: Array<{ id: string; text: string }>;
  recommendedSuggestionId?: string;
  createdAt: number;
}
export interface QuestionInput {
  question: string;
  suggestions?: string[];
  recommendedSuggestionIndex?: number;
}
export interface AskThreadQuestions {
  requestId: string;
  threadId: string;
  questions: QuestionInput[];
}
export interface QuestionsReceipt { accepted: true; questionIds: string[] }
export interface AnswerThreadQuestion {
  threadId: string;
  questionId: string;
  selectedSuggestionIds: string[];
  text: string;
}
export interface QuestionReceipt { accepted: true; questionId: string }
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
  state: "queued" | "dispatched" | "done";
  insertedAt?: number | null;
  landedAt?: number | null;
}
export interface SpawnThread {
  requestId: string;
  id?: string;
  parentId?: string;
  title?: string;
  cwd: string;
  message?: string;
  ephemeral?: boolean;
  images?: unknown[];
  settings?: SettingsOverrides;
  admission?: Admission;
  metadata?: Record<string, unknown>;
  /** Set by the owner from the verified caller and stored as metadata.createdBy; clients cannot supply it. */
  createdBy?: ThreadCreator;
}
export interface SendThread {
  requestId: string;
  threadId: string;
  senderId?: string;
  text: string;
  images?: unknown[];
  delivery?: Delivery;
  source?: "explicit" | "notification";
  replyTo?: string;
}
export function resolveDelivery(input: Pick<SendThread, "senderId" | "delivery">): Delivery {
  return input.delivery ?? (input.senderId ? "steer" : "queue");
}
export interface ThreadList {
  id?: string;
  parentId?: string | null;
  state?: ThreadState;
  /** `false` omits archived threads; unset lists both. */
  archived?: boolean;
  limit?: number;
  cursor?: string;
}
export interface ThreadPage { threads: Thread[]; nextCursor?: string }
export interface ThreadRead { threadId: string; cursor?: string; limit?: number; entryId?: string; offset?: number }
export interface ThreadHistory { entries: Record<string, unknown>[]; nextCursor?: string }
export interface ThreadSettlement {
  seq: number;
  executionId: string;
  threadId: string;
  workId: string;
  outcome: WorkOutcome;
  time: number;
  finalMessage: Record<string, unknown> | null;
  error?: string;
}
export interface ThreadSettlements { items: ThreadSettlement[]; cursor: number }
export const THREAD_AWAIT_TIMEOUT_MS = 25_000;
export interface AwaitThreads {
  parentId: string;
  threadIds: string[];
  after?: Record<string, number>;
  timeoutMs?: number;
}
export interface ThreadAwaitResult {
  settlement: ThreadSettlement | null;
  remainingThreadIds: string[];
  after: Record<string, number>;
}
export function validateThreadAwait(input: AwaitThreads): Result<void> {
  if (!input || typeof input.parentId !== "string" || !input.parentId.trim()
    || !Array.isArray(input.threadIds) || input.threadIds.length < 1 || input.threadIds.length > 100
    || input.threadIds.some(id => typeof id !== "string" || !id.trim() || id === input.parentId)
    || new Set(input.threadIds).size !== input.threadIds.length) {
    return { ok: false, error: { code: "invalid_request", message: "Await requires a parent and 1..100 unique child thread IDs, excluding the parent" } };
  }
  if (input.after !== undefined && (!input.after || typeof input.after !== "object" || Array.isArray(input.after)
    || Object.values(input.after).some(cursor => !Number.isSafeInteger(cursor) || cursor < 0))) {
    return { ok: false, error: { code: "invalid_request", message: "Await cursors must be nonnegative safe integers keyed by thread ID" } };
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > THREAD_AWAIT_TIMEOUT_MS)) {
    return { ok: false, error: { code: "invalid_request", message: `Await timeoutMs must be 0..${THREAD_AWAIT_TIMEOUT_MS}` } };
  }
  return { ok: true, value: undefined };
}
export interface InspectOptions { contextRevision?: number }
export interface ThreadInspection {
  thread: Thread;
  pending: ThreadMessage[];
  context?: Record<string, unknown>;
  live?: Record<string, unknown>;
}
export type ThreadControl =
  /** `reason: "archive"` records the work this stop interrupts so a restore can resume it. */
  | { threadId: string; action: "stop"; descendants: boolean; reason?: "archive" }
  | { threadId: string; action: "resume" }
  /** Unarchive a thread, or its whole subtree; `resume` continues the turns and held work its archive interrupted. */
  | { threadId: string; action: "restore"; descendants: boolean; resume?: boolean }
  | { threadId: string; action: "archiveInactive"; inactiveBefore: number }
  | { threadId: string; action: "settings"; settings: SettingsOverrides }
  | { threadId: string; action: "cancelMessage"; messageId: string }
  | { threadId: string; action: "promoteMessage"; messageId: string; delivery: Delivery }
  | { threadId: string; action: "update"; title?: string; metadata?: Record<string, unknown>; archived?: boolean };
export interface ThreadApi {
  watch(input: import("./watch-list.js").WatchRequest): Promise<Result<import("./watch-list.js").WatchResponse>>;
  ask(input: AskThreadQuestions): Promise<Result<QuestionsReceipt>>;
  questions(threadId: string): Promise<Result<ThreadQuestion[]>>;
  answer(input: AnswerThreadQuestion): Promise<Result<QuestionReceipt>>;
  spawn(input: SpawnThread): Promise<Result<Thread>>;
  send(input: SendThread): Promise<Result<ThreadMessage>>;
  list(input?: ThreadList): Promise<Result<ThreadPage>>;
  read(input: ThreadRead): Promise<Result<ThreadHistory>>;
  control(input: ThreadControl): Promise<Result<Thread>>;
  /** `contextRevision`: the thread revision whose context the caller already holds; an idle thread at that revision omits `context`. */
  inspect(threadId: string, options?: InspectOptions): Promise<Result<ThreadInspection>>;
  command(threadId: string, command: PiCommand): Promise<Result<unknown>>;
  settlements(after?: number, limit?: number): Result<ThreadSettlements> | Promise<Result<ThreadSettlements>>;
  await(input: AwaitThreads, signal?: AbortSignal): Promise<Result<ThreadAwaitResult>>;
}

/** `emittedAt`: epoch ms when the Pi process produced the event, set by the thread owner. */
export type PiEvent = Record<string, unknown> & { type: string; emittedAt?: number };
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
export interface PiRunnerReference { control: string; socketPath: string }
export type AttachPiSession = (reference: PiRunnerReference | undefined, output: (event: PiEvent) => void, exit: (code: number | null) => void) => Promise<PiSession | null>;
