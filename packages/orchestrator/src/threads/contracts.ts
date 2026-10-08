export const THREAD_EXECUTION_CONTRACT = "unified-threads-v1";
import type { ThreadCreator } from "./caller.js";
import type { ExecutionActivitySnapshot } from "./execution-activity.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: ThreadError };
export type ThreadError = { code: "not_found" | "invalid_request" | "conflict" | "no_pending_messages" | "unavailable" | "cancellation_failed" | "oversized"; message: string; retryable?: boolean; retryAt?: number; requestId?: string };
export type Delivery = "queue" | "steer" | "hardSteer";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export const isThinkingLevel = (value: unknown): value is ThinkingLevel => THINKING_LEVELS.some(level => level === value);
import type { Speed } from "./speed.js";
export type { Speed } from "./speed.js";
/** `live` is never requested directly; it comes from a thread mode (see modes.ts). */
export type Admission = "force" | "background" | "live";
export const THREAD_STATES = ["idle", "running", "waiting"] as const;
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
  ownerId?: string;
  parentId: string | null;
  role?: "agent" | "conversation" | "worker";
  /** Immutable generated identity; historical threads may not have one. */
  agentName?: string;
  /** Authoritative unresolved result subscriptions; terminal acceptance removes the peer. */
  dependencies?: string[];
  title: string;
  cwd: string;
  sessionFile: string;
  settings: ThreadSettings;
  /** Actual accepted execution or next queued work; settings above are future preferences. */
  effectiveSettings?: ThreadSettings;
  admission: Admission;
  state: ThreadState;
  held: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Latest accepted person input; absent before any person input. Excludes agent sends and notifications. */
  lastUserMessageAt?: number;
  pendingMessages: number;
  executionActivity?: ExecutionActivitySnapshot & { activeTools: string[] };
  wakeSchedule?: ThreadWakeSchedule;
  waitingOnAgents?: AgentWait;
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
  dismissed?: boolean;
}
export interface QuestionReceipt { accepted: true; questionId: string }
export interface QuestionState {
  question: ThreadQuestion;
  answer?: { text: string; selectedSuggestions: string[]; dismissed: boolean; acceptedAt: number };
}
export type QuestionThread = Pick<Thread, "id" | "title" | "metadata">;
export interface PendingQuestionsQuery { locationThreadIds: string[] }
export interface PendingQuestions {
  questions: ThreadQuestion[];
  threads: QuestionThread[];
  errors: { threadId: string; message: string }[];
}
export interface QuestionEvents {
  cursor: number;
  items: Array<{ seq: number; questionId: string; threadId: string; question: string; time: number }>;
}
export interface ThreadMessage {
  id: string;
  threadId: string;
  senderId: string | null;
  senderName?: string;
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
  return input.delivery ?? "steer";
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
export type ArchivedThreadsQuery = { kind: "count" } | {
  kind: "page"; offset: number; limit: number; query?: string; conversationsOnly: boolean; order: "activity" | "archived"; revision?: string;
};
export type ArchivedThreadsResult = { kind: "count"; total: number } | { kind: "page"; total: number; revision: string; threads: Thread[] };
export interface ThreadRead { threadId: string; cursor?: string; limit?: number; entryId?: string; offset?: number }
export interface ThreadHistory { entries: Record<string, unknown>[]; nextCursor?: string }
export interface ThreadSettlement {
  seq: number;
  executionId: string;
  threadId: string;
  workId: string;
  outcome: WorkOutcome;
  /** Native turn settled, but its assignment still owns waits, dependencies or questions. */
  assignmentPending?: boolean;
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
  /** Registration probes only: historical results cannot satisfy newer unfinished work. */
  currentAssignment?: true;
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
    return { ok: false, error: { code: "invalid_request", message: "Await requires a caller and 1..100 unique accessible peer thread IDs, excluding the caller" } };
  }
  if (input.after !== undefined && (!input.after || typeof input.after !== "object" || Array.isArray(input.after)
    || Object.values(input.after).some(cursor => !Number.isSafeInteger(cursor) || cursor < 0))) {
    return { ok: false, error: { code: "invalid_request", message: "Await cursors must be nonnegative safe integers keyed by thread ID" } };
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > THREAD_AWAIT_TIMEOUT_MS)) {
    return { ok: false, error: { code: "invalid_request", message: `Await timeoutMs must be 0..${THREAD_AWAIT_TIMEOUT_MS}` } };
  }
  if (input.currentAssignment !== undefined && input.currentAssignment !== true) {
    return { ok: false, error: { code: "invalid_request", message: "currentAssignment must be true when supplied" } };
  }
  return { ok: true, value: undefined };
}
export const CONTEXT_WINDOW_MAX_BYTES = 8 * 1024 * 1024;
export interface InspectOptions {
  contextRevision?: number;
  inputReceipts?: { workIds: string[] };
  context?: "omit" | "full";
  contextWindow?: { before?: number; limit: number; generation?: string; toolCallIds?: string[]; leafId?: string };
  contextRecords?: { after?: number; before?: number; limit: number; revision?: string; includeEntries?: boolean; leafId?: string };
}
export type ThreadContextSource = {
  context: "native-history";
  path: string;
  revision: string;
  generation: string;
} & ({ kind: "native-jsonl"; size: number; leafId: string | null }
  | { kind: "unstarted"; size: 0; leafId: null });
export interface ThreadContextWindow {
  source: ThreadContextSource;
  total: number;
  records: Array<{ seq: number; count: number; entryId: string; message: Record<string, any>; results: Record<string, any>[] }>;
  knownToolCallIds: string[];
  completedToolCallIds: string[];
}
export interface ThreadContextRecords {
  source: ThreadContextWindow["source"];
  total: number;
  records: Array<{ index: number; entryId: string; message: Record<string, any>; entry?: Record<string, any> }>;
}
export function validateInspectOptions(input: unknown): Result<InspectOptions> {
  const invalid = (message: string): Result<never> => ({ ok: false, error: { code: "invalid_request", message } });
  if (input === undefined) return { ok: true, value: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("Inspection options must be an object");
  const options = input as InspectOptions;
  if (Object.keys(options).some(key => !["context", "contextRevision", "contextWindow", "contextRecords", "inputReceipts"].includes(key))) return invalid("Unknown inspection option");
  if ([options.context, options.contextWindow, options.contextRecords, options.inputReceipts].filter(value => value !== undefined).length > 1) return invalid("Context, contextWindow, contextRecords and inputReceipts are mutually exclusive");
  if (options.inputReceipts !== undefined) {
    const receipts = options.inputReceipts;
    if (!receipts || typeof receipts !== "object" || Array.isArray(receipts) || Object.keys(receipts).some(key => key !== "workIds")
      || !Array.isArray(receipts.workIds) || receipts.workIds.length < 1 || receipts.workIds.length > 64
      || receipts.workIds.some(id => typeof id !== "string" || !id.trim() || id.length > 4096)
      || new Set(receipts.workIds).size !== receipts.workIds.length) return invalid("Input receipts require 1..64 unique work IDs (1..4096 characters)");
  }
  if (options.context !== undefined && options.context !== "omit" && options.context !== "full") return invalid("Inspection context must be omit or full when specified");
  if (options.contextRevision !== undefined && options.context !== "full") return invalid("Context revision requires explicit context full");
  if (options.contextRevision !== undefined && (!Number.isSafeInteger(options.contextRevision) || options.contextRevision < 0)) return invalid("Context revision must be a nonnegative safe integer");
  if (options.contextWindow !== undefined) {
    const window = options.contextWindow;
    if (!window || typeof window !== "object" || Array.isArray(window)
      || Object.keys(window).some(key => !["before", "limit", "generation", "toolCallIds", "leafId"].includes(key))
      || !Number.isInteger(window.limit) || window.limit < 1 || window.limit > 1000
      || window.before !== undefined && (!Number.isSafeInteger(window.before) || window.before < 0)
      || window.generation !== undefined && (typeof window.generation !== "string" || !window.generation.trim())
      || window.leafId !== undefined && (typeof window.leafId !== "string" || !window.leafId.trim())
      || window.toolCallIds !== undefined && (!Array.isArray(window.toolCallIds) || window.toolCallIds.length > 64
        || window.toolCallIds.some(id => typeof id !== "string" || !id.trim() || id.length > 4096)
        || new Set(window.toolCallIds).size !== window.toolCallIds.length)) return invalid("Context window requires limit 1..1000, optional nonnegative safe before, nonempty generation/leafId, and optional 0..64 unique tool call IDs (1..4096 characters)");
  }
  if (options.contextRecords !== undefined) {
    const records = options.contextRecords;
    if (!records || typeof records !== "object" || Array.isArray(records)
      || Object.keys(records).some(key => !["after", "before", "limit", "revision", "includeEntries", "leafId"].includes(key))
      || !Number.isInteger(records.limit) || records.limit < 1 || records.limit > 32
      || records.after !== undefined && (!Number.isSafeInteger(records.after) || records.after < -1)
      || records.before !== undefined && (!Number.isSafeInteger(records.before) || records.before < 0)
      || records.after !== undefined && records.before !== undefined
      || records.includeEntries !== undefined && typeof records.includeEntries !== "boolean"
      || records.leafId !== undefined && (typeof records.leafId !== "string" || !records.leafId.trim())
      || records.revision !== undefined && (typeof records.revision !== "string" || !records.revision.trim())) return invalid("Context records require limit 1..32, optional exclusive safe after >= -1 or before >= 0, optional nonempty revision/leafId, and optional boolean includeEntries");
  }
  return { ok: true, value: options };
}
export interface ThreadInspection {
  thread: Thread;
  pending: ThreadMessage[];
  context?: Record<string, unknown>;
  contextWindow?: ThreadContextWindow;
  contextRecords?: ThreadContextRecords;
  inputReceipts?: Array<{ workId: string; landedAt: number | null }>;
  live?: Record<string, unknown>;
}
export type ThreadControl =
  | { threadId: string; action: "close" | "reopen" | "open" | "cancel" }
  | { threadId: string; action: "placement"; foreground: boolean }
  | { threadId: string; action: "dependencies"; threadIds: string[] }
  /** Owner-to-owner durable result subscription, never an execution or closure lock. */
  | { threadId: string; action: "resultSubscribe"; dependentId: string; active: boolean; after?: number }
  /** Retained callers' stop/restore act on the selected agent only; no recursive control or replay. */
  | { threadId: string; action: "stop"; descendants: boolean; reason?: "archive" }
  | { threadId: string; action: "resume" }
  /** Retained restore input: descendants/resume do not confer authority or replay work. */
  | { threadId: string; action: "restore"; descendants: boolean; resume?: boolean }
  /** Record an idle human view using the owner's clock, without changing execution activity or emitting changed. */
  | { threadId: string; action: "view" }
  | { threadId: string; action: "archiveInactive"; inactiveBefore: number }
  /** A person's title, pinned against the agent's own naming until they rename again. */
  | { threadId: string; action: "rename"; title: string }
  /** The thread's own agent naming its thread; refused while a person's rename pins the title. */
  | { threadId: string; action: "title"; title: string; taskDescription?: string }
  | { threadId: string; action: "settings"; settings: SettingsOverrides }
  /** Retry dormant waiting work on the saved model, without interrupting live native work. */
  | { threadId: string; action: "retryWaiting" }
  | { threadId: string; action: "cancelMessage"; messageId: string }
  | { threadId: string; action: "promoteMessage"; messageId: string; delivery: Delivery }
  | { threadId: string; action: "update"; title?: string; metadata?: Record<string, unknown>; archived?: boolean };
export const WAIT_KINDS = ["agents", "job", "deployment", "message"] as const;
export type WaitKind = typeof WAIT_KINDS[number];
export type WaitDependency =
  | { kind: "agents"; threadIds: [string, ...string[]]; after: Record<string, number> }
  | { kind: "job"; jobId: string }
  | { kind: "deployment"; publicationId: string }
  | { kind: "message"; fromThreadId: string };
export type AgentWait = { reason: string; since: number } & WaitDependency;
export type AgentWaitRegistration =
  | { status: "registered"; wait: AgentWait }
  | { status: "already_arrived"; settlement: ThreadSettlement }
  | { status: "resumed"; messageIds: [string, ...string[]] }
  | { status: "cleared" };
/** Current thread snapshot and immutable outcome of this request, also on retry. */
export type AgentWaitResult = Thread & { waitRegistration: AgentWaitRegistration };
export type AgentWaitRequest = { threadId: string; requestId: string } & (
  | ({ action: "set"; reason: string } & (
      // Retained pre-typed runners send concrete child waits without kind.
      | { kind?: "agents"; threadIds: string[]; after?: Record<string, number> }
      | { kind: "job"; jobId: string }
      | { kind: "deployment"; publicationId: string }
      | { kind: "message"; fromThreadId: string }))
  | { action: "clear" });
export function validateWaitDependency(input: unknown): Result<WaitDependency> {
  const invalid = (message: string): Result<WaitDependency> => ({ ok: false, error: { code: "invalid_request", message } });
  if (!input || typeof input !== "object") return invalid("A typed wait dependency is required");
  const value = input as Record<string, unknown>;
  const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
  const rejectForeign = (allowed: string[]) => Object.keys(value).some(key => !["action", "reason", "since", "threadId", "requestId", "kind", ...allowed].includes(key));
  // An old live wrapper has no kind field. Normalize only its explicit set
  // request with concrete children; all normal validation/access checks still run.
  // Never infer generic waits, external kinds, or reinterpret an explicit kind.
  if (value.kind === "agents" || value.kind === undefined && value.action === "set" && Array.isArray(value.threadIds)) {
    if (rejectForeign(["threadIds", "after"])) return invalid("An agents wait accepts only peer dependencies and cursors");
    if (!Array.isArray(value.threadIds) || value.threadIds.length < 1 || value.threadIds.length > 100
      || !value.threadIds.every(nonempty) || new Set(value.threadIds).size !== value.threadIds.length)
      return invalid("An agents wait requires 1..100 unique peer thread IDs; available for assignment is idle, not waiting");
    const ids = value.threadIds;
    const after = value.after === undefined ? {} : value.after;
    if (!after || typeof after !== "object" || Array.isArray(after)
      || Object.entries(after).some(([id, cursor]) => !ids.includes(id) || !Number.isSafeInteger(cursor) || (cursor as number) < 0))
      return invalid("Wait cursors must be nonnegative safe integers keyed only by declared peer IDs");
    return { ok: true, value: { kind: "agents", threadIds: value.threadIds as [string, ...string[]], after: after as Record<string, number> } };
  }
  if (value.kind === "job") {
    if (rejectForeign(["jobId"]) || !nonempty(value.jobId)) return invalid("A job wait requires only its stable jobId");
    return { ok: true, value: { kind: "job", jobId: value.jobId } };
  }
  if (value.kind === "deployment") {
    if (rejectForeign(["publicationId"]) || !nonempty(value.publicationId)) return invalid("A deployment wait requires only its stable publicationId");
    return { ok: true, value: { kind: "deployment", publicationId: value.publicationId } };
  }
  if (value.kind === "message") {
    if (rejectForeign(["fromThreadId"]) || !nonempty(value.fromThreadId)) return invalid("A message wait requires only its collaborator fromThreadId");
    return { ok: true, value: { kind: "message", fromThreadId: value.fromThreadId } };
  }
  return invalid("Wait kind must be agents, job, deployment or message; there is no generic wait or available-for-assignment wait");
}
export interface ThreadWakeSchedule {
  reason: string; cadenceMs: number; nextDueAt: number;
  lastDueAt?: number; lastDeliveredAt?: number; lastMessageId?: string; lastLandedAt?: number;
  deferredReason?: "stopped" | "archived" | "busy";
}
export type ThreadWakeRequest = { threadId: string } & (
  | { action: "list" }
  | { action: "set"; requestId: string; reason: string; cadenceMs: number; nextDueAt?: number }
  | { action: "cancel"; requestId: string });
export interface ThreadAttentionRequest {
  threadId: string; requestId: string; summary: string; foreground?: boolean;
}
export interface ThreadAttentionReceipt {
  accepted: true; seq: number; threadId: string; summary: string; foreground: boolean; time: number;
}
export interface ThreadAttentionEvents { cursor: number; items: ThreadAttentionReceipt[] }
export interface ThreadApi {
  attention(input: ThreadAttentionRequest): Promise<Result<ThreadAttentionReceipt>>;
  attentionEvents(after?: number, limit?: number): Result<ThreadAttentionEvents> | Promise<Result<ThreadAttentionEvents>>;
  agentWait(input: AgentWaitRequest): Promise<Result<AgentWaitResult>>;
  wakeSchedule(input: ThreadWakeRequest): Promise<Result<ThreadWakeSchedule | null>>;
  watch(input: import("./watch-list.js").WatchRequest): Promise<Result<import("./watch-list.js").WatchResponse>>;
  ask(input: AskThreadQuestions): Promise<Result<QuestionsReceipt>>;
  questions(threadId: string): Promise<Result<ThreadQuestion[]>>;
  pendingQuestions(input: PendingQuestionsQuery): Result<PendingQuestions> | Promise<Result<PendingQuestions>>;
  questionState(threadId: string, questionId: string): Promise<Result<QuestionState>>;
  questionEvents(after?: number, limit?: number): Result<QuestionEvents> | Promise<Result<QuestionEvents>>;
  answer(input: AnswerThreadQuestion): Promise<Result<QuestionReceipt>>;
  spawn(input: SpawnThread): Promise<Result<Thread>>;
  send(input: SendThread): Promise<Result<ThreadMessage>>;
  list(input?: ThreadList): Promise<Result<ThreadPage>>;
  archived(input: ArchivedThreadsQuery): Promise<Result<ArchivedThreadsResult>>;
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
  /** Reserve execution capacity, or release it while retaining an idle native session. */
  setActive?(active: boolean): Promise<void>;
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
