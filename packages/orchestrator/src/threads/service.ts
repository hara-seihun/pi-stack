import { validateArchivedQuery } from "./archived.js";
import type { ArchivedThreadsQuery, ArchivedThreadsResult } from "./contracts.js";
import { isRunnerCapacityFailure } from "./runner-capacity.js";
import { RunnerStartupError, isPooledStartupWait } from "./runner-startup.js";
import { parseRuntimeEvent, requireAssistantStopReason, assertNever } from "./runtime-events.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { indexedThreadHistory, withIndexedThreadHistory, timestampMs, type IndexedThreadHistory, type MessageRecordDescriptor, type RecordDescriptor, type ThreadHistoryError } from "pi-orchestrator/history";
import { contentText } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "../sqlite.js";
import { configuredAgentCapacity } from "../agent-capacity.js";
import { ThreadCapacityLedger } from "./capacity-ledger.js";
import { isRunContext } from "../isolated-context-contract.js";
import { isCompactionFailure, isModelConfigurationError, isRateLimitError, isTransientFailure, transientRetryAt } from "../provider-errors.js";
import { POOLED_ACCOUNT_WAIT, pooledRetryAvailability } from "../extension/routing.js";
import { modelBrokerUrl } from "../model-broker-contract.js";
import { resolveSpawnSettings, resolveThreadSettings, validateThreadSettings } from "./settings.js";
import { getRandomName } from "../nebulani-names.js";
import { threadSettingsMetadata } from "./settings-metadata.js";
import { isTelephoneContext, TELEPHONE_CONTEXT_ARGUMENT } from "./telephone-context.js";
import { inputReceipts } from "./pi-input-receipts.js";
import type { InputStatus } from "./pi-input-status.js";
import { measureJsonBytes } from "./json-size.js";
import { MetadataCache } from "./metadata-cache.js";
import { finalText, formatThreadMessage, serializeThreadNotification } from "./message-format.js";
import { projectAnthropicNarrationMessage } from "pi-orchestrator/anthropic-narration";
import { readMessageDeliveryTimezone } from "./message-delivery.js";
import { RAW_ARGUMENT, SANDBOX_ARGUMENT, SANDBOX_POLICY_ARGUMENT, sandboxPolicy, validSandboxBoundary } from "./pi-raw.js";
import { isThreadModeName, threadMode } from "./modes.js";
import type { ThreadCapability } from "./caller.js";
import { isThreadState, resolveDelivery, validateInspectOptions, validateThreadAwait, validateWaitDependency, CONTEXT_WINDOW_MAX_BYTES, THREAD_AWAIT_TIMEOUT_MS, type ThreadContextRecords, type ThreadContextWindow } from "./contracts.js";
import { parseRunnerWaitDependency } from "./wait-contract.js";
import { threadHasOutstandingWork } from "./work-state.js";
import { BACKGROUND_ATTENTION_POLICY } from "./attention-policy.js";
import { createExecutionActivity, executionActivitySnapshot, executionWaitActivity, observeExecutionActivity, restoreExecutionActivity, settleExecutionActivity, type ExecutionActivity, type ExecutionPhase } from "./execution-activity.js";
import { deriveThreadLifecycle } from "./lifecycle.js";
import { MANAGER_INACTIVITY_MS, MANAGER_WATCHDOG_PREFIX, hasManagedWork, type ManagerWorkSummary, type ManagerWatchObservation } from "./manager-watchdog.js";
import type { AnswerThreadQuestion, AskThreadQuestions, QuestionsReceipt, QuestionReceipt, QuestionEvents, QuestionState, ThreadQuestion, AttachPiSession, AwaitThreads, Delivery, OpenPiSession, PiCommand, PiEvent, PiSession, Result, SendThread, SpawnThread, Thread, ThreadApi, ThreadAwaitResult, ThreadControl, ThreadError, ThreadHistory, ThreadInspection, InspectOptions, ThreadList, ThreadMessage, ThreadPage, ThreadRead, ThreadSettings, ThreadSettlement, ThreadSettlements, WorkOutcome } from "./contracts.js";

import type { PendingQuestions, PendingQuestionsQuery, ManagerQuestionsRequest, ManagerQuestionsResponse, HeldThreadQuestion, ManagerQuestionCustodyRequest, ManagerQuestionCustodyReceipt } from "./contracts.js";

type Json = Record<string, any>;
type NativeContextRecord<D extends RecordDescriptor = MessageRecordDescriptor> = { kind: "native"; descriptor: D } | { kind: "receipt"; entry: Json };
type QuestionAnswerDescriptor = { questionId: string; timestamp: number; entryId: string };
type NativeWindowMetadata = {
  source: ThreadContextWindow["source"]; total: number; keyHash: string;
  codes: Int32Array; seqs: Float64Array; counts: Uint32Array; length: number;
  calls: Map<string, number>; results: Map<number, number[]>;
};
type NativeContextMetadata = {
  key: string; bytes: number; receiptHash: string; receipts: QuestionAnswerDescriptor[];
  messages: Int32Array; entries?: Int32Array; window?: NativeWindowMetadata;
};
export function settledWorkOutcome(outcome: unknown, message: Json | null | undefined): WorkOutcome {
  if (outcome === "complete" || outcome === "failed" || outcome === "cancelled") return outcome;
  if (outcome !== undefined) throw new Error(`Unknown work outcome: ${String(outcome)}`);
  // A native completion receipt can finish a turn without producing an assistant message.
  if (message === null || message === undefined) return "complete";
  const reason = requireAssistantStopReason(message.stopReason);
  switch (reason) {
    case "stop": case "length": case "toolUse": return "complete";
    case "error": return "failed";
    case "aborted": return "cancelled";
    case "pending": case "deferred": throw new Error(`Cannot settle nonterminal assistant state: ${reason}`);
  }
  return assertNever(reason);
}
export interface ThreadAdmission { env?: Record<string, string | undefined>; settings?: ThreadSettings; release(): void | Promise<void> }
export interface ThreadServiceOptions {
  databasePath: string;
  sessionsDir: string;
  openSession: OpenPiSession;
  attachSession?: AttachPiSession;
  recoverSession?: (threadId: string, output: (event: PiEvent) => void, exit: (code: number | null) => void) => Promise<PiSession | null>;
  workersOnly?: boolean;
  capacity?: import("../agent-capacity.js").AgentCapacity | { mode: "unmanaged" };
  admitNewThread?: (settings: ThreadSettings) => Result<void>;
  /** Owning person's implicit model for NEW spawns only. Explicit choices and accepted receipts win. */
  spawnDefaultModel?: () => string | undefined;
  environment?: (thread: Thread) => Record<string, string | undefined>;
  admit?: (thread: Thread, settings: ThreadSettings, recovering: boolean, executionId: string) => Promise<Result<ThreadAdmission>>;
  prepareMessage?: (thread: Thread, message: ThreadMessage) => Promise<Result<{ text: string; images?: unknown[] }>>;
  retireIdleSession?: (thread: Thread) => boolean;
  onChange?: (thread: Thread) => void;
  managerNotificationPolicy?: () => Result<import("./contracts.js").ManagerNotificationPolicy> | Promise<Result<import("./contracts.js").ManagerNotificationPolicy>>;
  routeManagerQuestionCustody?: (input: ManagerQuestionCustodyRequest) => Promise<Result<ManagerQuestionCustodyReceipt>>;
  /** Issues each session's PI_THREAD_TOKEN, which its tools present to thread owners. */
  capability?: ThreadCapability;
}
export type ThreadServiceEvent = { threadId: string; event: PiEvent } | { threadId: string; type: "changed" };
export type PendingMessage = Omit<ThreadMessage, "state" | "insertedAt" | "landedAt"> & { state: "queued" | "dispatched"; insertedAt: number | null; landedAt: number | null };
export interface ImportThread {
  id: string; parentId?: string | null; title: string; cwd: string; sessionFile: string;
  settings: ThreadSettings; admission?: "force" | "background"; held?: boolean;
  createdAt?: number; updatedAt?: number; metadata?: Record<string, unknown>;
}
export interface ImportMessage {
  /** Only known authenticated input provenance; absent historical provenance stays unknown. */
  humanActivity?: boolean;
  id: string; threadId: string; requestId?: string; senderId?: string | null; text: string; images?: unknown[];
  delivery?: Delivery; source?: "explicit" | "notification"; replyTo?: string; createdAt?: number;
  state?: "queued" | "dispatched" | "done"; insertedAt?: number; outcome?: WorkOutcome;
  executionId?: string; finalMessage?: Record<string, unknown> | null; settings?: ThreadSettings;
}
class NativeRejection extends Error {
  constructor(message: string, readonly code: ThreadError["code"] = "unavailable") { super(message); }
}
class AcknowledgementTimeout extends Error {}
class AdmissionWait extends Error {}
function inputCommandReceipt(value: unknown): [string, string] | undefined {
  if (typeof value !== "string" || !value.startsWith("thread-input:")) return;
  try {
    const parts: unknown = JSON.parse(value.slice("thread-input:".length));
    if (Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === "string")) return parts as [string, string];
  } catch { return; }
}
interface Runtime {
  session?: PiSession; epoch: string; executionId?: string; lease?: ThreadAdmission; busy: boolean; settings?: ThreadSettings; environmentKey?: string; parked?: boolean;
  finalMessage?: Json; outcome?: WorkOutcome; broker?: boolean; commandRunning?: string; commandNumber: number; waiters: Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | undefined }>;
}
const good = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = <T = never>(code: ThreadError["code"], message: string): Result<T> => ({ ok: false, error: { code, message } });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const historyFailure = (error: ThreadHistoryError): Result<never> => {
  switch (error.code) {
    case "stale-source": return bad("conflict", error.message);
    case "oversized-record": case "oversized-index": return bad("oversized", error.message);
    case "invalid-descriptor": return bad("invalid_request", error.message);
    case "missing": case "io": case "invalid-record": case "invalid-branch": return bad("unavailable", error.message);
  }
};
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const resultExecutionId = (id: string, recipientId: string): string | null => {
  const prefix = "thread-result:", suffix = `:${recipientId}`;
  return id.startsWith(prefix) && id.endsWith(suffix) && id.length > prefix.length + suffix.length
    ? id.slice(prefix.length, -suffix.length) : null;
};
/** Stored schedules may carry delivery timestamps that nothing reads. */
function wakeSchedule(data: string): import("./contracts.js").ThreadWakeSchedule {
  const { reason, cadenceMs, nextDueAt, lastMessageId } = JSON.parse(data);
  return { reason, cadenceMs, nextDueAt, ...(lastMessageId ? { lastMessageId } : {}) };
}
type WaitResultEvidence = { wait?: import("./contracts.js").AgentWait; settlement: ThreadSettlement | null };
const resumesDependency = (dependency: import("./contracts.js").WaitDependency, message: Pick<ThreadMessage, "senderId" | "source">): boolean =>
  message.source !== "notification" || !!message.senderId && (dependency.kind === "agents" && dependency.threadIds.includes(message.senderId)
    || dependency.kind === "message" && dependency.fromThreadId === message.senderId);
const questionAnswerBody = (row: Json, answer: Pick<AnswerThreadQuestion, "selectedSuggestionIds" | "text" | "dismissed">): string => {
  if (answer.dismissed) return `Dismissed question ${row.id}: ${row.question}\nThe user skipped this question without selecting or authorizing any suggestion.`;
  const choices = JSON.parse(row.suggestions) as ThreadQuestion["suggestions"];
  return [`Answer to question ${row.id}: ${row.question}`, ...answer.selectedSuggestionIds.map(id => `- ${choices.find(choice => choice.id === id)!.text}`), ...(answer.text.trim() ? [answer.text] : [])].join("\n");
};
const mergeTimed = (items: Json[], additions: Json[]): Json[] => {
  if (!additions.length) return items;
  const result = [...items];
  const time = (item: Json): number => typeof item.timestamp === "number" ? item.timestamp : Date.parse(item.timestamp ?? "") || 0;
  for (const addition of additions) {
    const next = result.findIndex(item => time(item) > time(addition));
    result.splice(next < 0 ? result.length : next, 0, addition);
  }
  return result;
};

export class ThreadService implements ThreadApi {
  private readonly db: DatabaseSync;
  private readonly capacityLedger?: ThreadCapacityLedger;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly halts = new Map<string, Promise<Result<Thread>>>();
  private readonly opening = new Map<string, Promise<Runtime>>();
  private readonly attaching = new Map<string, Promise<Runtime | undefined>>();
  private readonly dependencyOperations = new Map<string, Promise<Result<void>>>();
  private readonly waitRegistering = new Set<string>();
  private readonly listeners = new Set<(event: ThreadServiceEvent) => void>();
  private readonly awaiting = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private suspended = false;
  private directory?: ThreadApi & { owners?: readonly { id: string; api: ThreadApi }[] };
  private managerWatchdog?: { observe: () => Promise<Result<ManagerWatchObservation>>; onError: (message: string | null) => void };
  private managerWatchdogRunning = false;
  private managerWatchdogApproved: string | null = null;
  setManagerWatchdog(observe: () => Promise<Result<ManagerWatchObservation>>, onError: (message: string | null) => void): void {
    this.managerWatchdog = { observe, onError };
  }
  private watchList?: import("./watch-list.js").WatchApi;
  setWatchList(watchList: import("./watch-list.js").WatchApi): void { this.watchList = watchList; }
  async watch(input: import("./watch-list.js").WatchRequest): Promise<Result<import("./watch-list.js").WatchResponse>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (this.watchList) return this.watchList.watch(input);
    if (this.options.workersOnly && this.directory) return this.directory.watch(input);
    return bad("unavailable", "This person has no unlocked watch list owner");
  }
  private workerOwner?: (parent: Thread, input: SpawnThread) => ThreadApi | undefined;
  private routing = false;
  private custodyRouting = false;
  private custodyQueued = false;
  private questionResolutionRunning = false;
  private transactionDepth = 0;
  private readonly projections = new Map<string, { live: Json; activity: ExecutionActivity }>();
  private readonly nativeContexts = new MetadataCache<NativeContextMetadata>(32, 64 * 1024 * 1024);
  // Compiling SQL is the expensive half of a small query, and the supervisor
  // reads threads thousands of times a second while projecting its inbox. The
  // schema is settled before the first cached statement, so a statement can
  // live as long as the connection.
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private sql(text: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.statements.get(text);
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement); }
    return statement;
  }

  constructor(private readonly options: ThreadServiceOptions) {
    if (options.capacity && "mode" in options.capacity && options.capacity.mode !== "unmanaged") throw new Error("Invalid explicit agent capacity mode");
    if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true });
    mkdirSync(options.sessionsDir, { recursive: true });
    this.db = openSqlite(options.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS thread (
        id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, cwd TEXT NOT NULL, session_file TEXT NOT NULL,
        settings TEXT NOT NULL, admission TEXT NOT NULL, state TEXT NOT NULL, held INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
      CREATE UNIQUE INDEX IF NOT EXISTS thread_manager ON thread(json_extract(metadata,'$.manager')) WHERE json_extract(metadata,'$.manager')=1;
      CREATE INDEX IF NOT EXISTS thread_parent ON thread(parent_id,updated_at);
      CREATE INDEX IF NOT EXISTS thread_created ON thread(created_at,id);
      CREATE INDEX IF NOT EXISTS thread_live_created ON thread(created_at,id) WHERE json_extract(metadata,'$.archived') IS NOT 1;
      CREATE INDEX IF NOT EXISTS thread_archived ON thread(id) WHERE json_extract(metadata,'$.archived')=1;
      CREATE INDEX IF NOT EXISTS thread_running ON thread(id,json_extract(metadata,'$.laneId'),json_extract(metadata,'$.execution')) WHERE state='running';
      CREATE INDEX IF NOT EXISTS thread_native_custody ON thread(id) WHERE json_extract(metadata,'$.runnerReference') IS NOT NULL;
      CREATE TABLE IF NOT EXISTS thread_work (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
        sender_id TEXT, text TEXT NOT NULL, images TEXT NOT NULL, delivery TEXT NOT NULL, source TEXT NOT NULL,
        reply_to TEXT, status TEXT NOT NULL DEFAULT 'queued', front INTEGER NOT NULL DEFAULT 0,
        settings TEXT NOT NULL, prepared TEXT, execution_id TEXT, created_at INTEGER NOT NULL, inserted_at INTEGER,
        landed_at INTEGER, outcome TEXT, final_message TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS thread_work_queue ON thread_work(thread_id,status,front DESC,ordinal);
      CREATE INDEX IF NOT EXISTS thread_work_unfinished ON thread_work(thread_id) WHERE status!='done';
      CREATE TABLE IF NOT EXISTS thread_human_activity (
        work_id TEXT PRIMARY KEY REFERENCES thread_work(id), thread_id TEXT NOT NULL REFERENCES thread(id), created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS thread_human_recency ON thread_human_activity(thread_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS thread_human_latest ON thread_human_activity(created_at DESC);
      CREATE TABLE IF NOT EXISTS thread_execution (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES thread(id), work_id TEXT NOT NULL,
        settings TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, settlement_seq INTEGER UNIQUE, outcome TEXT, final_message TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS thread_request (id TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, response TEXT);
      CREATE TABLE IF NOT EXISTS thread_assignment_reply (work_id TEXT PRIMARY KEY REFERENCES thread_work(id), execution_id TEXT NOT NULL REFERENCES thread_execution(id));
      CREATE TABLE IF NOT EXISTS thread_wake (thread_id TEXT PRIMARY KEY REFERENCES thread(id), generation TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_watchdog (
        thread_id TEXT PRIMARY KEY REFERENCES thread(id), last_human_at INTEGER,
        next_due_at INTEGER, sequence INTEGER NOT NULL CHECK(sequence>=0), paused_at INTEGER);
      UPDATE thread_work SET status='done',outcome='cancelled' WHERE status='queued' AND id IN (
        SELECT json_extract(data,'$.lastMessageId') FROM thread_wake WHERE thread_id IN (SELECT id FROM thread WHERE json_extract(metadata,'$.manager')=1)
        AND json_extract(data,'$.cadenceMs')=14400000
        AND json_extract(data,'$.reason')='Managing Kenan heartbeat: consider the person''s current needs and held questions; speak only when there is something useful to say.');
      DELETE FROM thread_wake WHERE thread_id IN (SELECT id FROM thread WHERE json_extract(metadata,'$.manager')=1)
        AND json_extract(data,'$.cadenceMs')=14400000
        AND json_extract(data,'$.reason')='Managing Kenan heartbeat: consider the person''s current needs and held questions; speak only when there is something useful to say.';
      CREATE TABLE IF NOT EXISTS thread_context_generation (
        thread_id TEXT PRIMARY KEY REFERENCES thread(id), generation TEXT NOT NULL,
        key_count INTEGER NOT NULL CHECK(key_count>=0), key_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_question (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES thread(id), question TEXT NOT NULL,
        suggestions TEXT NOT NULL, recommended_id TEXT, created_at INTEGER NOT NULL,
        answer TEXT, accepted_at INTEGER);
      CREATE TABLE IF NOT EXISTS thread_attention (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES thread(id), summary TEXT NOT NULL, foreground INTEGER NOT NULL, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_question_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL UNIQUE REFERENCES thread_question(id));
      CREATE TABLE IF NOT EXISTS thread_question_route (
        question_id TEXT PRIMARY KEY REFERENCES thread_question(id), manager_id TEXT NOT NULL,
        deadline_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','forwarded','released')), forwarded_id TEXT REFERENCES thread_question(id));
      CREATE INDEX IF NOT EXISTS thread_question_route_due ON thread_question_route(deadline_at) WHERE state='held';
      CREATE TABLE IF NOT EXISTS thread_question_unresolved (
        question_id TEXT PRIMARY KEY REFERENCES thread_question(id), deadline_at INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS thread_question_origin (question_id TEXT PRIMARY KEY REFERENCES thread_question(id), thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_question_custody_outbox (request_id TEXT PRIMARY KEY, data TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS thread_question_link (
        original_id TEXT PRIMARY KEY REFERENCES thread_question(id), forwarded_id TEXT NOT NULL REFERENCES thread_question(id));
      INSERT OR IGNORE INTO thread_question_event(question_id) SELECT id FROM thread_question WHERE accepted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM thread_question_route r WHERE r.question_id=thread_question.id AND r.state='held')
        AND NOT EXISTS(SELECT 1 FROM thread_question_origin o WHERE o.question_id=thread_question.id)
        AND NOT EXISTS(SELECT 1 FROM thread_question_unresolved u WHERE u.question_id=thread_question.id) ORDER BY created_at,rowid;
      CREATE INDEX IF NOT EXISTS thread_question_pending ON thread_question(thread_id,created_at) WHERE accepted_at IS NULL;
      DROP INDEX IF EXISTS thread_execution_active;
      UPDATE thread SET state='idle',held=1 WHERE state='stopped';
      UPDATE thread SET metadata=json_set(metadata,'$.peerDependencies',json_extract(metadata,'$.agentWait.threadIds'))
        WHERE json_extract(metadata,'$.peerDependencies') IS NULL AND json_type(metadata,'$.agentWait.threadIds')='array';
      UPDATE thread SET metadata=json_set(metadata,'$.peerDependencies',json_array(json_extract(metadata,'$.agentWait.fromThreadId')))
        WHERE json_extract(metadata,'$.peerDependencies') IS NULL AND json_type(metadata,'$.agentWait.fromThreadId')='text';
      UPDATE thread_work SET status='dispatched' WHERE status IN ('dispatching','inserted');
      UPDATE thread SET metadata=json_set(metadata,'$.peerDependencies',json_extract(metadata,'$.dependencyUpdate.desired'))
        WHERE json_type(metadata,'$.dependencyUpdate.desired')='array';
      UPDATE thread SET metadata=json_set(metadata,'$.dependencyUpdate',json_object('previous',json_extract(metadata,'$.peerDependencies'),'desired',json_extract(metadata,'$.peerDependencies')))
        WHERE json_array_length(json_extract(metadata,'$.peerDependencies'))>0 AND json_extract(metadata,'$.dependencyUpdate') IS NULL;`);
    const generationSchema = this.sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='thread_context_generation'").get() as { sql: string };
    if (/CHECK\s*\(\s*key_count\s*>=\s*1\s*\)/i.test(generationSchema.sql)) this.transaction(() => {
      // A new or empty native history has zero presentation keys. Preserve existing identities atomically.
      this.db.exec(`CREATE TABLE thread_context_generation_migration (
        thread_id TEXT PRIMARY KEY REFERENCES thread(id), generation TEXT NOT NULL,
        key_count INTEGER NOT NULL CHECK(key_count>=0), key_hash TEXT NOT NULL);
        INSERT INTO thread_context_generation_migration SELECT * FROM thread_context_generation;
        DROP TABLE thread_context_generation;
        ALTER TABLE thread_context_generation_migration RENAME TO thread_context_generation;`);
    });
    this.transaction(() => {
      const unnamed = this.sql("SELECT id,metadata FROM thread WHERE json_type(metadata,'$.agentName') IS NOT 'text' OR trim(json_extract(metadata,'$.agentName'))=''").all() as Array<{ id: string; metadata: string }>;
      for (const row of unnamed) {
        const metadata = { ...JSON.parse(row.metadata), agentName: getRandomName() };
        this.sql("UPDATE thread SET metadata=? WHERE id=?").run(JSON.stringify(metadata), row.id);
      }
    });
    this.db.exec(`UPDATE thread_work SET source='notification' WHERE sender_id IS NULL AND source='explicit'
      AND id IN (SELECT r.id FROM thread_request r JOIN thread t ON t.id=r.target WHERE r.kind='spawn'
        AND (json_extract(t.metadata,'$.watchList')=1 OR json_extract(t.metadata,'$.createdBy.kind') IN ('runtime','process','thread')));`);
    const executionColumns = this.sql("PRAGMA table_info(thread_execution)").all() as { name: string }[];
    if (!executionColumns.some(column => column.name === "retry_settings")) this.db.exec("ALTER TABLE thread_execution ADD COLUMN retry_settings TEXT");
    if (!executionColumns.some(column => column.name === "assignment_pending")) this.db.exec("ALTER TABLE thread_execution ADD COLUMN assignment_pending INTEGER NOT NULL DEFAULT 0");
    if (executionColumns.some(column => column.name === "state")) this.db.exec("ALTER TABLE thread_execution DROP COLUMN state");
    if (!(this.sql("PRAGMA table_info(thread_work)").all() as { name: string }[]).some(column => column.name === "input_origin")) {
      this.transaction(() => this.db.exec(`ALTER TABLE thread_work ADD COLUMN input_origin TEXT CHECK(input_origin IN ('human','machine'));
        UPDATE thread_work SET input_origin=CASE
          WHEN EXISTS(SELECT 1 FROM thread_human_activity h WHERE h.work_id=thread_work.id) THEN 'human'
          WHEN sender_id IS NOT NULL OR source='notification' THEN 'machine'
          ELSE NULL END;`));
    }
    if (!(this.sql("PRAGMA table_info(thread_work)").all() as { name: string }[]).some(column => column.name === "priority")) this.db.exec("ALTER TABLE thread_work ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1,2))");
    this.db.exec(`UPDATE thread_work SET priority=CASE WHEN EXISTS(SELECT 1 FROM thread_human_activity h WHERE h.work_id=thread_work.id) THEN 2 ELSE 1 END,
      delivery=CASE WHEN id LIKE 'thread-wake:manager-inactivity:%' THEN delivery ELSE 'steer' END,
      front=CASE WHEN id LIKE 'thread-wake:manager-inactivity:%' THEN front ELSE 0 END WHERE thread_id IN (SELECT id FROM thread WHERE json_extract(metadata,'$.manager')=1) AND status='queued';
      DROP INDEX IF EXISTS thread_work_queue;
      CREATE INDEX thread_work_queue ON thread_work(thread_id,status,priority DESC,front DESC,ordinal);`);
    if (!(this.sql("PRAGMA table_info(thread_work)").all() as { name: string }[]).some(column => column.name === "sender_name")) this.db.exec("ALTER TABLE thread_work ADD COLUMN sender_name TEXT");
    if (!(this.sql("PRAGMA table_info(thread_work)").all() as { name: string }[]).some(column => column.name === "landed_at")) this.db.exec("ALTER TABLE thread_work ADD COLUMN landed_at INTEGER; UPDATE thread_work SET landed_at=inserted_at WHERE status='dispatched' AND inserted_at IS NOT NULL");
    this.db.exec(`CREATE INDEX IF NOT EXISTS thread_execution_settlements ON thread_execution(thread_id,ended_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS thread_execution_await ON thread_execution(thread_id,settlement_seq);
      CREATE UNIQUE INDEX IF NOT EXISTS thread_execution_active ON thread_execution(thread_id) WHERE ended_at IS NULL;
      UPDATE thread SET state=CASE
        WHEN json_extract(metadata,'$.runnerReference') IS NOT NULL OR EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=thread.id AND e.ended_at IS NULL) THEN 'running'
        WHEN held=1 THEN 'idle'
        WHEN EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=thread.id AND w.status!='done') OR state IN ('starting','running','stopping') THEN 'running'
        ELSE 'idle' END WHERE state NOT IN ('idle','running');`);
    const capacity = options.capacity;
    this.capacityLedger = capacity && "mode" in capacity && capacity.mode === "unmanaged" ? undefined
      : new ThreadCapacityLedger(this.db, capacity && !("mode" in capacity) ? capacity : configuredAgentCapacity());
  }

  private transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth++, savepoint = `thread_import_${depth}`;
    try {
      this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      try { const result = operation(); this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT"); return result; }
      catch (error) { this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK"); throw error; }
    } finally { this.transactionDepth--; }
  }
  private static readonly THREAD_COLUMNS = "t.*,(SELECT MAX(created_at) FROM thread_human_activity w WHERE w.thread_id=t.id) last_user_message_at,(SELECT data FROM thread_wake s WHERE s.thread_id=t.id) wake_data,(SELECT count(*) FROM thread_work w INDEXED BY thread_work_unfinished WHERE w.thread_id=t.id AND w.status!='done') pending_count,(SELECT created_at FROM thread_execution e WHERE e.thread_id=t.id AND e.ended_at IS NULL) active_execution_at,(SELECT min(created_at) FROM thread_work w WHERE w.thread_id=t.id AND w.status='queued') queued_at";
  private row(id: string): Json | undefined { return this.sql(`SELECT ${ThreadService.THREAD_COLUMNS} FROM thread t WHERE id=?`).get(id) as Json | undefined; }
  private project(row: Json): Thread {
    const pending = row.pending_count ?? (this.sql("SELECT count(*) n FROM thread_work INDEXED BY thread_work_unfinished WHERE thread_id=? AND status!='done'").get(row.id) as { n: number }).n;
    const projection = this.projections.get(row.id);
    const metadata = JSON.parse(row.metadata);
    if (metadata.foreground === undefined) metadata.foreground = !(this.options.workersOnly || row.parent_id || metadata.watchList || metadata.laneId);
    const wait = row.state === "running" ? executionWaitActivity(metadata) : undefined;
    const observed = row.state === "running" && !row.active_execution_at && pending && projection?.activity.activity === "finishing" ? undefined : projection?.activity;
    const resuming = observed?.activity && !["waiting_for_capacity", "waiting_to_retry", "queued", "admitting", "starting", "recovering", "preparing"].includes(observed.activity)
      && (observed.lastActivityAt ?? 0) > (wait?.lastActivityAt ?? wait?.activitySince ?? Infinity);
    const fallback = row.held ? "cancelling" : metadata.runnerReference || row.active_execution_at || !pending ? "recovering" : "queued";
    const executionActivity = row.state !== "running" ? undefined : wait && !resuming ? { ...wait, activeTools: [] }
      : { ...(observed?.activity ? executionActivitySnapshot(observed) : { activity: fallback as ExecutionPhase,
        activitySince: row.queued_at ?? row.active_execution_at ?? row.updated_at,
        activityDetail: fallback === "queued" ? "Waiting for execution dispatch" : fallback === "recovering" ? "Reattaching the retained execution" : "Awaiting cancellation confirmation" }),
        activeTools: projection?.live.tools.map((tool: Json) => String(tool.toolName)) ?? [] };
    const deferred = executionActivity?.activity === "waiting_for_capacity" || executionActivity?.activity === "waiting_to_retry";
    const executionSince = row.active_execution_at ?? (this.runtimes.get(row.id)?.busy ? row.updated_at : null);
    const lifecycle = deriveThreadLifecycle({
      archived: metadata.archived === true, cancelling: !!row.held,
      execution: executionSince === null ? null : { since: executionSince, activity: executionActivity ?? {} },
      pending: pending ? { since: row.queued_at ?? row.updated_at } : null,
      delay: deferred ? { target: executionActivity!.activity === "waiting_for_capacity" ? "capacity" : "retry", since: executionActivity!.activitySince ?? row.updated_at, reason: executionActivity!.activityDetail?.trim() || (executionActivity!.activity === "waiting_for_capacity" ? "Waiting for capacity" : "Waiting to retry") } : null,
      dependency: metadata.agentWait ?? null, subscriptions: metadata.peerDependencies ?? [],
      error: typeof metadata.executionError === "string" ? metadata.executionError : null, updatedAt: row.updated_at,
    });
    return { lifecycle, executionActivity, ...(metadata.agentWait ? { waitingOnAgents: metadata.agentWait } : {}), ...(row.wake_data ? { wakeSchedule: wakeSchedule(row.wake_data) } : {}), id: row.id, parentId: row.parent_id, role: "agent", agentName: metadata.agentName, dependencies: metadata.peerDependencies ?? [], title: row.title, cwd: row.cwd, sessionFile: row.session_file,
      settings: JSON.parse(row.settings), effectiveSettings: this.effectiveSettings(row.id), admission: row.admission, state: row.state === "idle" && !row.held && !metadata.archived && (metadata.agentWait || metadata.peerDependencies?.length) ? "waiting" : row.state, held: !!row.held, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, ...(row.last_user_message_at !== null ? { lastUserMessageAt: row.last_user_message_at } : {}), pendingMessages: pending, metadata };
  }
  get(id: string): Thread | null { const row = this.row(id); return row ? this.project(row) : null; }
  /** Every thread, or with `archived: false` only the ones still in play; archived threads outnumber live ones many times over on a long-lived account. */
  snapshot(options: { archived?: boolean } = {}): Thread[] {
    const where = options.archived === false ? " WHERE json_extract(t.metadata,'$.archived') IS NOT 1" : "";
    return (this.sql(`SELECT ${ThreadService.THREAD_COLUMNS} FROM thread t${where} ORDER BY created_at,id`).all() as Json[]).map(row => this.project(row));
  }
  runningSummary(): { total: number; lanes: Map<string, number>; repairOwner?: string } {
    const rows = this.sql("SELECT id,json_extract(metadata,'$.laneId') lane_id,json_extract(metadata,'$.execution') execution FROM thread WHERE state='running'").all() as { id: string; lane_id: string | null; execution: string | null }[];
    const lanes = new Map<string, number>();
    let repairOwner: string | undefined;
    for (const row of rows) {
      if (row.lane_id) lanes.set(row.lane_id, (lanes.get(row.lane_id) ?? 0) + 1);
      if (row.execution === "root-repair") repairOwner ??= row.id;
    }
    return { total: rows.length, lanes, repairOwner };
  }
  async managerWorkSummary(): Promise<Result<ManagerWorkSummary>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    const human = this.sql("SELECT MAX(created_at) time FROM thread_human_activity").get() as { time: number | null };
    const activeWork = this.snapshot({ archived: false }).some(thread => {
      if (!hasManagedWork(thread)) return false;
      if (thread.metadata?.manager !== true) return true;
      const work = this.sql(`SELECT id FROM thread_work WHERE thread_id=? AND status!='done'
        UNION SELECT work_id id FROM thread_execution WHERE thread_id=? AND ended_at IS NULL`).all(thread.id, thread.id) as { id: string }[];
      return !work.length || work.some(item => !item.id.startsWith(MANAGER_WATCHDOG_PREFIX));
    });
    return good({ activeWork, lastHumanMessageAt: human.time });
  }
  /** Counts each live lane owner once; a hold releases its queue only after cancellation is confirmed. */
  laneCustody(): Map<string, number> {
    const rows = this.sql(`SELECT json_extract(t.metadata,'$.laneId') lane_id,count(*) n FROM (
      SELECT id FROM thread INDEXED BY thread_running WHERE state='running'
      UNION SELECT thread_id FROM thread_execution INDEXED BY thread_execution_active WHERE ended_at IS NULL
      UNION SELECT w.thread_id FROM thread_work w INDEXED BY thread_work_unfinished CROSS JOIN thread queued_thread ON queued_thread.id=w.thread_id WHERE w.status!='done' AND queued_thread.held=0
      UNION SELECT id FROM thread INDEXED BY thread_native_custody WHERE json_extract(metadata,'$.runnerReference') IS NOT NULL
    ) custody CROSS JOIN thread t ON t.id=custody.id
    WHERE json_extract(t.metadata,'$.laneId') IS NOT NULL GROUP BY lane_id`).all() as { lane_id: string; n: number }[];
    return new Map(rows.map(row => [row.lane_id, row.n]));
  }
  archivedCount(): number { return (this.sql("SELECT count(*) n FROM thread WHERE json_extract(metadata,'$.archived')=1").get() as { n: number }).n; }
  settlements(after = 0, limit = 100): Result<ThreadSettlements> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) return bad("invalid_request", "Invalid settlement cursor or limit");
    const rows = this.sql("SELECT * FROM thread_execution WHERE settlement_seq>? ORDER BY settlement_seq LIMIT ?").all(after, limit) as Json[];
    return good({ items: rows.map(row => ({ seq: row.settlement_seq, executionId: row.id, threadId: row.thread_id, workId: row.work_id, outcome: row.outcome, ...(row.assignment_pending ? { assignmentPending: true } : {}), time: row.ended_at, finalMessage: JSON.parse(row.final_message ?? "null"), ...(row.error ? { error: row.error } : {}) })), cursor: rows.at(-1)?.settlement_seq ?? after });
  }
  settlementFor(threadId: string, workId: string): Result<ThreadSettlement | null> {
    const row = this.sql("SELECT * FROM thread_execution WHERE thread_id=? AND work_id=? AND settlement_seq IS NOT NULL ORDER BY settlement_seq DESC LIMIT 1").get(threadId, workId) as Json | undefined;
    return good(row ? { seq: row.settlement_seq, executionId: row.id, threadId: row.thread_id, workId: row.work_id, outcome: row.outcome, time: row.ended_at, finalMessage: JSON.parse(row.final_message ?? "null"), ...(row.error ? { error: row.error } : {}) } : null);
  }
  async await(input: AwaitThreads, signal?: AbortSignal): Promise<Result<ThreadAwaitResult>> {
    const valid = validateThreadAwait(input); if (!valid.ok) return valid;
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (signal?.aborted) return bad("unavailable", "Thread await cancelled");
    const ids = new Set(input.threadIds);
    for (const id of ids) {
      const thread = this.get(id);
      if (!thread) return bad("not_found", `Thread ${id} was not found`);

    }
    const cursors = Object.fromEntries(input.threadIds.map(id => [id, input.after && Object.hasOwn(input.after, id) ? input.after[id]! : 0]));
    const query = JSON.stringify(cursors);
    const response = (settlement: ThreadSettlement | null): Result<ThreadAwaitResult> => good({
      settlement,
      remainingThreadIds: input.threadIds.filter(id => id !== settlement?.threadId),
      after: { ...input.after, ...cursors, ...(settlement ? { [settlement.threadId]: settlement.seq } : {}) },
    });
    const completed = (): ThreadSettlement | null => {
      const rows = this.sql(`SELECT e.* FROM json_each(?) target JOIN thread_execution e ON e.thread_id=target.key
        JOIN thread t ON t.id=e.thread_id WHERE e.settlement_seq>target.value AND e.assignment_pending=0
        AND (?=0 OR e.settlement_seq=(SELECT MAX(latest.settlement_seq) FROM thread_execution latest WHERE latest.thread_id=e.thread_id))
        ORDER BY e.settlement_seq LIMIT ?`).all(query, input.currentAssignment ? 1 : 0, input.currentAssignment ? input.threadIds.length : 1) as Json[];
      const row = rows.find(candidate => !input.currentAssignment || this.currentAssignmentResult(candidate));
      return row ? { seq: row.settlement_seq, executionId: row.id, threadId: row.thread_id, workId: row.work_id,
        outcome: row.outcome, time: row.ended_at, finalMessage: JSON.parse(row.final_message ?? "null"), ...(row.error ? { error: row.error } : {}) } : null;
    };
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Result<ThreadAwaitResult>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(changed);
        this.awaiting.delete(suspended);
        signal?.removeEventListener("abort", aborted);
        resolve(result);
      };
      const check = () => {
        try { const settlement = completed(); if (settlement) finish(response(settlement)); }
        catch (error) { finish(bad("unavailable", errorText(error))); }
      };
      const changed = (event: ThreadServiceEvent) => { if (ids.has(event.threadId)) check(); };
      const suspended = () => finish(bad("unavailable", "Thread controller is suspended"));
      const aborted = () => finish(bad("unavailable", "Thread await cancelled"));
      this.listeners.add(changed);
      this.awaiting.add(suspended);
      signal?.addEventListener("abort", aborted, { once: true });
      check();
      if (!settled) timer = setTimeout(() => { check(); if (!settled) finish(response(null)); }, input.timeoutMs ?? THREAD_AWAIT_TIMEOUT_MS);
    });
  }
  private currentAssignmentResult(row: Json): boolean {
    const thread = this.get(row.thread_id);
    if (!thread || row.assignment_pending) return false;
    const latest = this.sql("SELECT MAX(settlement_seq) seq FROM thread_execution WHERE thread_id=?").get(thread.id) as { seq: number | null };
    if (latest.seq !== row.settlement_seq) return false;
    if (row.outcome === "cancelled" && (thread.metadata?.cancellationRequest || thread.metadata?.archived)) return true;
    if (thread.state !== "idle" || thread.metadata?.agentWait || thread.wakeSchedule || thread.dependencies?.length) return false;
    return !this.sql(`SELECT 1 FROM thread_execution WHERE thread_id=? AND ended_at IS NULL
      UNION ALL SELECT 1 FROM thread_work WHERE thread_id=? AND status!='done'
      UNION ALL SELECT 1 FROM thread_question WHERE thread_id=? AND accepted_at IS NULL LIMIT 1`).get(thread.id, thread.id, thread.id);
  }
  live(id: string): Json | undefined { return this.projections.get(id)?.live; }
  latestSettlement(id: string): import("./contracts.js").ThreadSettlement | null {
    const row = this.sql("SELECT * FROM thread_execution WHERE thread_id=? AND ended_at IS NOT NULL ORDER BY ended_at DESC,settlement_seq DESC,id DESC LIMIT 1").get(id) as Json | undefined;
    return row ? { seq: row.settlement_seq ?? 0, executionId: row.id, threadId: row.thread_id, workId: row.work_id, outcome: row.outcome, ...(row.assignment_pending ? { assignmentPending: true } : {}), time: row.ended_at, finalMessage: JSON.parse(row.final_message ?? "null"), ...(row.error ? { error: row.error } : {}) } : null;
  }
  private inputState(row: Json): import("./contracts.js").ThreadInputState {
    return { id: row.id, threadId: row.thread_id, senderId: row.sender_id, delivery: row.delivery, source: row.source, state: row.status,
      priority: row.priority === 2 ? "human" : row.priority === 1 ? "manager" : "normal",
      createdAt: row.created_at, insertedAt: row.inserted_at, landedAt: row.landed_at, ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.error ? { error: row.error } : {}) };
  }
  private inputReceipt(threadId: string, inputId: string): import("./contracts.js").ThreadInputState | undefined {
    const row = this.sql("SELECT id,thread_id,sender_id,delivery,source,status,priority,created_at,inserted_at,landed_at,outcome,error FROM thread_work WHERE thread_id=? AND id=?").get(threadId, inputId) as Json | undefined;
    return row ? this.inputState(row) : undefined;
  }
  inputStates(id: string): import("./contracts.js").ThreadInputState[] {
    return (this.sql("SELECT id,thread_id,sender_id,delivery,source,status,priority,created_at,inserted_at,landed_at,outcome,error FROM thread_work WHERE thread_id=? ORDER BY ordinal DESC LIMIT 60").all(id) as Json[]).reverse().map(row => this.inputState(row));
  }
  async inspect(id: string, options: InspectOptions = {}): Promise<Result<ThreadInspection>> {
    const valid = validateInspectOptions(options);
    if (!valid.ok) return valid;
    if (typeof id !== "string" || !id.trim()) return bad("invalid_request", "A thread ID is required");
    const thread = this.get(id); if (!thread) return bad("not_found", "Thread not found");
    const projection = this.projections.get(id);
    const state = { thread, pending: this.pending(id), inputs: this.inputStates(id), ...(projection ? { live: projection.live } : {}) };
    if (options.inputReceipts) {
      const ids = options.inputReceipts.workIds;
      const rows = this.sql(`SELECT id,landed_at FROM thread_work WHERE thread_id=? AND id IN (${ids.map(() => "?").join(",")})`).all(id, ...ids) as Array<{ id: string; landed_at: number | null }>;
      const receipts = new Map(rows.map(row => [row.id, { workId: row.id, landedAt: row.landed_at }]));
      if (ids.some(id => !receipts.has(id))) return bad("not_found", "Requested input receipt does not belong to this thread");
      return this.boundedInspection({ ...state, inputReceipts: ids.map(id => receipts.get(id)!) });
    }
    if (options.context === "omit") return good(state);
    if (options.contextWindow) {
      const window = this.nativeContextWindow(thread, options.contextWindow);
      if (!window.ok) return window;
      return this.boundedInspection({ ...state, contextWindow: window.value });
    }
    if (options.contextRecords) {
      const page = this.nativeContextRecords(thread, options.contextRecords);
      if (!page.ok) return page;
      return this.boundedInspection({ ...state, contextRecords: page.value });
    }
    if (options.context !== "full") return good(state);
    const active = !!this.execution(id) || thread.state === "running";
    if (!active && options.contextRevision === thread.revision) return good(state);
    if (!active) return this.fullInspection(thread, state);
    return this.serial(id, async () => {
      if (this.suspended || this.closed) return bad("unavailable", "Thread controller is suspended");
      try {
        const runtime = this.runtimes.get(id) ?? (thread.metadata?.runnerReference ? await this.attach(id) : undefined);
        if (!runtime?.session) return bad("unavailable", "Current context requires a reachable native runtime");
        const current = await this.rpc(runtime, { type: "get_context" });
        if (!current || typeof current !== "object" || !Array.isArray(current.messages)
          || typeof current.systemPrompt !== "string" || !Array.isArray(current.tools)) return bad("unavailable", "Runtime returned an invalid current context");
        return this.fullInspection(thread, state, current);
      } catch (error) { return bad(error instanceof NativeRejection ? error.code : "unavailable", errorText(error)); }
    });
  }
  private inputOrigin(threadId: string, workId: string): "human" | "machine" | undefined {
    const row = this.sql("SELECT input_origin FROM thread_work WHERE thread_id=? AND id=?").get(threadId, workId) as { input_origin: "human" | "machine" | null } | undefined;
    return row?.input_origin ?? undefined;
  }
  private historyInputOrigins(threadId: string): Record<string, "human" | "machine"> {
    const rows = this.sql("SELECT id,input_origin FROM thread_work WHERE thread_id=? AND input_origin IS NOT NULL ORDER BY id").all(threadId) as Array<{ id: string; input_origin: "human" | "machine" }>;
    return Object.fromEntries(rows.map(row => [row.id, row.input_origin]));
  }
  private nativeMessageIdentity(thread: Thread, entry: Json, message: Json): Json {
    if (message.role !== "user" && message.role !== "assistant") return message;
    const inputOrigin = message.role === "user" ? message.inputOrigin ?? (message.inputId ? this.inputOrigin(thread.id, message.inputId) : undefined) : undefined;
    if (inputOrigin) message = { ...message, inputOrigin };
    if (inputOrigin === "machine") {
      const timestamp = timestampMs(message.timestamp) ?? timestampMs(entry.timestamp);
      const machine = { ...message }; delete machine.identity;
      return { ...machine, ...(timestamp === undefined ? {} : { identity: {
        id: ["pi", thread.id, entry.id].map(encodeURIComponent).join("/"), timestamp, sender: { id: "machine", name: "Machine" },
      } }) };
    }
    const metadata = entry.type === "message" ? entry.message : entry.details;
    const identity = metadata?.identity;
    const senderValue = (value: unknown): Json | undefined => {
      if (!value || typeof value !== "object") return;
      const sender = value as Json;
      if (typeof sender.id !== "string" || !sender.id.trim()) return;
      return { id: sender.id, ...(typeof sender.name === "string" && sender.name ? { name: sender.name } : {}) };
    };
    const recorded = senderValue(identity?.sender);
    if (recorded && typeof identity.id === "string" && /^(pi\/[^/]+\/[^/]+|messaging\/[^/]+|slack\/[^/]+\/[^/]+\/[^/]+)$/.test(identity.id)
      && Number.isFinite(identity.timestamp)) return { ...message, identity: { id: identity.id, timestamp: identity.timestamp, sender: recorded } };
    const env = { ...process.env, ...this.options.environment?.(thread) };
    const owner = env.PI_REMOTE_SENDER_ID ?? thread.ownerId;
    const sender = recorded ?? senderValue(metadata?.sender) ?? (message.role === "assistant" ? { id: "assistant", name: "Kenan" }
      : env.PI_REMOTE_ROOM_ID || !owner ? undefined : { id: owner, ...(env.PI_REMOTE_SENDER_NAME ? { name: env.PI_REMOTE_SENDER_NAME } : {}) });
    const timestamp = timestampMs(message.timestamp) ?? timestampMs(entry.timestamp);
    if (!sender || timestamp === null || timestamp === undefined) return message;
    return { ...message, identity: { id: ["pi", thread.id, entry.id].map(encodeURIComponent).join("/"), timestamp, sender } };
  }
  private boundedInspection(inspection: ThreadInspection): Result<ThreadInspection> {
    const measured = measureJsonBytes(good(inspection), CONTEXT_WINDOW_MAX_BYTES);
    return measured.ok ? good(inspection) : measured;
  }
  private fullInspection(thread: Thread, state: Omit<ThreadInspection, "context">, active?: Json): Result<ThreadInspection> {
    let history: IndexedThreadHistory | undefined;
    if (!active) {
      const indexed = indexedThreadHistory(thread.sessionFile);
      if (!indexed.ok) {
        if (indexed.error.code !== "missing" || thread.metadata?.nativeHistoryRequired === true) return historyFailure(indexed.error);
      } else history = indexed.value;
    }
    const messages: Json[] = [];
    const inspection: ThreadInspection = { ...state, context: { ...(active ?? { source: "native-history", systemPrompt: "", tools: [] }), messages } };
    const header = measureJsonBytes(good(inspection), CONTEXT_WINDOW_MAX_BYTES);
    if (!header.ok) return header;
    let bytes = header.value;
    const append = (message: Json): Result<void> => {
      const measured = measureJsonBytes(message, CONTEXT_WINDOW_MAX_BYTES - bytes - Number(messages.length > 0));
      if (!measured.ok) return measured;
      bytes += measured.value + Number(messages.length > 0);
      messages.push(message);
      return good(undefined);
    };
    if (active) {
      if (active.messages !== undefined && !Array.isArray(active.messages)) return bad("invalid_request", "Active context messages must be an array");
      const receipts = this.questionAnswerSource(thread.id);
      const questions = new Set(receipts.map(receipt => receipt.questionId));
      let nextReceipt = 0;
      const receipt = (): Result<void> => {
        const read = this.questionAnswerSourceMessage(thread.id, receipts[nextReceipt++]!.entryId);
        return read.ok ? append(read.value) : read;
      };
      for (const message of active.messages ?? []) {
        if (!message || typeof message !== "object") return bad("invalid_request", "Active context messages must be JSON objects");
        if (message.rootConsent === true && questions.has(message.questionId)) continue;
        const stamp = timestampMs(message.timestamp) ?? 0;
        while (nextReceipt < receipts.length && receipts[nextReceipt]!.timestamp < stamp) {
          const accepted = receipt(); if (!accepted.ok) return accepted;
        }
        const accepted = append(message); if (!accepted.ok) return accepted;
      }
      while (nextReceipt < receipts.length) { const accepted = receipt(); if (!accepted.ok) return accepted; }
    } else {
      const { projected } = this.nativeContextProjection(thread.id, history?.messages ?? []);
      for (const source of projected) {
        let message: Json;
        if (source.kind === "receipt") {
          const receipt = this.questionAnswerEntryById(thread.id, source.entry.id);
          if (!receipt.ok) return receipt;
          message = receipt.value.message;
        } else {
          const read = history!.read(source.descriptor);
          if (!read.ok) return historyFailure(read.error);
          const entry = read.value;
          message = entry.type === "message" ? entry.message : { role: "custom", content: entry.content, customType: entry.customType, details: entry.details };
        }
        const accepted = append(message); if (!accepted.ok) return accepted;
      }
    }
    return good(inspection);
  }
  private nativeContextProjection<D extends RecordDescriptor>(threadId: string, messages: readonly D[]): { projected: NativeContextRecord<D>[]; receiptHash: string } {
    const receipts = this.questionAnswerSource(threadId).map(receipt => ({
      type: "message", id: receipt.entryId, message: { role: "user", timestamp: receipt.timestamp, questionId: receipt.questionId, rootConsent: true },
    }));
    const projected: NativeContextRecord<D>[] = messages
      .filter(descriptor => !receipts.some(receipt => "rootConsent" in descriptor && descriptor.rootConsent === true && "questionId" in descriptor && descriptor.questionId === receipt.message.questionId))
      .map(descriptor => ({ kind: "native", descriptor }));
    const receiptKeys = createHash("sha256");
    for (const entry of receipts) {
      const stamp = timestampMs(entry.message.timestamp) ?? 0;
      const key = JSON.stringify([entry.id, stamp]);
      receiptKeys.update(String(Buffer.byteLength(key))).update(":").update(key);
      const next = projected.findIndex(record => (timestampMs(record.kind === "native" ? record.descriptor.timestamp : record.entry.message.timestamp) ?? 0) > stamp);
      projected.splice(next < 0 ? projected.length : next, 0, { kind: "receipt", entry });
    }
    return { projected, receiptHash: receiptKeys.digest("hex") };
  }
  private nativeContextLayout(descriptors: readonly RecordDescriptor[], receipts: readonly QuestionAnswerDescriptor[]): Int32Array {
    const layout = new Int32Array(descriptors.length + receipts.length);
    const questions = new Set(receipts.map(receipt => receipt.questionId));
    let length = 0, nextReceipt = 0;
    for (let index = 0; index < descriptors.length; index++) {
      const descriptor = descriptors[index]!;
      if ("rootConsent" in descriptor && descriptor.rootConsent === true && "questionId" in descriptor && questions.has(descriptor.questionId as string)) continue;
      const stamp = timestampMs(descriptor.timestamp) ?? 0;
      while (nextReceipt < receipts.length && receipts[nextReceipt]!.timestamp < stamp) layout[length++] = -++nextReceipt;
      layout[length++] = index;
    }
    while (nextReceipt < receipts.length) layout[length++] = -++nextReceipt;
    return layout.subarray(0, length);
  }
  private nativeContextMetadata(thread: Thread, history: IndexedThreadHistory): NativeContextMetadata {
    const receipts = this.questionAnswerSource(thread.id);
    const hash = createHash("sha256");
    for (const receipt of receipts) {
      const encoded = JSON.stringify([receipt.entryId, receipt.timestamp]);
      hash.update(String(Buffer.byteLength(encoded))).update(":").update(encoded);
    }
    const receiptHash = hash.digest("hex");
    const key = digest({ source: history.source.revision, path: history.source.path, leafId: history.source.leafId, receipts: receiptHash, presentation: history.presentationRevision });
    const cached = this.nativeContexts.get(thread.id, key);
    if (cached) return cached;
    const messages = this.nativeContextLayout(history.messages, receipts);
    const bytes = 1024 + thread.id.length * 2 + messages.buffer.byteLength
      + receipts.reduce((sum, receipt) => sum + 128 + (receipt.entryId.length + receipt.questionId.length) * 2, 0);
    const metadata: NativeContextMetadata = { key, bytes, receiptHash, receipts, messages };
    this.nativeContexts.set(thread.id, key, metadata, bytes);
    return metadata;
  }
  private unstartedContextSource(thread: Thread): ThreadContextWindow["source"] {
    const generation = digest({ unstarted: thread.id, path: thread.sessionFile });
    return { kind: "unstarted", context: "native-history", path: thread.sessionFile,
      generation, revision: generation, size: 0, leafId: null };
  }
  private nativeContextRecords(thread: Thread, request: NonNullable<InspectOptions["contextRecords"]>): Result<ThreadContextRecords> {
    const indexed = indexedThreadHistory(thread.sessionFile, request.leafId, { inputOrigins: this.historyInputOrigins(thread.id) });
    if (!indexed.ok) {
      if (indexed.error.code !== "missing" || thread.metadata?.nativeHistoryRequired === true || request.leafId !== undefined) return historyFailure(indexed.error);
      const source = this.unstartedContextSource(thread);
      if (request.revision !== undefined && request.revision !== source.revision) return bad("conflict", "Native context source revision changed; restart the context export");
      return good({ source, total: 0, records: [] });
    }
    const history = indexed.value;
    const includeEntries = request.includeEntries === true;
    const metadata = this.nativeContextMetadata(thread, history);
    if (includeEntries && !metadata.entries) {
      metadata.entries = this.nativeContextLayout(history.entries, metadata.receipts);
      metadata.bytes += metadata.entries.buffer.byteLength;
      this.nativeContexts.set(thread.id, metadata.key, metadata, metadata.bytes);
    }
    const projected = includeEntries ? metadata.entries! : metadata.messages;
    const revision = digest({ native: history.source.revision, leafId: history.source.leafId, receipts: metadata.receiptHash, presentation: history.presentationRevision, includeEntries });
    if (request.revision !== undefined && request.revision !== revision) return bad("conflict", "Native context source revision changed; restart the context export");
    const records: ThreadContextRecords["records"] = [];
    const end = request.before === undefined ? Math.min(projected.length, (request.after ?? -1) + 1 + request.limit) : Math.min(projected.length, request.before);
    const start = request.before === undefined ? (request.after ?? -1) + 1 : Math.max(0, end - request.limit);
    let bytes = 2;
    for (let index = start; index < end; index++) {
      const code = projected[index]!;
      let entry: Json;
      let inputId: string | undefined;
      if (code < 0) {
        const receipt = this.questionAnswerEntryById(thread.id, metadata.receipts[-code - 1]!.entryId);
        if (!receipt.ok) return receipt;
        entry = receipt.value;
      } else {
        const read = history.read((includeEntries ? history.entries : history.messages)[code]!);
        if (!read.ok) return historyFailure(read.error);
        entry = read.value;
        inputId = ((includeEntries ? history.entries : history.messages)[code] as RecordDescriptor & { inputId?: string }).inputId;
      }
      const inputState = inputId === undefined ? undefined : this.inputReceipt(thread.id, inputId);
      const message = entry.type === "message" ? inputId !== undefined && entry.message?.role === "user" ? { ...entry.message, inputId, ...(inputState ? { inputState } : {}) } : entry.message
        : entry.type === "custom_message" ? { role: "custom", content: entry.content, customType: entry.customType, details: entry.details }
        : { role: "notice", content: entry, timestamp: timestampMs(entry.timestamp) };
      const record = { index, entryId: entry.id, message: this.nativeMessageIdentity(thread, entry, message), ...(includeEntries ? { entry } : {}) };
      const measured = measureJsonBytes(record, CONTEXT_WINDOW_MAX_BYTES - bytes);
      if (!measured.ok) return measured;
      bytes += measured.value + 1;
      records.push(record);
    }
    return good({ source: { ...history.source, revision, context: "native-history" }, total: projected.length, records });
  }
  private nativeWindowMetadata(thread: Thread, history: IndexedThreadHistory, metadata: NativeContextMetadata): NativeWindowMetadata {
    if (metadata.window) return metadata.window;
    const calls = new Map<string, number>();
    const paired = new Set<number>();
    const results = new Map<number, number[]>();
    for (let index = 0; index < history.messages.length; index++) {
      const descriptor = history.messages[index]!;
      if (descriptor.toolResultId !== null) {
        const call = calls.get(descriptor.toolResultId);
        if (call !== undefined) {
          paired.add(index);
          const attached = results.get(call) ?? [];
          attached.push(index); results.set(call, attached);
        }
      }
      if (descriptor.role === "assistant") for (const callId of descriptor.toolCallIds) calls.set(callId, index);
    }
    const codes = new Int32Array(metadata.messages.length);
    const seqs = new Float64Array(metadata.messages.length);
    const counts = new Uint32Array(metadata.messages.length);
    let total = 0, length = 0;
    for (const code of metadata.messages) {
      const count = code < 0 ? 1 : paired.has(code) ? 0 : history.messages[code]!.displayedItemCount;
      if (!count) continue;
      codes[length] = code; seqs[length] = total; counts[length++] = count; total += count;
    }
    const previous = this.sql("SELECT generation,key_count,key_hash FROM thread_context_generation WHERE thread_id=?").get(thread.id) as { generation: string; key_count: number; key_hash: string } | undefined;
    const keys = createHash("sha256");
    let keyCount = 0;
    let prefixHash: string | undefined = previous?.key_count === 0 ? keys.copy().digest("hex") : undefined;
    const key = (parts: unknown[]) => {
      const encoded = JSON.stringify(parts);
      keys.update(String(Buffer.byteLength(encoded))).update(":").update(encoded);
      keyCount++;
      if (previous && keyCount === previous.key_count) prefixHash = keys.copy().digest("hex");
    };
    for (let index = 0; index < length; index++) {
      const code = codes[index]!, count = counts[index]!;
      if (code < 0) { key([metadata.receipts[-code - 1]!.entryId, "user"]); continue; }
      const descriptor = history.messages[code]!;
      if (descriptor.role !== "assistant" || !descriptor.blocks.length) { key([descriptor.id, descriptor.role, descriptor.monoVisibility ?? null, descriptor.inputOrigin ?? null]); continue; }
      let emitted = 0;
      for (const block of descriptor.blocks) {
        if (!block.displayed || emitted >= count) continue;
        key([descriptor.id, descriptor.role, block.index, block.type, block.toolCallId ?? null, descriptor.monoVisibility ?? null]); emitted++;
      }
      for (; emitted < count; emitted++) key([descriptor.id, descriptor.role, "projected", emitted, descriptor.monoVisibility ?? null]);
    }
    const keyHash = keys.digest("hex");
    const generation = previous && total >= previous.key_count && prefixHash === previous.key_hash ? previous.generation : randomUUID();
    if (!previous || previous.key_count !== keyCount || previous.key_hash !== keyHash) {
      this.sql(`INSERT INTO thread_context_generation(thread_id,generation,key_count,key_hash) VALUES(?,?,?,?)
        ON CONFLICT(thread_id) DO UPDATE SET generation=excluded.generation,key_count=excluded.key_count,key_hash=excluded.key_hash`).run(thread.id, generation, keyCount, keyHash);
    }
    const source: ThreadContextWindow["source"] = { ...history.source, generation, revision: digest({ native: history.source.revision, keys: keyHash }), context: "native-history" };
    const window: NativeWindowMetadata = { source, total, keyHash, codes, seqs, counts, length, calls, results };
    metadata.window = window;
    metadata.bytes += 1024 + source.path.length * 2 + (source.leafId?.length ?? 0) * 2 + codes.buffer.byteLength + seqs.buffer.byteLength + counts.buffer.byteLength;
    for (const id of calls.keys()) metadata.bytes += 128 + id.length * 2;
    for (const indices of results.values()) metadata.bytes += 128 + indices.length * 8;
    this.nativeContexts.set(thread.id, metadata.key, metadata, metadata.bytes);
    return window;
  }
  private nativeContextWindow(thread: Thread, request: NonNullable<InspectOptions["contextWindow"]>): Result<ThreadContextWindow> {
    const projected = withIndexedThreadHistory(thread.sessionFile, request.leafId, { managerWakeVisibility: thread.metadata?.manager === true, inputOrigins: this.historyInputOrigins(thread.id) },
      history => this.projectNativeContextWindow(thread, request, history));
    if (!projected.ok) {
      if (projected.error.code !== "missing" || thread.metadata?.nativeHistoryRequired === true || request.leafId !== undefined) return historyFailure(projected.error);
      const source = this.unstartedContextSource(thread);
      if (request.generation !== undefined && request.generation !== source.generation) return bad("conflict", "Context source generation changed; reopen the transcript window");
      return good({ source, total: 0, records: [], knownToolCallIds: [], completedToolCallIds: [] });
    }
    return projected.value;
  }
  private projectNativeContextWindow(thread: Thread, request: NonNullable<InspectOptions["contextWindow"]>, history: IndexedThreadHistory): Result<ThreadContextWindow> {
    const metadata = this.nativeContextMetadata(thread, history);
    const window = this.nativeWindowMetadata(thread, history, metadata);
    const { total, calls, results } = window;
    if (request.generation !== undefined && request.generation !== window.source.generation) return bad("conflict", "Context source generation changed; reopen the transcript window");
    const before = Math.min(request.before ?? total, total);
    const start = Math.max(0, before - request.limit);
    const records: ThreadContextWindow["records"] = [];
    let bytes = Buffer.byteLength(JSON.stringify(records));
    const message = (entry: Json): Json => entry.type === "message" ? entry.message : { role: "custom", content: entry.content, customType: entry.customType, details: entry.details };
    let low = 0, high = window.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (window.seqs[middle]! + window.counts[middle]! <= start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < window.length && window.seqs[index]! < before; index++) {
      const code = window.codes[index]!;
      let sourceMessage: Json;
      const attached: Json[] = [];
      let entryId: string;
      if (code < 0) {
        entryId = metadata.receipts[-code - 1]!.entryId;
        const receipt = this.questionAnswerEntryById(thread.id, entryId);
        if (!receipt.ok) return receipt;
        sourceMessage = receipt.value.message;
      } else {
        const descriptor = history.messages[code]!;
        const entry = history.read(descriptor);
        if (!entry.ok) return historyFailure(entry.error);
        sourceMessage = message(entry.value);
        if (descriptor.inputOrigin) sourceMessage = { ...sourceMessage, inputOrigin: descriptor.inputOrigin };
        const inputId = (descriptor as MessageRecordDescriptor & { inputId?: string }).inputId;
        if (inputId !== undefined && sourceMessage.role === "user") {
          const inputState = this.inputReceipt(thread.id, inputId);
          sourceMessage = { ...sourceMessage, inputId, ...(inputState ? { inputState } : {}) };
        }
        sourceMessage = this.nativeMessageIdentity(thread, entry.value, sourceMessage);
        entryId = descriptor.id;
        const selectedCalls = new Set<string>();
        let ordinal = 0;
        for (const block of descriptor.blocks) {
          if (!block.displayed) continue;
          const seq = window.seqs[index]! + ordinal++;
          if (seq >= start && seq < before && block.toolCallId !== undefined) selectedCalls.add(block.toolCallId);
        }
        for (const result of results.get(code) ?? []) {
          const descriptor = history.messages[result]!;
          if (descriptor.toolResultId === null || !selectedCalls.has(descriptor.toolResultId)) continue;
          const entry = history.read(descriptor);
          if (!entry.ok) return historyFailure(entry.error);
          const resultMessage = message(entry.value);
          const measured = measureJsonBytes(resultMessage, CONTEXT_WINDOW_MAX_BYTES - bytes);
          if (!measured.ok) return measured;
          attached.push(resultMessage);
          bytes += measured.value + 1;
        }
      }
      const monoVisibility = code < 0 ? undefined : history.messages[code]!.monoVisibility;
      const selected = { seq: window.seqs[index]!, count: window.counts[index]!, entryId, message: sourceMessage, results: attached, ...(monoVisibility ? { monoVisibility } : {}) };
      const measured = measureJsonBytes({ ...selected, results: [] }, CONTEXT_WINDOW_MAX_BYTES - bytes);
      if (!measured.ok) return measured;
      bytes += measured.value + 1;
      records.push(selected);
    }
    const monoLiveVisibility = history.messages.at(-1)?.monoVisibility;
    return good({ source: { ...window.source }, total, records, ...(monoLiveVisibility ? { monoLiveVisibility } : {}),
      knownToolCallIds: (request.toolCallIds ?? []).filter(id => calls.has(id)),
      completedToolCallIds: (request.toolCallIds ?? []).filter(id => { const call = calls.get(id); return call !== undefined && results.get(call)?.some(index => history.messages[index]!.toolResultId === id); }) });
  }
  private message(row: Json): ThreadMessage { return { priority: row.priority === 2 ? "human" : row.priority === 1 ? "manager" : "normal", id: row.id, threadId: row.thread_id, senderId: row.sender_id, ...(row.sender_name || row.sender_id && this.get(row.sender_id)?.agentName ? { senderName: row.sender_name ?? this.get(row.sender_id)!.agentName } : {}), text: row.text, images: JSON.parse(row.images), delivery: row.delivery, source: row.source, state: row.status, createdAt: row.created_at, insertedAt: row.inserted_at, landedAt: row.landed_at, ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.reply_to ? { replyTo: row.reply_to } : {}) }; }
  pending(id: string): PendingMessage[] {
    return this.sql("SELECT * FROM thread_work WHERE thread_id=? AND status!='done' ORDER BY priority DESC,front DESC,ordinal").all(id).map(row => this.message(row as Json) as PendingMessage);
  }
  /** Pi holds a steer or follow-up in its queue until a tool boundary, then starts it as a user message with the exact text it was sent. */
  private land(id: string, text: string): void {
    const works = this.sql("SELECT * FROM thread_work WHERE thread_id=? AND status='dispatched' AND landed_at IS NULL AND prepared IS NOT NULL ORDER BY ordinal").all(id) as Json[];
    const work = works.find(work => formatThreadMessage(this.message(work), JSON.parse(work.prepared).text) === text);
    if (work && this.sql("UPDATE thread_work SET landed_at=? WHERE id=? AND landed_at IS NULL").run(Date.now(), work.id).changes) this.changed(id);
  }
  subscribe(listener: (event: ThreadServiceEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setDirectory(directory: ThreadApi, workerOwner?: (parent: Thread, input: SpawnThread) => ThreadApi | undefined): void { this.directory = directory; this.workerOwner = workerOwner; }
  private changed(id: string): void {
    if (this.suspended || this.closed) return;
    // Invalidate even same-millisecond work; a view belongs to this settled version only.
    this.sql("UPDATE thread SET revision=revision+1,updated_at=?,metadata=json_remove(metadata,'$.autoArchiveViewedAt') WHERE id=?").run(Date.now(), id);
    const thread = this.get(id); if (thread) this.options.onChange?.(thread);
    for (const listener of this.listeners) listener({ threadId: id, type: "changed" });
  }
  private phase(id: string, activity: ExecutionPhase, activityDetail: string): void {
    if (this.closed || this.suspended) return;
    const projection = this.projections.get(id) ?? { live: { text: "", thinking: "", isThinking: false, tools: [] }, activity: createExecutionActivity() };
    this.projections.set(id, projection);
    const event = { type: "owner_execution_phase", activity, activityDetail, emittedAt: Date.now() };
    observeExecutionActivity(projection.activity, event);
    Object.assign(projection.live, executionActivitySnapshot(projection.activity));
    for (const listener of this.listeners) listener({ threadId: id, event });
  }
  private state(id: string, state: Thread["state"]): void {
    if (this.suspended || this.closed) return;
    const projection = this.projections.get(id);
    if (state !== "running" && projection) {
      settleExecutionActivity(projection.activity);
      Object.assign(projection.live, executionActivitySnapshot(projection.activity), { isThinking: false, tools: [] });
    }
    const changed = this.sql("UPDATE thread SET state=?,metadata=CASE WHEN ?='running' THEN json_remove(metadata,'$.executionError') ELSE metadata END WHERE id=? AND (state!=? OR (?='running' AND json_extract(metadata,'$.executionError') IS NOT NULL))").run(state, state, id, state, state).changes;
    if (changed) this.changed(id);
  }
  /** Record why a queued thread could not be admitted. Reconcile retries it, so this is a wait, not a settlement. */
  private admissionWait(id: string, error: ThreadError): void {
    if (this.suspended || this.closed) return;
    const existing = this.get(id)?.metadata?.admissionWait as Json | undefined;
    const wait = { code: error.code, message: error.message, model: this.effectiveSettings(id)?.model ?? this.get(id)?.settings.model, since: existing?.message === error.message ? existing.since : Date.now(), observedAt: Date.now(), ...(error.retryAt ? { retryAt:error.retryAt } : {}) };
    this.sql("UPDATE thread SET metadata=json_set(metadata,'$.admissionWait',json(?)) WHERE id=?").run(JSON.stringify(wait), id);
    const evidence = executionWaitActivity(this.get(id)?.metadata)!;
    this.phase(id, evidence.activity!, evidence.activityDetail!);
    if (existing?.message !== error.message || existing?.retryAt !== error.retryAt) this.changed(id);
  }
  private clearAdmissionWait(id: string): void {
    if (this.suspended || this.closed) return;
    const cleared = this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.admissionWait') WHERE id=? AND json_extract(metadata,'$.admissionWait') IS NOT NULL").run(id).changes;
    if (cleared) this.changed(id);
  }
  private async acquireCapacity(id: string, executionId: string, sourceId: string, kind: "work" | "command"): Promise<Result<void>> {
    if (!this.capacityLedger) return good(undefined);
    const acquired = await this.capacityLedger.acquire(id, executionId, sourceId, kind);
    return acquired.ok ? good(undefined) : acquired;
  }
  private capacityReleaseEvidence(id: string, result: Result<void>): void {
    if (this.closed || this.suspended) return;
    if (result.ok) this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.capacityRelease') WHERE id=?").run(id);
    else this.sql("UPDATE thread SET metadata=json_set(metadata,'$.capacityRelease',json(?)) WHERE id=?").run(JSON.stringify(result.error), id);
  }
  private async releaseCapacity(id: string, executionId?: string): Promise<void> {
    if (!this.capacityLedger) return;
    const execution = this.execution(id);
    if (executionId) this.capacityLedger.retain(id, executionId, execution?.work_id ?? executionId, "work");
    else if (!execution && this.get(id)?.metadata?.runnerReference) this.capacityLedger.retain(id, `native-census:${id}`, `native-census:${id}`, "command");
    this.capacityReleaseEvidence(id, await this.capacityLedger.release(id, executionId));
  }
  private async releaseUnenteredCapacity(id: string, executionId: string): Promise<void> {
    if (this.capacityLedger) this.capacityReleaseEvidence(id, await this.capacityLedger.releaseUnentered(id, executionId));
  }
  private async releaseFailedStartupCapacity(id: string): Promise<void> {
    if (!this.capacityLedger || this.execution(id) || this.runtimes.has(id) || this.opening.has(id) || this.get(id)?.metadata?.runnerReference) return;
    const failure = this.get(id)?.metadata?.startupFailure as Json | undefined;
    if (failure?.nativeNotReady !== true || typeof failure.workId !== "string" || !/^(?:Error: )*Pi cwd admission rejected thread\.cwd:/.test(String(failure.error))) return;
    const work = this.sql(`SELECT w.id FROM thread_work w JOIN thread_execution e ON e.id=w.execution_id
      WHERE w.thread_id=? AND w.id=? AND w.status='done' AND w.outcome='failed' AND w.inserted_at IS NULL AND w.landed_at IS NULL
      AND e.thread_id=w.thread_id AND e.work_id=w.id AND e.ended_at IS NOT NULL AND e.outcome='failed' AND e.error=?`).get(id, failure.workId, failure.error);
    if (!work) return;
    for (const row of this.capacityLedger.current(id)) {
      if (row.kind === "work" && row.source_id === failure.workId) await this.releaseCapacity(id, row.logical_execution_id);
    }
  }
  private async recoverMissingStartupCapacity(id: string): Promise<void> {
    if (!this.capacityLedger || !this.options.recoverSession || this.execution(id) || this.runtimes.has(id) || this.opening.has(id) || this.get(id)?.metadata?.runnerReference) return;
    if (!this.capacityLedger.current(id).some(row => row.entered_native && row.state !== "releasing")) return;
    const runtime = await this.attach(id, true);
    if (!runtime) await this.releaseCapacity(id);
  }
  private async recoverUnassignedCapacity(id: string): Promise<boolean> {
    await this.releaseFailedStartupCapacity(id);
    await this.recoverMissingStartupCapacity(id);
    if (this.capacityLedger && !this.execution(id) && this.get(id)?.metadata?.runnerReference && !this.capacityLedger.current(id).length)
      this.capacityLedger.retain(id, `native-census:${id}`, `native-census:${id}`, "command");
    const rows = this.capacityLedger?.current(id).filter(row => row.entered_native && row.state !== "releasing") ?? [];
    if (!rows.length || this.execution(id)) return true;
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      if (!this.get(id)?.metadata?.runnerReference) {
        this.admissionWait(id, { code: "unavailable", message: "Global agent capacity: native startup custody remains uncertain; awaiting positive absence or settlement", retryAt: Date.now() + 5_000 });
        return false;
      }
      runtime = await this.attach(id);
    }
    if (runtime) {
      const state = await this.rpc(runtime, { type: "get_state" });
      this.adoptReference(id, state); runtime.busy = this.busy(state);
      if (runtime.busy) { this.admissionWait(id, { code: "unavailable", message: "Global agent capacity: retained native command is still executing", retryAt: Date.now() + 5_000 }); return false; }
    }
    await this.releaseCapacity(id);
    // Native custody recovery cannot clear an unrelated model admission wait.
    const wait = this.get(id)?.metadata?.admissionWait;
    if (wait !== undefined && wait !== null) {
      if (typeof wait !== "object" || !("message" in wait) || typeof wait.message !== "string")
        throw new Error(`Invalid admission wait metadata for ${id}`);
      if (wait.message.startsWith("Global agent capacity:")) this.clearAdmissionWait(id);
    }
    return true;
  }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.operations.set(id, next);
    void next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id); }).catch(() => {});
    return next;
  }
  private wake(id: string): void {
    if (!this.started || this.closed || this.suspended) return;
    void this.serial(id, async () => {
      try { await this.drain(id); }
      catch (error) {
        if (this.closed || this.suspended || error instanceof AdmissionWait) return;
        if (this.runtimes.has(id) || this.row(id)?.held || this.halts.has(id)) throw error;
        const message = errorText(error);
        if (isPooledStartupWait(message)) {
          const execution = this.execution(id);
          if (execution) await this.waitForProvider(id, undefined, execution, message);
          else this.admissionWait(id, { code: "unavailable", message, retryAt: Date.now() + 60_000 });
          return;
        }
        const work = this.execution(id)?.work_id ?? this.pending(id)[0]?.id;
        if (!work) throw error;
        const prior = this.get(id)?.metadata?.startupFailure as Json | undefined;
        const runnerCapacity = isRunnerCapacityFailure(message);
        // Capacity is backpressure, not a failed assignment or a human Stop.
        // Keep its retry counter separate from the bounded unknown-startup budget.
        const sameFailure = prior && prior.workId === work && (prior.kind === "runner_capacity") === runnerCapacity;
        const attempts = sameFailure ? Number(prior.attempts) + 1 : 1;
        const permanent = isModelConfigurationError(message) || /Pi cwd admission rejected|Invalid recorded (?:runner|isolated)|Compiled thread runner is missing/.test(message);
        const failure = { workId: work, attempts, ...(error instanceof RunnerStartupError && !this.execution(id) ? { nativeNotReady: true } : {}), ...(runnerCapacity ? { kind: "runner_capacity" } : {}), error: message, since: sameFailure ? prior!.since ?? Date.now() : Date.now(),
          lastActivityAt: Date.now(), retryAt: Date.now() + Math.min(attempts * 5_000, 30_000) };
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.startupFailure',json(?),'$.executionError',?) WHERE id=?").run(JSON.stringify(failure), message, id);
        this.changed(id);
        if (!runnerCapacity && (permanent || attempts >= 3)) await this.rejectStartup(id, message);
      }
    }).catch(error => {
      if (this.closed || this.suspended || !this.row(id)) return;
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(errorText(error), id);
      this.changed(id);
    });
  }
  async start(): Promise<Result<void>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread service is not accepting work");
    if (!this.started) {
      this.started = true;
      this.timer = setInterval(() => this.reconcile(), 5_000); this.timer.unref();
      this.archiveCompletedBackground();
      this.reconcile();
    }
    return good(undefined);
  }
  reconcile(): void {
    if (!this.started || this.closed || this.suspended) return;
    void this.routeNotifications();
    void this.resolveQuestionManagers();
    void this.routeQuestionCustody();
    this.releaseExpiredQuestions();
    this.deliverScheduledWakes();
    void this.reconcileManagerWatchdog();
    if (this.capacityLedger) {
      const pending = this.sql("SELECT DISTINCT thread_id FROM thread_capacity WHERE state='releasing'").all() as { thread_id: string }[];
      for (const row of pending) void this.serial(row.thread_id, async () => {
        this.capacityReleaseEvidence(row.thread_id, await this.capacityLedger!.flush());
      });
    }
    for (const row of this.sql("SELECT id FROM thread WHERE json_extract(metadata,'$.dependencyUpdate') IS NOT NULL").all() as Array<{ id: string }>) {
      if (!this.dependencyOperations.has(row.id)) void this.recoverDependencies(row.id).then(result => {
        if (!result.ok && !this.closed && !this.suspended) this.sql("UPDATE thread SET metadata=json_set(metadata,'$.dependencyError',?) WHERE id=?").run(result.error.message, row.id);
      });
    }
    // CROSS JOIN keeps the partial custody indexes on the driving side; SQLite otherwise scans historical threads to merge the UNION.
    const rows = this.sql(`SELECT id,held FROM thread WHERE state='running'
      UNION SELECT t.id,t.held FROM thread_execution e INDEXED BY thread_execution_active CROSS JOIN thread t ON t.id=e.thread_id WHERE e.ended_at IS NULL
      UNION SELECT t.id,t.held FROM thread_work w INDEXED BY thread_work_unfinished CROSS JOIN thread t ON t.id=w.thread_id WHERE w.status!='done' AND t.held=0
      ${this.capacityLedger ? "UNION SELECT t.id,t.held FROM thread_capacity c CROSS JOIN thread t ON t.id=c.thread_id WHERE c.state!='released'" : ""}`).all() as { id: string; held: number }[];
    for (const row of rows) {
      if (row.held) void this.halt(row.id);
      else if (!this.operations.has(row.id) && !this.halts.has(row.id)) this.wake(row.id);
    }
    for (const [id, runtime] of this.runtimes) if (!runtime.busy && !runtime.executionId && !this.operations.has(id) && !this.halts.has(id) && !this.opening.has(id)) void this.serial(id, () => this.park(id, runtime)).catch(error => {
      if (!this.suspended && !this.closed) { this.sql("UPDATE thread SET metadata=json_set(metadata,'$.cleanupError',?) WHERE id=?").run(errorText(error), id); this.changed(id); }
    });
  }

  private async reconcileManagerWatchdog(): Promise<void> {
    const owner = this.managerWatchdog;
    if (!owner || this.managerWatchdogRunning) return;
    this.managerWatchdogRunning = true;
    try {
      const observed = await owner.observe();
      if (this.closed || this.suspended || !this.started) return;
      if (!observed.ok) { this.managerWatchdogApproved = null; owner.onError(observed.error.message); return; }
      const input = observed.value;
      if (input.managerThreadId === null) { owner.onError(null); return; }
      await this.serial(input.managerThreadId, async () => {
      if (this.closed || this.suspended || !this.started) return;
      const manager = this.get(input.managerThreadId!);
      if (!manager || manager.metadata?.manager !== true) { owner.onError("Manager watchdog has no canonical manager identity"); return; }
      const now = Date.now();
      const localHuman = this.sql("SELECT MAX(created_at) time FROM thread_human_activity").get() as { time: number | null };
      const times = [input.lastHumanMessageAt, localHuman.time].filter((time): time is number => time !== null);
      const humanAt = times.length ? Math.max(...times) : null;
      let receipt: string | null = null;
      this.transaction(() => {
        this.sql("INSERT OR IGNORE INTO manager_watchdog(thread_id,last_human_at,next_due_at,sequence) VALUES(?,NULL,NULL,0)").run(manager.id);
        const state = this.sql("SELECT * FROM manager_watchdog WHERE thread_id=?").get(manager.id) as { last_human_at: number | null; next_due_at: number | null; sequence: number; paused_at: number | null };
        const newestHuman = humanAt === null ? state.last_human_at : state.last_human_at === null ? humanAt : Math.max(humanAt, state.last_human_at);
        const pausedAt = state.paused_at !== null && newestHuman !== null && newestHuman > state.paused_at ? null : state.paused_at;
        let due = state.next_due_at;
        if (!input.activeWork || pausedAt !== null || manager.held || manager.lifecycle.kind === "archived") due = null;
        else if (due === null || newestHuman !== state.last_human_at) due = (newestHuman ?? now) + MANAGER_INACTIVITY_MS;
        this.sql("UPDATE manager_watchdog SET last_human_at=?,next_due_at=?,paused_at=? WHERE thread_id=?").run(newestHuman, due, pausedAt, manager.id);
        if (due === null || newestHuman !== state.last_human_at) { this.managerWatchdogApproved = null; this.cancelQueuedManagerChecks(manager.id); }
        else if (newestHuman === null || newestHuman + MANAGER_INACTIVITY_MS <= now) this.managerWatchdogApproved = `${MANAGER_WATCHDOG_PREFIX}${manager.id}:${state.sequence}`;
        if (due === null || due > now || this.halts.has(manager.id)
          || this.pending(manager.id).some(message => message.id.startsWith(MANAGER_WATCHDOG_PREFIX))) return;
        receipt = `${MANAGER_WATCHDOG_PREFIX}${manager.id}:${state.sequence + 1}`;
        this.managerWatchdogApproved = receipt;
        this.insertMessage(receipt, { requestId: receipt, threadId: manager.id, senderId: manager.id, source: "notification", delivery: "queue",
          text: `Five-minute inactivity check: the person has not sent a human message for five minutes and managed work remains active. Inspect the accessible orchestrator work and canonical dependency waits for stuck work, unblock what you can, and return quietly if nothing needs attention. Agent messages and tool events do not reset this schedule. The controller owns this conditional timer; do not create a thread_wake for it.\n\n${BACKGROUND_ATTENTION_POLICY}` }, manager.settings, true);
        this.sql("UPDATE thread SET state='running' WHERE id=?").run(manager.id);
        this.sql("UPDATE manager_watchdog SET next_due_at=?,sequence=? WHERE thread_id=?").run(now + MANAGER_INACTIVITY_MS, state.sequence + 1, manager.id);
      });
      owner.onError(null);
      if (receipt !== null) { this.changed(manager.id); this.wake(manager.id); }
      });
    } catch (error) {
      if (!this.closed && !this.suspended) owner.onError(errorText(error));
    } finally { this.managerWatchdogRunning = false; }
  }

  private async validateManagerCheck(threadId: string, workId: string): Promise<boolean> {
    const owner = this.managerWatchdog;
    if (!owner) return false;
    try {
      const result = await owner.observe();
      if (this.closed || this.suspended || !this.started) return false;
      if (!result.ok) { this.managerWatchdogApproved = null; owner.onError(result.error.message); return false; }
      const manager = this.get(threadId);
      const localHuman = this.sql("SELECT MAX(created_at) time FROM thread_human_activity").get() as { time: number | null };
      const times = [result.value.lastHumanMessageAt, localHuman.time].filter((time): time is number => time !== null);
      const humanAt = times.length ? Math.max(...times) : null;
      const state = this.sql("SELECT paused_at FROM manager_watchdog WHERE thread_id=?").get(threadId) as { paused_at: number | null } | undefined;
      const valid = result.value.managerThreadId === threadId && result.value.activeWork && manager?.metadata?.manager === true && !manager.held
        && (humanAt === null || humanAt + MANAGER_INACTIVITY_MS <= Date.now())
        && !!state && (state.paused_at === null || humanAt !== null && humanAt > state.paused_at);
      if (!valid) this.cancelQueuedManagerChecks(threadId);
      else {
        this.managerWatchdogApproved = workId;
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.agentWait') WHERE id=?").run(threadId);
      }
      owner.onError(null);
      return valid;
    } catch (error) {
      this.managerWatchdogApproved = null;
      if (!this.closed && !this.suspended) owner.onError(errorText(error));
      return false;
    }
  }

  private async validateDependencies(id: string, ids: string[]): Promise<Result<void>> {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(target => typeof target !== "string" || !target.trim() || target === id) || new Set(ids).size !== ids.length)
      return bad("invalid_request", "Dependencies require up to 100 unique accessible peers, excluding self");
    for (const target of ids) {
      if (this.get(target)) continue;
      const found = await (this.directory ?? this).list({ id: target, limit: 1 });
      if (!found.ok) return found;
      if (!found.value.threads.some(peer => peer.id === target)) return bad("not_found", `Dependency ${target} is not accessible`);
    }
    return good(undefined);
  }
  private dependencyOwners(thread: Thread): { explicit: string[]; wait: string[] } {
    const peers = thread.dependencies ?? [];
    const dependency = validateWaitDependency(thread.metadata?.agentWait);
    const named = dependency.ok ? dependency.value.kind === "agents" ? dependency.value.threadIds : dependency.value.kind === "message" ? [dependency.value.fromThreadId] : [] : [];
    const wait = (thread.metadata?.waitDependencies as string[] | undefined) ?? peers.filter(id => named.includes(id));
    const explicit = (thread.metadata?.explicitDependencies as string[] | undefined) ?? peers.filter(id => !wait.includes(id));
    return { explicit: explicit.filter(id => peers.includes(id)), wait: wait.filter(id => peers.includes(id)) };
  }
  private replaceDependencies(id: string, desired: string[], after?: Record<string, number>, ownership?: { explicit: string[]; wait: string[] }): void {
    const current = this.get(id)!;
    const owners = ownership ?? this.dependencyOwners(current);
    const update = current.metadata?.dependencyUpdate as { previous: string[]; desired: string[]; after?: Record<string, number> } | undefined;
    const previous = [...new Set([...(current.dependencies ?? []), ...(update?.previous ?? []), ...(update?.desired ?? [])])];
    const cursors = Object.fromEntries(desired.map(target => [target, after?.[target] ?? update?.after?.[target] ?? (current.metadata?.peerResultAfter as Record<string, number> | undefined)?.[target] ?? 0]));
    this.sql("UPDATE thread SET metadata=json_set(metadata,'$.peerDependencies',json(?),'$.peerResultAfter',json(?),'$.dependencyUpdate',json(?),'$.explicitDependencies',json(?),'$.waitDependencies',json(?)) WHERE id=?")
      .run(JSON.stringify(desired), JSON.stringify(cursors), JSON.stringify({ previous, desired, after: cursors }), JSON.stringify(owners.explicit.filter(target => desired.includes(target))), JSON.stringify(owners.wait.filter(target => desired.includes(target))), id);
    this.changed(id);
  }
  /** Completed results remain in durable receipts; subscribers do not keep the producer open. */
  private async archiveSettledBackground(id: string): Promise<void> {
    const thread = this.get(id);
    const settledWork = this.sql(`SELECT 1 FROM thread_execution WHERE thread_id=? AND ended_at IS NOT NULL
      UNION ALL SELECT 1 FROM thread_work WHERE thread_id=? AND status='done' LIMIT 1`).get(id, id);
    if (!thread || !settledWork || thread.metadata?.foreground === true
      || thread.metadata?.archived || this.hasAutoArchiveWork(thread)) return;
    const latest = this.get(id);
    if (!latest || this.suspended || this.closed || latest.metadata?.foreground === true
      || latest.metadata?.archived || this.hasAutoArchiveWork(latest)) return;
    this.sql("UPDATE thread SET held=0,metadata=json_set(metadata,'$.archived',json('true'),'$.archivedAt',?) WHERE id=?").run(new Date().toISOString(), id);
    this.changed(id);
  }
  private archiveCompletedBackground(): void {
    const rows = this.sql(`SELECT t.id FROM thread t WHERE t.state='idle'
      AND json_extract(t.metadata,'$.archived') IS NOT 1
      AND json_extract(t.metadata,'$.foreground') IS NOT 1
      AND (EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=t.id AND e.ended_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=t.id AND w.status='done'))`)
      .all() as Array<{ id: string }>;
    for (const row of rows) void this.archiveSettledBackground(row.id);
  }
  private archiveBackgroundAfterCurrentOperation(id: string): void {
    const current = this.operations.get(id);
    if (!current) { void this.archiveSettledBackground(id); return; }
    const completed = () => this.archiveBackgroundAfterCurrentOperation(id);
    void current.then(completed, completed);
  }
  private async updateDependencies(id: string, desired: string[], after?: Record<string, number>): Promise<Result<void>> {
    const valid = await this.validateDependencies(id, desired); if (!valid.ok) return valid;
    if (this.closed || this.suspended) return bad("unavailable", "Subscription registration remains with its owner during handoff");
    const current = this.get(id)!;
    if (current.held || current.metadata?.archived || this.halts.has(id)) return bad("conflict", "A closing or archived agent cannot change dependencies");
    this.replaceDependencies(id, desired, after, { explicit: desired, wait: [] });
    return this.recoverDependencies(id);
  }
  private recoverDependencies(id: string): Promise<Result<void>> {
    const existing = this.dependencyOperations.get(id); if (existing) return existing;
    const operation = (async (): Promise<Result<void>> => {
      while (!this.closed && !this.suspended) {
        const update = this.get(id)?.metadata?.dependencyUpdate as { previous: string[]; desired: string[]; after?: Record<string, number> } | undefined;
        if (!update) return good(undefined);
        for (const threadId of [...new Set([...update.previous, ...update.desired])]) {
          const active = update.desired.includes(threadId);
          const api = this.get(threadId) ? this : this.directory ?? this;
          const result = await api.control({ action: "resultSubscribe", threadId, dependentId: id, active, after: update.after?.[threadId] ?? (this.get(id)?.metadata?.peerResultAfter as Record<string, number> | undefined)?.[threadId] ?? 0 });
          if (!result.ok && !(result.error.code === "not_found" && !active)) return result;
        }
        if (this.closed || this.suspended) break;
        if (digest(this.get(id)?.metadata?.dependencyUpdate) !== digest(update)) continue;
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.dependencyUpdate','$.dependencyError') WHERE id=?").run(id);
        this.changed(id);
        return good(undefined);
      }
      return bad("unavailable", "Subscriptions remain with their owner during handoff");
    })();
    this.dependencyOperations.set(id, operation);
    void operation.finally(() => { if (this.dependencyOperations.get(id) === operation) this.dependencyOperations.delete(id); }).catch(() => {});
    return operation;
  }
  async agentWait(input: import("./contracts.js").AgentWaitRequest): Promise<Result<import("./contracts.js").AgentWaitResult>> {
    const prior = this.request(input?.requestId, input, "agent-wait"); if (!prior.ok) return prior;
    const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Thread not found in this owner");
    if (prior.value) {
      const receipt = this.sql("SELECT response FROM thread_request WHERE id=?").get(input.requestId) as { response: string | null };
      if (!receipt.response) return bad("conflict", "This older wait receipt has no registration outcome; inspect the thread and use a new requestId");
      return good({ ...thread, waitRegistration: JSON.parse(receipt.response) });
    }
    if (!["set", "clear"].includes(input.action)) return bad("invalid_request", "Waiting action must be set or clear");
    if (this.waitRegistering.has(thread.id)) return bad("conflict", "A wait registration is already in progress");
    this.waitRegistering.add(thread.id);
    try {
      const inputCursor = (this.sql("SELECT COALESCE(MAX(ordinal),0) ordinal FROM thread_work").get() as { ordinal: number }).ordinal;
      let dependency: import("./contracts.js").WaitDependency | undefined;
      if (input.action === "set") {
        if (thread.held || thread.metadata?.archived || thread.metadata?.raw) return bad("unavailable", "Waiting requires an unheld, unarchived normal thread");
        const parsed = parseRunnerWaitDependency(input); if (!parsed.ok) return parsed;
        dependency = parsed.value;
        const ids = dependency.kind === "agents" ? dependency.threadIds : dependency.kind === "message" ? [dependency.fromThreadId] : [];
        const valid = await this.validateDependencies(thread.id, ids); if (!valid.ok) return valid;
      }
      const ids = dependency?.kind === "agents" ? dependency.threadIds : dependency?.kind === "message" ? [dependency.fromThreadId] : [];
      let settlement: ThreadSettlement | null = null;
      if (dependency?.kind === "agents") {
        const api = dependency.threadIds.every(id => this.get(id)) ? this : this.directory ?? this;
        const settled = await api.await({ parentId: thread.id, threadIds: dependency.threadIds, after: dependency.after, timeoutMs: 0, currentAssignment: true });
        if (!settled.ok) return settled;
        settlement = settled.value.settlement;
      }
      if (this.closed || this.suspended) return bad("unavailable", "Wait registration remains with its owner during handoff");
      const latest = this.get(thread.id)!;
      if (latest.held || latest.metadata?.archived || this.halts.has(thread.id)) return bad("unavailable", "Thread was stopped while registering its wait");
      if (input.action === "set" && new Set([...this.dependencyOwners(latest).explicit, ...ids]).size > 100)
        return bad("invalid_request", "Wait and explicit subscriptions require up to 100 unique peers");
      let registration!: import("./contracts.js").AgentWaitRegistration;
      this.transaction(() => {
        const explicit = input.action === "clear" ? [] : this.dependencyOwners(this.get(thread.id)!).explicit;
        // Inputs may land and even settle while cross-owner validation runs.
        const arrived = (this.sql("SELECT * FROM thread_work WHERE ordinal>? AND thread_id=? AND (status!='done' OR landed_at IS NOT NULL)").all(inputCursor, thread.id) as Json[]).map(row => this.message(row));
        const resumes = (message: ThreadMessage) => dependency && resumesDependency(dependency, message)
          && !(dependency.kind === "agents" && message.source === "notification");
        const messageIds = [...new Set([...this.pending(thread.id).filter(message => message.landedAt == null), ...arrived].filter(resumes).map(message => message.id))];
        if (input.action === "clear") registration = { status: "cleared" };
        else if (messageIds.length) registration = { status: "resumed", messageIds: messageIds as [string, ...string[]] };
        else if (settlement) registration = { status: "already_arrived", settlement };
        else if (dependency && input.action === "set") {
          const wait: import("./contracts.js").AgentWait = { ...dependency, since: Date.now() };
          registration = { status: "registered", wait };
        } else throw new Error("Validated wait registration has no dependency");
        if (registration.status === "registered") {
          this.sql("UPDATE thread SET metadata=json_set(metadata,'$.agentWait',json(?)) WHERE id=?").run(JSON.stringify(registration.wait), thread.id);
        } else {
          this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.agentWait') WHERE id=?").run(thread.id);
        }
        const settledPeer = registration.status === "already_arrived" ? registration.settlement.threadId : null;
        const wait = registration.status === "registered" ? ids
          : registration.status === "already_arrived" ? ids.filter(id => id !== settledPeer) : [];
        this.replaceDependencies(thread.id, [...new Set([...explicit, ...wait])], dependency?.kind === "agents" ? dependency.after : undefined, { explicit, wait });
        this.recordRequest(input.requestId, input, "agent-wait", thread.id);
        this.sql("UPDATE thread_request SET response=? WHERE id=?").run(JSON.stringify(registration), input.requestId);
      });
      this.changed(thread.id);
      // The committed receipt and subscription journal transfer registration custody to this owner.
      const recovered = await this.recoverDependencies(thread.id);
      if (this.closed || this.suspended) return bad("unavailable", "Accepted wait registration remains with its owner during handoff");
      if (!recovered.ok) this.sql("UPDATE thread SET metadata=json_set(metadata,'$.dependencyError',?) WHERE id=?").run(recovered.error.message, thread.id);
      return good({ ...this.get(thread.id)!, waitRegistration: registration });
    } finally { this.waitRegistering.delete(thread.id); }
  }
  async wakeSchedule(input: import("./contracts.js").ThreadWakeRequest): Promise<Result<import("./contracts.js").ThreadWakeSchedule | null>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    const thread = this.get(input?.threadId); if (!thread) return bad("not_found", "Thread not found in this owner");
    if (input.action === "list") return good(thread.wakeSchedule ?? null);
    if (input.action !== "set" && input.action !== "cancel") return bad("invalid_request", "Wake action must be set, list or cancel");
    const prior = this.request(input.requestId, input, "thread-wake"); if (!prior.ok) return prior;
    if (prior.value) return good(thread.wakeSchedule ?? null);
    if (input.action === "set" && (typeof input.reason !== "string" || !input.reason.trim()
      || !Number.isSafeInteger(input.cadenceMs) || input.cadenceMs < 60_000
      || input.nextDueAt !== undefined && (!Number.isSafeInteger(input.nextDueAt) || input.nextDueAt < 0))) return bad("invalid_request", "Wake requires reason, cadenceMs >= 60000 and a nonnegative epoch nextDueAt");
    if (input.action === "set" && (thread.held || thread.metadata?.archived || thread.metadata?.raw)) return bad("unavailable", "Wake scheduling requires an unheld, unarchived normal thread");
    this.transaction(() => {
      if (input.action === "set") {
        const schedule: import("./contracts.js").ThreadWakeSchedule = { ...thread.wakeSchedule, reason: input.reason.trim(), cadenceMs: input.cadenceMs, nextDueAt: input.nextDueAt ?? Date.now() + input.cadenceMs };
        this.sql("INSERT INTO thread_wake(thread_id,generation,data) VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data").run(thread.id, randomUUID(), JSON.stringify(schedule));
      } else {
        const message = thread.wakeSchedule?.lastMessageId;
        if (message) this.sql("UPDATE thread_work SET status='done',outcome='cancelled' WHERE id=? AND thread_id=? AND status='queued'").run(message, thread.id);
        this.sql("DELETE FROM thread_wake WHERE thread_id=?").run(thread.id);
        this.sql("UPDATE thread SET state='idle',metadata=json_remove(metadata,'$.admissionWait') WHERE id=? AND NOT EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=thread.id AND e.ended_at IS NULL) AND NOT EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=thread.id AND w.status!='done')").run(thread.id);
      }
      this.recordRequest(input.requestId, input, "thread-wake", thread.id);
    });
    this.changed(thread.id);
    return good(this.get(thread.id)!.wakeSchedule ?? null);
  }
  private deliverScheduledWakes(): void {
    const now = Date.now();
    const due = this.sql(`SELECT s.thread_id,s.generation,s.data FROM thread_wake s JOIN thread t ON t.id=s.thread_id
      WHERE json_extract(s.data,'$.nextDueAt')<=? AND t.state='idle' AND t.held=0
      AND json_extract(t.metadata,'$.archived') IS NOT 1
      AND NOT EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=t.id AND e.ended_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=t.id AND w.status!='done')`).all(now) as Json[];
    for (const row of due) {
      if (this.operations.has(row.thread_id) || this.halts.has(row.thread_id) || this.opening.has(row.thread_id)) continue;
      const thread = this.get(row.thread_id)!;
      const schedule = JSON.parse(row.data) as import("./contracts.js").ThreadWakeSchedule;
      if (thread.metadata?.manager === true && thread.lastUserMessageAt !== undefined && now - thread.lastUserMessageAt < 15 * 60_000) continue;
      const receipt = `thread-wake:${row.generation}:${schedule.nextDueAt}`;
      this.transaction(() => {
        this.insertMessage(receipt, { requestId: receipt, threadId: thread.id, senderId: thread.id, source: "notification", delivery: "steer",
          text: `Scheduled wake check for this existing thread: ${schedule.reason}\nRead current dependency evidence. Continue useful work, cancel thread_wake when resolved, or return to thread_wait without polling.\n\n${BACKGROUND_ATTENTION_POLICY}` }, thread.settings);
        this.sql("UPDATE thread SET state='running',metadata=json_remove(metadata,'$.agentWait') WHERE id=?").run(thread.id);
        this.sql("UPDATE thread_wake SET data=? WHERE thread_id=?").run(JSON.stringify({ ...schedule, nextDueAt: now + schedule.cadenceMs, lastMessageId: receipt }), thread.id);
      });
      this.changed(thread.id);
    }
  }

  private request(id: string, value: unknown, kind: string): Result<string | null> {
    if (this.closed || this.suspended) return { ok: false, error: { code: "unavailable", message: "Thread controller is suspended", retryable: true } };
    if (typeof id !== "string" || !id.trim()) return bad("invalid_request", "A stable requestId is required");
    const receipt = this.sql("SELECT * FROM thread_request WHERE id=?").get(id) as Json | undefined;
    if (receipt?.kind === "import-message" && kind === "send") {
      const work = this.sql("SELECT * FROM thread_work WHERE id=?").get(receipt.target) as Json, input = value as SendThread;
      return work.thread_id === input.threadId && work.text === input.text && work.images === JSON.stringify(input.images ?? []) ? good(receipt.target) : bad("conflict", "Imported requestId belongs to different input");
    }
    return receipt ? receipt.hash === digest(value) && receipt.kind === kind ? good(receipt.target) : bad("conflict", "requestId already belongs to different input") : good(null);
  }
  private recordRequest(id: string, value: unknown, kind: string, target: string): void { this.sql("INSERT INTO thread_request(id,hash,kind,target) VALUES(?,?,?,?)").run(id, digest(value), kind, target); }
  private cancelQueuedManagerChecks(threadId?: string): void {
    this.managerWatchdogApproved = null;
    const ids = threadId ? [threadId] : (this.sql("SELECT thread_id FROM manager_watchdog").all() as { thread_id: string }[]).map(row => row.thread_id);
    for (const id of ids) {
      this.sql("UPDATE thread_work SET status='done',outcome='cancelled' WHERE thread_id=? AND status='queued' AND id LIKE 'thread-wake:manager-inactivity:%'").run(id);
      this.sql("UPDATE thread SET state='idle',metadata=json_remove(metadata,'$.admissionWait') WHERE id=? AND NOT EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=thread.id AND e.ended_at IS NULL) AND NOT EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=thread.id AND w.status!='done')").run(id);
    }
  }
  private insertMessage(id: string, input: SendThread, settings: ThreadSettings, front = false, senderName?: string, waitResult?: WaitResultEvidence): ThreadMessage {
    const humanActivity = input.humanActivity === true && !input.senderId && (input.source ?? "explicit") === "explicit";
    if (humanActivity) {
      this.cancelQueuedManagerChecks();
      this.sql("UPDATE manager_watchdog SET paused_at=NULL").run();
    }
    const current = this.get(input.threadId);
    const wait = current?.metadata?.agentWait;
    const dependency = validateWaitDependency(wait);
    let resumed = dependency.ok && resumesDependency(dependency.value, { senderId: input.senderId ?? null, source: input.source ?? "explicit" });
    if (input.source === "notification" && input.senderId) {
      const executionId = resultExecutionId(id, input.threadId);
      const cursor = dependency.ok && dependency.value.kind === "agents" ? dependency.value.after[input.senderId] ?? 0
        : (current?.metadata?.peerResultAfter as Record<string, number> | undefined)?.[input.senderId] ?? 0;
      const result = waitResult ? waitResult.settlement
        : executionId && this.sql("SELECT * FROM thread_execution WHERE id=? AND thread_id=? AND ended_at IS NOT NULL").get(executionId, input.senderId) as Json | undefined;
      const currentResult = !!result && (waitResult ? waitResult.settlement?.executionId === executionId
        : this.currentAssignmentResult(result as Json)) && (result.outcome === "cancelled" || (waitResult ? result.seq : (result as Json).settlement_seq) > cursor);
      if (currentResult && current?.dependencies?.includes(input.senderId)) {
        this.replaceDependencies(input.threadId, current.dependencies.filter(target => target !== input.senderId));
      }
      if (dependency.ok && dependency.value.kind === "agents") resumed = resumed && currentResult && (!waitResult || digest(wait) === digest(waitResult.wait));
    }
    // Untyped persisted waits retain their original child-result routing until the next input or scheduled recovery.
    const priorChildResult = wait && typeof wait === "object" && !("kind" in wait) && "threadIds" in wait
      && Array.isArray(wait.threadIds) && input.senderId && wait.threadIds.includes(input.senderId);
    if (wait && (input.source !== "notification" || resumed || priorChildResult)) {
      this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.agentWait') WHERE id=?").run(input.threadId);
    }
    const manager = current?.metadata?.manager === true;
    const delivery = manager && !id.startsWith(MANAGER_WATCHDOG_PREFIX) ? "steer" : resolveDelivery(input);
    const inputOrigin = humanActivity ? "human" : input.senderId || input.source === "notification" || input.humanActivity === false ? "machine" : null;
    this.sql("INSERT INTO thread_work(id,thread_id,sender_id,text,images,delivery,source,reply_to,front,settings,created_at,priority,input_origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.threadId, input.senderId ?? null, input.text, JSON.stringify(input.images ?? []), delivery, input.source ?? "explicit", input.replyTo ?? null, manager && !id.startsWith(MANAGER_WATCHDOG_PREFIX) ? 0 : front ? Date.now() : 0, JSON.stringify(settings), Date.now(), manager ? humanActivity ? 2 : 1 : 0, inputOrigin);
    if (humanActivity) this.sql("INSERT INTO thread_human_activity(work_id,thread_id,created_at) SELECT id,thread_id,created_at FROM thread_work WHERE id=?").run(id);
    if (senderName) this.sql("UPDATE thread_work SET sender_name=? WHERE id=?").run(senderName, id);
    if (input.source === "notification" && this.get(input.threadId)?.metadata?.archived) this.sql("UPDATE thread_work SET status='done',outcome='cancelled' WHERE id=?").run(id);
    return this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(id) as Json);
  }
  async spawn(input: SpawnThread): Promise<Result<Thread>> {
    try {
      // The creator is the owner's verification of this caller, not part of the request's identity.
      const { createdBy, ...receipt } = input;
      const prior = this.request(input.requestId, receipt, "spawn"); if (!prior.ok) return prior;
      if (prior.value) return good(this.get(prior.value)!);
      if (!input.cwd || typeof input.cwd !== "string" || input.message !== undefined && (typeof input.message !== "string" || !input.message.trim())) return bad("invalid_request", "cwd and a nonempty assignment when supplied are required");
      let parent = input.parentId ? this.get(input.parentId) : null;
      if (input.parentId && !parent && this.directory) {
        const found = await this.directory.list({ id: input.parentId, limit: 1 });
        if (!found.ok) return found;
        parent = found.value.threads[0] ?? null;
        const accepted = this.request(input.requestId, receipt, "spawn"); if (!accepted.ok) return accepted;
        if (accepted.value) return good(this.get(accepted.value)!);
      }
      if (input.parentId && !parent) return bad("not_found", "Parent thread is not accessible to this service");
      if (input.metadata && "manager" in input.metadata && input.metadata.manager !== true) return bad("invalid_request", "Manager metadata must be true when present");
      if (input.metadata?.manager === true) {
        if (this.options.workersOnly || input.parentId || input.ephemeral || input.metadata.raw || input.metadata.sandbox || input.metadata.context || input.metadata.execution || input.metadata.archived || input.metadata.mode)
          return bad("invalid_request", "A manager is a persistent full-context person-owned root thread");
        const manager = this.manager();
        if (manager) { this.recordRequest(input.requestId, receipt, "spawn", manager.id); return good(manager); }
      }
      if (input.ephemeral !== undefined && typeof input.ephemeral !== "boolean") return bad("invalid_request", "ephemeral must be a boolean");
      if (input.ephemeral && !input.message) return bad("invalid_request", "Ephemeral subagents need an initial assignment");
      if (input.metadata && ["agentWait", "peerDependencies", "explicitDependencies", "waitDependencies", "peerResultAfter", "peerDependents", "peerSubscriberAfter", "dependencyUpdate", "peerDependencyVersion", "dependencyError", "agentName", "cancellationRequest", "cancellationSettled"].some(key => key in input.metadata!)) return bad("invalid_request", "Waits, dependencies and agent names are owned by the thread service");
      if (input.metadata && ("foreground" in input.metadata || "attentionSummary" in input.metadata)) return bad("invalid_request", "Use attention instead of setting attention metadata");
      if (input.metadata && "ephemeral" in input.metadata) return bad("invalid_request", "Set ephemeral on the spawn request, not in metadata");
      if (input.metadata && "autoArchiveViewedAt" in input.metadata) return bad("invalid_request", "Use view control instead of setting auto-archive metadata");
      if (parent?.metadata?.sandbox) return bad("invalid_request", "Sandbox threads cannot create workers");
      if (parent?.metadata?.archived) return bad("unavailable", "Restore the parent before creating children");
      if (parent?.held) return bad("unavailable", "Resume the parent conversation before creating workers");
      if (input.metadata?.mode !== undefined && (!isThreadModeName(input.metadata.mode) || parent && input.metadata.mode !== parent.metadata?.mode)) return bad("invalid_request", "A thread mode must be declared in modes.ts, and a child keeps its parent's mode");
      const settings = resolveSpawnSettings(input.settings, parent, input.metadata?.mode, input.settings?.model == null ? this.options.spawnDefaultModel?.() : undefined); if (!settings.ok) return settings;
      const available = this.options.admitNewThread?.(settings.value); if (available && !available.ok) return available;
      // Check local receipts first so retries of previously accepted children retain their identity.
      const workerOwner = parent && this.workerOwner?.(parent, input);
      if (workerOwner) return workerOwner.spawn(input);
      const metadata: Record<string, unknown> = { ...Object.fromEntries(["profileId", "meetingId", "bashTimeoutSeconds", "context", "execution", "source", "raw", "sandbox", "mode"].filter(key => parent?.metadata?.[key] !== undefined).map(key => [key, parent!.metadata![key]])), ...input.metadata, ...(input.ephemeral ? { ephemeral: true } : {}) };
      delete metadata.createdBy;
      if (createdBy) metadata.createdBy = createdBy;
      metadata.agentName = getRandomName();
      metadata.foreground = createdBy?.kind === "person";
      metadata.peerDependencies = [];
      for (const key of ["context", "execution", "raw", "sandbox"] as const) if (parent && input.metadata && key in input.metadata && digest(input.metadata[key] ?? null) !== digest(parent.metadata?.[key] ?? null)) return bad("conflict", "A child must remain in its parent's execution boundary");
      if (metadata.context !== undefined && !isRunContext(metadata.context)) return bad("invalid_request", "Invalid isolated context contract");
      if (metadata.execution === "root-repair" && metadata.context) return bad("invalid_request", "Root repair requires full normal Pi context");
      if (!validSandboxBoundary(metadata)) return bad("invalid_request", "Sandbox threads require raw context and cannot carry an execution override or mode");
      if (metadata.raw !== undefined && metadata.raw !== true) return bad("invalid_request", "Thread metadata raw must be true when present");
      if (metadata.raw === true && (metadata.context !== undefined || metadata.execution === "root-repair")) return bad("invalid_request", "Raw threads carry no isolated context and cannot perform root repair");
      if (metadata.telephoneContext !== undefined && (!isTelephoneContext(metadata.telephoneContext) || metadata.raw !== true || metadata.sandbox !== undefined || metadata.meetingId != null || metadata.room !== undefined)) return bad("invalid_request", "Telephone threads require a valid fixed raw boundary");
      if (input.admission !== undefined && !["force", "background"].includes(input.admission)) return bad("invalid_request", "Invalid admission policy");
      const admission = threadMode(metadata.mode)?.admission ?? (input.parentId ? "force" : input.admission ?? "force");
      const id = input.id ?? randomUUID();
      if (input.parentId === id) return bad("invalid_request", "A thread cannot be its own parent");
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return bad("invalid_request", "Thread ID must be a nonempty filename-safe identifier");
      if (this.get(id)) return bad("conflict", "Thread ID already exists");
      const cwd = metadata.sandbox ? join(this.options.sessionsDir, "sandboxes", id) : input.cwd;
      if (metadata.sandbox) mkdirSync(cwd, { recursive: true, mode: 0o700 });
      this.transaction(() => {
        const now = Date.now();
        this.sql("INSERT INTO thread(id,parent_id,title,cwd,session_file,settings,admission,state,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, input.parentId ?? null, input.title ?? `Thread ${id.slice(0, 8)}`, cwd, join(this.options.sessionsDir, `${id}.jsonl`), JSON.stringify(settings.value), admission, input.message ? "running" : "idle", now, now, JSON.stringify(metadata));
        if (input.message) this.insertMessage(input.requestId, { requestId: input.requestId, threadId: id, senderId: input.parentId, humanActivity: input.createdBy?.kind === "person",
          source: !input.parentId && (input.metadata?.watchList === true || input.createdBy && input.createdBy.kind !== "person") ? "notification" : "explicit",
          text: input.message, images: input.images, delivery: resolveDelivery({ senderId: input.parentId }) }, settings.value, false, parent?.agentName);
        this.recordRequest(input.requestId, receipt, "spawn", id);
      });
      this.changed(id); this.wake(id); return good(this.get(id)!);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  async attention(input: import("./contracts.js").ThreadAttentionRequest): Promise<Result<import("./contracts.js").ThreadAttentionReceipt>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (!input || typeof input.requestId !== "string" || !input.requestId.trim() || typeof input.threadId !== "string" || !input.threadId.trim()
      || typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 1000
      || input.foreground !== undefined && typeof input.foreground !== "boolean"
      || Object.keys(input).some(key => !["threadId", "requestId", "summary", "foreground"].includes(key)))
      return bad("invalid_request", "Attention requires a stable requestId, your threadId, a nonblank summary of at most 1000 characters and optional boolean foreground");
    try {
      const prior = this.request(input.requestId, input, "attention"); if (!prior.ok) return prior;
      if (prior.value) return good(JSON.parse(prior.value));
      const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Thread not found");
      if (thread.held || thread.metadata?.archived || thread.metadata?.raw || thread.metadata?.sandbox)
        return bad("unavailable", "Attention requires an unheld, unarchived normal thread");
      let receipt!: import("./contracts.js").ThreadAttentionReceipt;
      this.transaction(() => {
        const time = Date.now(), summary = input.summary.trim(), foreground = false;
        const inserted = this.sql("INSERT INTO thread_attention(request_id,thread_id,summary,foreground,time) VALUES(?,?,?,?,?)")
          .run(input.requestId, thread.id, summary, foreground ? 1 : 0, time);
        receipt = { accepted: true, seq: Number(inserted.lastInsertRowid), threadId: thread.id, summary, foreground, time };
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.attentionSummary',?) WHERE id=?").run(summary, thread.id);
        this.recordRequest(input.requestId, input, "attention", JSON.stringify(receipt));
      });
      this.changed(thread.id);
      return good(receipt);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  attentionEvents(after = 0, limit = 100): Result<import("./contracts.js").ThreadAttentionEvents> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) return bad("invalid_request", "Invalid attention cursor or limit");
    const rows = this.sql("SELECT seq,thread_id AS threadId,summary,foreground,time FROM thread_attention WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit) as Json[];
    return good({ cursor: rows.at(-1)?.seq ?? after, items: rows.map(row => ({ ...row, accepted: true, foreground: row.foreground === 1 })) as import("./contracts.js").ThreadAttentionReceipt[] });
  }
  private manager(): Thread | undefined {
    const row = this.sql("SELECT id FROM thread WHERE json_extract(metadata,'$.manager')=1 AND json_extract(metadata,'$.archived') IS NOT 1").get() as { id: string } | undefined;
    return row ? this.get(row.id) ?? undefined : undefined;
  }
  async managerThread(): Promise<Result<Thread | null>> { return good(this.manager() ?? null); }
  async questionOrigin(threadId: string): Promise<Result<Pick<Thread, "id" | "title" | "agentName">>> {
    const origin = this.get(threadId);
    return origin ? good({ id: origin.id, title: origin.title, agentName: origin.agentName }) : bad("not_found", "Question origin is not accessible to this account");
  }
  private notificationPolicy: import("./contracts.js").ManagerNotificationPolicy | null = null;
  async managerNotificationPolicy(): Promise<Result<import("./contracts.js").ManagerNotificationPolicy>> {
    const person = this.directory?.owners?.find(owner => owner.id === "person" && owner.api !== this);
    const result = this.options.managerNotificationPolicy ? await this.options.managerNotificationPolicy()
      : person ? await person.api.managerNotificationPolicy() : good({ view: "classic" as const });
    this.notificationPolicy = result.ok ? result.value : null;
    if (this.notificationPolicy?.view === "mono") this.sql("UPDATE thread_question_route SET state='held' WHERE state='released' AND question_id IN (SELECT id FROM thread_question WHERE accepted_at IS NULL)").run();
    return result;
  }
  private queueQuestionCustody(input: ManagerQuestionCustodyRequest): void {
    this.sql("INSERT OR IGNORE INTO thread_question_custody_outbox(request_id,data) VALUES(?,?)").run(input.requestId, JSON.stringify(input));
    if (this.custodyRouting) this.custodyQueued = true;
  }
  private async routeQuestionCustody(): Promise<void> {
    if (this.custodyRouting || !this.directory || this.closed || this.suspended) return;
    this.custodyRouting = true;
    try {
      const rows = this.sql("SELECT request_id,data FROM thread_question_custody_outbox ORDER BY rowid").all() as Json[];
      for (const row of rows) {
        if (this.closed || this.suspended) return;
        const result = await this.directory.managerQuestionCustody(JSON.parse(row.data));
        if (this.closed || this.suspended) return;
        if (!result.ok) { this.sql("UPDATE thread_question_custody_outbox SET error=? WHERE request_id=?").run(result.error.message, row.request_id); continue; }
        this.sql("DELETE FROM thread_question_custody_outbox WHERE request_id=?").run(row.request_id);
      }
    } finally {
      this.custodyRouting = false;
      if (this.custodyQueued) { this.custodyQueued = false; void this.routeQuestionCustody(); }
    }
  }
  async managerQuestionCustody(input: ManagerQuestionCustodyRequest): Promise<Result<ManagerQuestionCustodyReceipt>> {
    if (input?.threadId && !this.get(input.threadId) && this.options.routeManagerQuestionCustody) return this.options.routeManagerQuestionCustody(input);
    if (!input || typeof input.threadId !== "string" || !input.threadId.trim()) return bad("invalid_request", "Custody requires its destination thread");
    const prior = this.request(input.requestId, input, "question-custody"); if (!prior.ok) return prior;
    if (prior.value) return good({ accepted: true });
    try {
      if (input.action === "receive") {
        const manager = this.manager();
        if (!manager || manager.id !== input.threadId) return bad("conflict", "Question custody requires this person's manager");
        if (typeof input.originThreadId !== "string" || !input.originThreadId.trim() || input.originThreadId === manager.id
          || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0 || !Array.isArray(input.questions) || !input.questions.length
          || new Set(input.questions.map(q => q?.id)).size !== input.questions.length
          || input.questions.some(q => !q || q.threadId !== input.originThreadId || typeof q.id !== "string" || !q.id.trim() || typeof q.question !== "string" || !q.question.trim()
            || !Number.isSafeInteger(q.createdAt) || !Array.isArray(q.suggestions) || q.suggestions.some(s => !s || typeof s.id !== "string" || !s.id.trim() || typeof s.text !== "string" || !s.text.trim())
            || new Set(q.suggestions.map(s => s.id)).size !== q.suggestions.length || q.recommendedSuggestionId !== undefined && !q.suggestions.some(s => s.id === q.recommendedSuggestionId)))
          return bad("invalid_request", "Custody requires valid original questions and their exact deadline");
        if (!this.directory) return bad("unavailable", "Question origin directory is unavailable");
        const origin = await this.directory.questionOrigin(input.originThreadId); if (!origin.ok) return origin;
        const accepted = this.request(input.requestId, input, "question-custody"); if (!accepted.ok) return accepted;
        if (accepted.value) return good({ accepted: true });
        this.transaction(() => {
          for (const q of input.questions) {
            this.sql("INSERT INTO thread_question(id,thread_id,question,suggestions,recommended_id,created_at) VALUES(?,?,?,?,?,?)").run(q.id, manager.id, q.question, JSON.stringify(q.suggestions), q.recommendedSuggestionId ?? null, q.createdAt);
            this.sql("INSERT INTO thread_question_origin(question_id,thread_id) VALUES(?,?)").run(q.id, input.originThreadId);
            this.sql("INSERT INTO thread_question_route(question_id,manager_id,deadline_at,state) VALUES(?,?,?,'held')").run(q.id, manager.id, input.deadlineAt);
          }
          const receipt = `manager-custody:${input.requestId}`;
          this.insertMessage(receipt, { requestId: receipt, threadId: manager.id, senderId: input.originThreadId, source: "notification", delivery: "steer",
            text: `New held questions from ${origin.value.title}. Use manager_questions_list to answer or forward one rewritten question. Unhandled questions become visible at the original two-hour deadline.` }, manager.settings, false, origin.value.agentName);
          this.sql("UPDATE thread SET state='running' WHERE id=?").run(manager.id);
          this.recordRequest(input.requestId, input, "question-custody", manager.id);
        });
        this.changed(manager.id); this.wake(manager.id); this.releaseExpiredQuestions();
        return good({ accepted: true });
      }
      if (input.action === "answer") {
        const manager = this.manager();
        if (!manager || manager.id !== input.threadId || input.answer?.threadId !== input.originThreadId) return bad("conflict", "Classic answers require the originating thread and manager custody");
        const origin = this.sql("SELECT thread_id FROM thread_question_origin WHERE question_id=?").get(input.answer.questionId) as Json | undefined;
        if (!origin || origin.thread_id !== input.originThreadId) return bad("not_found", "External question not found in manager custody");
        const answered = await this.acceptQuestion({ ...input.answer, threadId: manager.id }, undefined, true); if (!answered.ok) return answered;
        const accepted = this.request(input.requestId, input, "question-custody"); if (!accepted.ok) return accepted;
        if (!accepted.value) this.recordRequest(input.requestId, input, "question-custody", manager.id);
        void this.routeQuestionCustody();
        return good({ accepted: true });
      }
      if (input.action === "transition") {
        const route = this.sql("SELECT r.*,q.accepted_at FROM thread_question_route r JOIN thread_question q ON q.id=r.question_id WHERE q.id=? AND q.thread_id=?").get(input.questionId, input.threadId) as Json | undefined;
        if (!route || route.manager_id !== input.managerId) return bad("not_found", "Question does not belong to this manager custody");
        if (!input.transition || !["forwarded", "answered"].includes(input.transition.state)) return bad("invalid_request", "Unknown custody transition");
        if (input.transition.state === "answered") {
          const value = input.transition.answer;
          if (value?.answeredBy && (value.answeredBy.kind !== "manager" || value.answeredBy.threadId !== input.managerId)) return bad("invalid_request", "Answer provenance does not match manager custody");
          const answered = await this.acceptQuestion({ ...value, threadId: input.threadId, questionId: input.questionId }, value?.answeredBy?.threadId, true); if (!answered.ok) return answered;
        } else {
          if (typeof input.transition.forwardedQuestionId !== "string" || !input.transition.forwardedQuestionId.trim()) return bad("invalid_request", "Forwarded custody requires a question identity");
          this.transaction(() => {
            this.sql("UPDATE thread_question_route SET state='forwarded' WHERE question_id=? AND state='held'").run(input.questionId);
            if (route.accepted_at === null) this.sql("INSERT OR IGNORE INTO thread_question_event(question_id) VALUES(?)").run(input.questionId);
          });
          this.changed(input.threadId);
        }
        const accepted = this.request(input.requestId, input, "question-custody"); if (!accepted.ok) return accepted;
        if (!accepted.value) this.recordRequest(input.requestId, input, "question-custody", input.threadId);
        return good({ accepted: true });
      }
      return bad("invalid_request", "Unknown question custody action");
    } catch (cause) { return bad("unavailable", errorText(cause)); }
  }
  private async resolveQuestionManagers(): Promise<void> {
    if (this.questionResolutionRunning || !this.directory || this.closed || this.suspended) return;
    if (!this.sql("SELECT 1 FROM thread_question_unresolved LIMIT 1").get()) return;
    this.questionResolutionRunning = true;
    try {
      const policy = await this.managerNotificationPolicy();
      if (!policy.ok) { this.sql("UPDATE thread_question_unresolved SET error=?").run(policy.error.message); return; }
      const found = await this.directory.managerThread();
      if (this.closed || this.suspended) return;
      this.releaseExpiredQuestions();
      if (!found.ok) {
        this.sql("UPDATE thread_question_unresolved SET error=?").run(found.error.message);
        return;
      }
      const rows = this.sql(`SELECT q.*,u.deadline_at FROM thread_question_unresolved u JOIN thread_question q ON q.id=u.question_id
        WHERE q.accepted_at IS NULL ORDER BY q.created_at,q.rowid`).all() as Json[];
      if (!rows.length) return;
      const manager = found.value;
      this.transaction(() => {
        const groups = new Map<string, Json[]>();
        for (const row of rows) {
          this.sql("DELETE FROM thread_question_unresolved WHERE question_id=?").run(row.id);
          if (!manager || manager.id === row.thread_id) this.sql("INSERT OR IGNORE INTO thread_question_event(question_id) VALUES(?)").run(row.id);
          else {
            this.sql("INSERT INTO thread_question_route(question_id,manager_id,deadline_at,state) VALUES(?,?,?,'held')").run(row.id, manager.id, row.deadline_at);
            const key = JSON.stringify([row.thread_id, row.deadline_at]);
            const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
          }
        }
        if (manager) for (const questions of groups.values()) {
          this.queueQuestionCustody({ action: "receive", threadId: manager.id, requestId: `custody-resolve:${questions[0]!.id}`, originThreadId: questions[0]!.thread_id,
            questions: questions.map(q => this.question(q)), deadlineAt: questions[0]!.deadline_at });
        }
      });
      for (const threadId of new Set(rows.map(row => row.thread_id))) this.changed(threadId);
      void this.routeQuestionCustody();
    } catch (cause) {
      if (!this.closed && !this.suspended) this.sql("UPDATE thread_question_unresolved SET error=?").run(errorText(cause));
    } finally { this.questionResolutionRunning = false; }
  }
  private releaseExpiredQuestions(): void {
    const hasOwner = this.options.managerNotificationPolicy || this.directory?.owners?.some(owner => owner.id === "person" && owner.api !== this);
    if (hasOwner && this.notificationPolicy?.view !== "classic") return;
    const unresolved = this.sql(`SELECT u.question_id,q.thread_id FROM thread_question_unresolved u JOIN thread_question q ON q.id=u.question_id WHERE u.deadline_at<=?`).all(Date.now()) as Json[];
    if (unresolved.length) {
      this.transaction(() => {
        for (const row of unresolved) {
          this.sql("DELETE FROM thread_question_unresolved WHERE question_id=?").run(row.question_id);
          this.sql("INSERT OR IGNORE INTO thread_question_event(question_id) SELECT id FROM thread_question WHERE id=? AND accepted_at IS NULL").run(row.question_id);
        }
      });
      for (const id of new Set(unresolved.map(row => row.thread_id))) this.changed(id);
    }
    const rows = this.sql(`SELECT r.question_id,q.thread_id FROM thread_question_route r JOIN thread_question q ON q.id=r.question_id
      WHERE r.state='held' AND r.deadline_at<=? AND q.accepted_at IS NULL`).all(Date.now()) as Json[];
    if (!rows.length) return;
    this.transaction(() => {
      for (const row of rows) {
        this.sql("UPDATE thread_question_route SET state='released' WHERE question_id=? AND state='held'").run(row.question_id);
        if (!this.sql("SELECT 1 FROM thread_question_origin WHERE question_id=?").get(row.question_id)) this.sql("INSERT OR IGNORE INTO thread_question_event(question_id) VALUES(?)").run(row.question_id);
      }
    });
    for (const id of new Set(rows.map(row => row.thread_id))) this.changed(id);
  }
  async managerQuestions(input: ManagerQuestionsRequest): Promise<Result<ManagerQuestionsResponse>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (!input || typeof input.threadId !== "string") return bad("invalid_request", "The manager thread ID is required");
    const manager = this.manager();
    if (!manager || manager.id !== input.threadId) return bad("conflict", "Only this person's manager can handle held questions");
    const policy = await this.managerNotificationPolicy();
    if (!policy.ok) return policy;
    this.releaseExpiredQuestions();
    if (input.action === "list") {
      const rows = this.sql(`SELECT q.*,r.manager_id,r.deadline_at,r.state routing,r.forwarded_id,o.thread_id origin_thread_id FROM thread_question_route r JOIN thread_question q ON q.id=r.question_id LEFT JOIN thread_question_origin o ON o.question_id=q.id
        WHERE r.manager_id=? AND r.state IN ('held','forwarded') AND q.accepted_at IS NULL ORDER BY q.created_at,q.rowid`).all(manager.id) as Json[];
      const questions: HeldThreadQuestion[] = rows.map(row => ({ ...this.question(row), ...(row.origin_thread_id ? { threadId: row.origin_thread_id } : {}), managerId: row.manager_id, deadlineAt: row.deadline_at,
        routing: row.routing, ...(row.forwarded_id ? { forwardedQuestionId: row.forwarded_id } : {}) }));
      return good({ action: "list", questions });
    }
    if (input.action !== "answer" && input.action !== "forward") return bad("invalid_request", "Manager question action must be list, answer or forward");
    try {
      const prior = this.request(input.requestId, input, "manager-questions"); if (!prior.ok) return prior;
      if (prior.value) return good(JSON.parse(prior.value));
      if (input.action === "answer") {
        const row = this.sql("SELECT q.thread_id FROM thread_question q JOIN thread_question_route r ON r.question_id=q.id WHERE q.id=? AND r.manager_id=?").get(input.questionId, manager.id) as Json | undefined;
        if (!row) return bad("not_found", "Held question not found for this manager");
        const answered = await this.acceptQuestion({ threadId: row.thread_id, questionId: input.questionId, selectedSuggestionIds: input.selectedSuggestionIds, text: input.text, dismissed: input.dismissed }, manager.id);
        if (!answered.ok) return answered;
        const response: ManagerQuestionsResponse = { action: "answer", receipt: answered.value };
        const accepted = this.request(input.requestId, input, "manager-questions"); if (!accepted.ok) return accepted;
        if (!accepted.value) this.recordRequest(input.requestId, input, "manager-questions", JSON.stringify(response));
        void this.routeQuestionCustody();
        return good(response);
      }
      const question = input.question;
      if (!Array.isArray(input.questionIds) || input.questionIds.length < 1 || input.questionIds.length > 100 || new Set(input.questionIds).size !== input.questionIds.length
        || input.questionIds.some(id => typeof id !== "string" || !id.trim()) || !question || typeof question.question !== "string" || !question.question.trim()
        || question.suggestions !== undefined && (!Array.isArray(question.suggestions) || question.suggestions.some(text => typeof text !== "string" || !text.trim()))
        || question.recommendedSuggestionIndex !== undefined && (!Number.isSafeInteger(question.recommendedSuggestionIndex) || question.recommendedSuggestionIndex < 0 || question.recommendedSuggestionIndex >= (question.suggestions?.length ?? 0)))
        return bad("invalid_request", "Forward requires 1..100 unique held question IDs and one authored question with valid suggestions");
      const rows = this.sql(`SELECT q.*,r.state routing FROM thread_question q JOIN thread_question_route r ON r.question_id=q.id
        WHERE q.id IN (SELECT value FROM json_each(?)) AND r.manager_id=?`).all(JSON.stringify(input.questionIds), manager.id) as Json[];
      if (rows.length !== input.questionIds.length) return bad("not_found", "One or more held questions do not belong to this manager");
      if (rows.some(row => row.accepted_at !== null || row.routing !== "held")) return bad("conflict", "Only unanswered held questions can be forwarded");
      const questionId = randomUUID(), now = Date.now();
      const suggestions = (question.suggestions ?? []).map((text, index) => ({ id: `${questionId}:${index}`, text }));
      const response: ManagerQuestionsResponse = { action: "forward", receipt: { accepted: true, questionId } };
      this.transaction(() => {
        this.sql("INSERT INTO thread_question(id,thread_id,question,suggestions,recommended_id,created_at) VALUES(?,?,?,?,?,?)").run(questionId, manager.id, question.question, JSON.stringify(suggestions), question.recommendedSuggestionIndex === undefined ? null : suggestions[question.recommendedSuggestionIndex]!.id, now);
        this.sql("INSERT INTO thread_question_event(question_id) VALUES(?)").run(questionId);
        for (const row of rows) {
          this.sql("INSERT INTO thread_question_link(original_id,forwarded_id) VALUES(?,?)").run(row.id, questionId);
          this.sql("UPDATE thread_question_route SET state='forwarded',forwarded_id=? WHERE question_id=?").run(questionId, row.id);
          const origin = this.sql("SELECT thread_id FROM thread_question_origin WHERE question_id=?").get(row.id) as Json | undefined;
          if (origin) this.queueQuestionCustody({ action: "transition", threadId: origin.thread_id, requestId: `custody-forward:${row.id}:${questionId}`, questionId: row.id, managerId: manager.id, transition: { state: "forwarded", forwardedQuestionId: questionId } });
          else this.sql("INSERT OR IGNORE INTO thread_question_event(question_id) VALUES(?)").run(row.id);
        }
        this.recordRequest(input.requestId, input, "manager-questions", JSON.stringify(response));
      });
      for (const id of new Set([manager.id, ...rows.map(row => row.thread_id)])) this.changed(id);
      void this.routeQuestionCustody();
      return good(response);
    } catch (cause) { return bad("unavailable", errorText(cause)); }
  }
  private question(row: Json): ThreadQuestion {
    return { id: row.id, threadId: row.thread_id, question: row.question,
      suggestions: JSON.parse(row.suggestions), ...(row.recommended_id ? { recommendedSuggestionId: row.recommended_id } : {}), createdAt: row.created_at };
  }
  async ask(input: AskThreadQuestions): Promise<Result<QuestionsReceipt>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (!input || typeof input.requestId !== "string" || !input.requestId.trim() || typeof input.threadId !== "string" || !input.threadId.trim()
      || !Array.isArray(input.questions) || input.questions.length === 0
      || input.questions.some(question => !question || typeof question.question !== "string" || !question.question.trim()
        || question.suggestions !== undefined && (!Array.isArray(question.suggestions) || question.suggestions.some(text => typeof text !== "string" || !text.trim()))
        || question.recommendedSuggestionIndex !== undefined && (!Number.isSafeInteger(question.recommendedSuggestionIndex)
          || question.recommendedSuggestionIndex < 0 || question.recommendedSuggestionIndex >= (question.suggestions?.length ?? 0)))) {
      return bad("invalid_request", "Provide a nonempty questions array and stable requestId. Each item needs one question; optional suggestions must contain nonblank text and any recommended index must identify one");
    }
    try {
      const prior = this.request(input.requestId, input, "ask"); if (!prior.ok) return prior;
      if (prior.value) return good({ accepted: true, questionIds: JSON.parse(prior.value) });
      const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Thread not found");
      if (thread.metadata?.archived) return bad("unavailable", "Restore this archived thread before asking questions");
      const policy = await this.managerNotificationPolicy();
      if (!policy.ok) return policy;
      const questionIds = input.questions.map(() => randomUUID());
      const manager = this.manager();
      const foreignManager = !manager && policy.value.view === "mono" ? policy.value.managerThreadId : null;
      const unresolved = !manager && !foreignManager && this.options.workersOnly === true;
      const held = manager && manager.id !== thread.id ? manager : undefined;
      const heldId = held?.id ?? foreignManager;
      this.transaction(() => {
        const now = Date.now();
        input.questions.forEach((question, index) => {
          const id = questionIds[index]!;
          const suggestions = (question.suggestions ?? []).map((text, index) => ({ id: `${id}:${index}`, text }));
          this.sql("INSERT INTO thread_question(id,thread_id,question,suggestions,recommended_id,created_at) VALUES(?,?,?,?,?,?)")
            .run(id, input.threadId, question.question, JSON.stringify(suggestions), question.recommendedSuggestionIndex === undefined ? null : suggestions[question.recommendedSuggestionIndex]!.id, now);
          if (unresolved) this.sql("INSERT INTO thread_question_unresolved(question_id,deadline_at,error) VALUES(?,?,?)").run(id, now + 2 * 60 * 60_000, this.directory ? null : "Person directory is unavailable");
          else if (heldId) this.sql("INSERT INTO thread_question_route(question_id,manager_id,deadline_at,state) VALUES(?,?,?,'held')").run(id, heldId, now + 2 * 60 * 60_000);
          else this.sql("INSERT INTO thread_question_event(question_id) VALUES(?)").run(id);
        });
        if (held) {
          const receipt = `manager-questions:${input.requestId}`;
          this.insertMessage(receipt, { requestId: receipt, threadId: held.id, senderId: thread.id, source: "notification", delivery: "steer",
            text: `New held questions from ${thread.title}. Use manager_questions_list to answer under the person's current policy or forward one rewritten question.${policy.value.view === "classic" ? " Unhandled questions become visible after two hours." : " Only your explicit thread_attention notifies the person."}` }, held.settings, false, thread.agentName);
          this.sql("UPDATE thread SET state='running' WHERE id=?").run(held.id);
        }
        if (foreignManager) {
          this.queueQuestionCustody({ action: "receive", threadId: foreignManager, requestId: `custody-ask:${input.requestId}`,
            originThreadId: thread.id, questions: questionIds.map(id => this.question(this.sql("SELECT * FROM thread_question WHERE id=?").get(id) as Json)), deadlineAt: now + 2 * 60 * 60_000 });
        }
        this.recordRequest(input.requestId, input, "ask", JSON.stringify(questionIds));
      });
      this.changed(input.threadId);
      if (foreignManager) void this.routeQuestionCustody();
      else if (unresolved) void this.resolveQuestionManagers();
      else if (held) { this.changed(held.id); this.wake(held.id); }
      return good({ accepted: true, questionIds });
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  questionEvents(after = 0, limit = 100): Result<QuestionEvents> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) return bad("invalid_request", "Invalid question cursor or limit");
    this.releaseExpiredQuestions();
    const rows = this.sql(`SELECT e.seq,q.id AS questionId,q.thread_id AS threadId,q.question,q.created_at AS time,q.accepted_at
      FROM thread_question_event e JOIN thread_question q ON q.id=e.question_id WHERE e.seq>? ORDER BY e.seq LIMIT ?`).all(after, limit) as Json[];
    return good({ cursor: rows.at(-1)?.seq ?? after, items: rows.filter(row => row.accepted_at === null).map(({ accepted_at, ...row }) => row) as QuestionEvents["items"] });
  }
  pendingQuestions(input: PendingQuestionsQuery): Result<PendingQuestions> {
    if (!input || !Array.isArray(input.locationThreadIds)
      || input.locationThreadIds.some(id => typeof id !== "string" || !id.trim())
      || Object.keys(input).some(key => key !== "locationThreadIds"))
      return bad("invalid_request", "Pending questions requires explicit nonblank location thread IDs");
    try {
      this.releaseExpiredQuestions();
      const rows = this.sql(`SELECT q.* FROM thread_question q JOIN thread t ON t.id=q.thread_id
        WHERE q.accepted_at IS NULL AND NOT EXISTS(SELECT 1 FROM thread_question_route r WHERE r.question_id=q.id AND r.state='held')
        AND NOT EXISTS(SELECT 1 FROM thread_question_origin o WHERE o.question_id=q.id)
        AND NOT EXISTS(SELECT 1 FROM thread_question_unresolved u WHERE u.question_id=q.id) ORDER BY q.thread_id,q.created_at,q.rowid`).all() as Json[];
      const ids = [...new Set([...input.locationThreadIds, ...rows.map(row => row.thread_id as string)])];
      const owners = this.sql(`SELECT id,title,metadata FROM thread WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(ids)) as Json[];
      const value: PendingQuestions = { questions: [], threads: [], errors: [] };
      const failed = new Set<string>();
      for (const row of owners) {
        try { value.threads.push({ id: row.id, title: row.title, metadata: JSON.parse(row.metadata) }); }
        catch (cause) { failed.add(row.id); value.errors.push({ threadId: row.id, message: errorText(cause) }); }
      }
      const questions = new Map<string, ThreadQuestion[]>();
      for (const row of rows) {
        if (failed.has(row.thread_id)) continue;
        try {
          const pending = questions.get(row.thread_id) ?? [];
          pending.push(this.question(row));
          questions.set(row.thread_id, pending);
        } catch (cause) { failed.add(row.thread_id); questions.delete(row.thread_id); value.errors.push({ threadId: row.thread_id, message: errorText(cause) }); }
      }
      value.questions = [...questions.values()].flat();
      return good(value);
    } catch (cause) { return bad("unavailable", errorText(cause)); }
  }
  async questions(threadId: string): Promise<Result<ThreadQuestion[]>> {
    if (!this.get(threadId)) return bad("not_found", "Thread not found");
    this.releaseExpiredQuestions();
    return good((this.sql("SELECT * FROM thread_question WHERE thread_id=? AND accepted_at IS NULL AND NOT EXISTS(SELECT 1 FROM thread_question_route r WHERE r.question_id=thread_question.id AND r.state='held') AND NOT EXISTS(SELECT 1 FROM thread_question_origin o WHERE o.question_id=thread_question.id) AND NOT EXISTS(SELECT 1 FROM thread_question_unresolved u WHERE u.question_id=thread_question.id) ORDER BY created_at,rowid").all(threadId) as Json[]).map(row => this.question(row)));
  }
  async questionState(threadId: string, questionId: string): Promise<Result<QuestionState>> {
    if (typeof threadId !== "string" || typeof questionId !== "string") return bad("invalid_request", "Thread and question IDs are required");
    const row = this.sql("SELECT * FROM thread_question WHERE id=? AND thread_id=?").get(questionId, threadId) as Json | undefined;
    if (!row) return bad("not_found", "Question not found in this thread");
    const question = this.question(row);
    if (row.accepted_at === null) return good({ question });
    const answer = JSON.parse(row.answer);
    return good({ question, answer: { text: answer.text, selectedSuggestions: question.suggestions.filter(choice => answer.selectedSuggestionIds.includes(choice.id)).map(choice => choice.text), dismissed: answer.dismissed === true, acceptedAt: row.accepted_at, ...(answer.answeredBy ? { answeredBy: answer.answeredBy } : {}) } });
  }
  private rootConsentQuestion(thread: Thread, questionId: string): boolean {
    return thread.metadata?.rootConsent === true && !!this.sql(`SELECT 1 FROM thread_request r,json_each(CASE WHEN r.kind='ask' THEN r.target ELSE '[]' END) q
      WHERE r.kind='ask' AND r.id GLOB 'consent:*:question' AND q.value=? LIMIT 1`).get(questionId);
  }
  private questionAnswerRows(threadId: string, columns: "q.*" | "q.id,q.accepted_at"): Json[] {
    if (this.get(threadId)?.metadata?.rootConsent !== true) return [];
    return this.sql(`SELECT ${columns} FROM thread_question q WHERE q.thread_id=? AND q.accepted_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM thread_request r,json_each(CASE WHEN r.kind='ask' THEN r.target ELSE '[]' END) ids WHERE r.kind='ask' AND r.id GLOB 'consent:*:question' AND ids.value=q.id)
      AND NOT EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=q.thread_id AND w.id='question-answer:'||q.id)
      ORDER BY q.accepted_at,q.rowid`).all(threadId) as Json[];
  }
  private questionAnswerEntry(row: Json): Json {
    return { type: "message", id: `question-answer:${row.id}`, parentId: null, source: "question-receipt",
      timestamp: new Date(row.accepted_at).toISOString(), message: { role: "user", timestamp: row.accepted_at,
        questionId: row.id, rootConsent: true, ...(JSON.parse(row.answer).answeredBy ? { answeredBy: JSON.parse(row.answer).answeredBy } : {}), content: [{ type: "text", text: questionAnswerBody(row, JSON.parse(row.answer)) }] } };
  }
  questionAnswerSource(threadId: string): Array<{ questionId: string; timestamp: number; entryId: string }> {
    return this.questionAnswerRows(threadId, "q.id,q.accepted_at").map(row => ({ questionId: row.id, timestamp: row.accepted_at, entryId: `question-answer:${row.id}` }));
  }
  questionAnswerSourceMessage(threadId: string, entryId: string): Result<Json> {
    if (typeof threadId !== "string" || !threadId.trim() || typeof entryId !== "string" || !entryId.startsWith("question-answer:") || entryId.length <= "question-answer:".length) return bad("invalid_request", "A thread ID and synthetic question-answer entry ID are required");
    const thread = this.get(threadId);
    if (!thread) return bad("not_found", "Thread not found");
    if (!this.rootConsentQuestion(thread, entryId.slice("question-answer:".length))
      || this.sql("SELECT 1 FROM thread_work WHERE thread_id=? AND id=?").get(threadId, entryId)) return bad("not_found", "This answer is not a synthetic question receipt in this source");
    const receipt = this.questionAnswerEntryById(threadId, entryId);
    return receipt.ok ? good(receipt.value.message) : receipt;
  }
  private questionAnswerEntryById(threadId: string, entryId: string): Result<Json> {
    if (typeof threadId !== "string" || !threadId.trim() || typeof entryId !== "string" || !entryId.startsWith("question-answer:") || entryId.length <= "question-answer:".length) return bad("invalid_request", "A thread ID and synthetic question-answer entry ID are required");
    const questionId = entryId.slice("question-answer:".length);
    const size = this.sql(`SELECT length(CAST(answer AS BLOB))+length(CAST(question AS BLOB))+length(CAST(suggestions AS BLOB)) AS bytes
      FROM thread_question WHERE thread_id=? AND id=? AND accepted_at IS NOT NULL`).get(threadId, questionId) as { bytes: number } | undefined;
    if (!size) return bad("conflict", "Question receipt changed; reopen the source page");
    if (size.bytes > CONTEXT_WINDOW_MAX_BYTES) return bad("oversized", "Question receipt record exceeds 8 MiB");
    const row = this.sql("SELECT * FROM thread_question WHERE thread_id=? AND id=? AND accepted_at IS NOT NULL").get(threadId, questionId) as Json | undefined;
    if (!row) return bad("conflict", "Question receipt changed; reopen the source page");
    const entry = this.questionAnswerEntry(row);
    const measured = measureJsonBytes(entry.message, CONTEXT_WINDOW_MAX_BYTES);
    return measured.ok ? good(entry) : measured;
  }
  private questionAnswerHistory(threadId: string): Json[] {
    return this.questionAnswerRows(threadId, "q.*").map(row => this.questionAnswerEntry(row));
  }
  /** Display-only receipt projection; root consumes these answers, not the ordinary agent's input queue. */
  projectQuestionAnswers(threadId: string, messages: Json[]): Json[] {
    const receipts = this.questionAnswerHistory(threadId).map(entry => entry.message);
    if (!receipts.length) return messages;
    return mergeTimed(messages.filter(message => !receipts.some(receipt => message.rootConsent === true && message.questionId === receipt.questionId)), receipts);
  }
  async answer(input: AnswerThreadQuestion): Promise<Result<QuestionReceipt>> {
    return this.acceptQuestion(input);
  }
  private async acceptQuestion(input: AnswerThreadQuestion, managerId?: string, custody = false): Promise<Result<QuestionReceipt>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (typeof input.threadId !== "string" || typeof input.questionId !== "string"
      || !Array.isArray(input.selectedSuggestionIds) || input.selectedSuggestionIds.some(id => typeof id !== "string")
      || new Set(input.selectedSuggestionIds).size !== input.selectedSuggestionIds.length || typeof input.text !== "string"
      || input.dismissed !== undefined && typeof input.dismissed !== "boolean"
      || input.dismissed === true && (input.selectedSuggestionIds.length > 0 || input.text.trim().length > 0)) {
      return bad("invalid_request", "Answer requires unique selectedSuggestionIds and text");
    }
    try {
      const row = this.sql("SELECT * FROM thread_question WHERE id=? AND thread_id=?").get(input.questionId, input.threadId) as Json | undefined;
      if (!row) return bad("not_found", "Question not found in this thread");
      const choices = this.question(row).suggestions;
      if (input.selectedSuggestionIds.some(id => !choices.some(choice => choice.id === id)) || !input.dismissed && !input.selectedSuggestionIds.length && !input.text.trim())
        return bad("invalid_request", "Select at least one known suggestion or provide nonblank text");
      this.releaseExpiredQuestions();
      if (this.sql("SELECT 1 FROM thread_question_unresolved WHERE question_id=?").get(row.id)) return bad("conflict", "Question manager routing is unresolved until its two-hour deadline");
      const route = this.sql("SELECT * FROM thread_question_route WHERE question_id=?").get(row.id) as Json | undefined;
      if (!custody && route && !this.get(route.manager_id)) {
        if (!this.directory) return bad("unavailable", "The person's question custody directory is unavailable");
        const receipt = await this.directory.managerQuestionCustody({ action: "answer", threadId: route.manager_id, requestId: `custody-answer:${input.questionId}:${digest(input)}`, originThreadId: input.threadId, answer: input });
        return receipt.ok ? good({ accepted: true, questionId: input.questionId }) : receipt;
      }
      if (!custody && !managerId && route?.state === "held" && route.deadline_at > Date.now()) return bad("conflict", "This question is held for the manager");
      const linked = this.sql("SELECT forwarded_id FROM thread_question_link WHERE original_id=? OR forwarded_id=? LIMIT 1").get(row.id, row.id) as { forwarded_id: string } | undefined;
      const linkedRows = linked ? this.sql(`SELECT * FROM thread_question WHERE id=? OR id IN (SELECT original_id FROM thread_question_link WHERE forwarded_id=?) ORDER BY created_at,rowid`).all(linked.forwarded_id, linked.forwarded_id) as Json[] : [row];
      const answerValue = { selectedSuggestionIds: input.selectedSuggestionIds, text: input.text, ...(input.dismissed ? { dismissed: true } : {}), ...(managerId ? { answeredBy: { kind: "manager" as const, threadId: managerId } } : {}) };
      const answer = JSON.stringify(answerValue);
      const first = linkedRows.find(question => question.accepted_at !== null);
      if (first) return linked || route || first.answer === answer ? good({ accepted: true, questionId: row.id }) : bad("conflict", "Question has already been answered differently");
      if (this.halts.has(input.threadId)) return bad("conflict", "Wait for cancellation confirmation before answering");
      const thread = this.get(input.threadId)!;
      const rootConsent = this.rootConsentQuestion(thread, row.id);
      if (!rootConsent && thread.held && thread.state === "running") {
        const halted = await this.halt(thread.id); if (!halted.ok) return halted;
        const accepted = this.sql("SELECT answer,accepted_at FROM thread_question WHERE id=?").get(row.id) as Json;
        if (accepted.accepted_at !== null) return linked || route || accepted.answer === answer ? good({ accepted: true, questionId: row.id }) : bad("conflict", "Question has already been answered differently");
      }
      const selectedText = input.selectedSuggestionIds.map(id => choices.find(choice => choice.id === id)!.text);
      const otherText = [...selectedText, ...(input.text.trim() ? [input.text] : [])].join("\n");
      const resumed = new Set<string>();
      this.transaction(() => {
        const now = Date.now();
        const raced = linkedRows.some(question => (this.sql("SELECT accepted_at FROM thread_question WHERE id=?").get(question.id) as Json).accepted_at !== null);
        if (raced) return;
        for (const question of linkedRows) {
          const value = question.id === row.id ? answerValue : { ...answerValue, selectedSuggestionIds: [], text: otherText };
          this.sql("UPDATE thread_question SET answer=?,accepted_at=? WHERE id=? AND accepted_at IS NULL").run(JSON.stringify(value), now, question.id);
          const origin = this.sql("SELECT thread_id FROM thread_question_origin WHERE question_id=?").get(question.id) as Json | undefined;
          if (origin) {
            this.queueQuestionCustody({ action: "transition", threadId: origin.thread_id, requestId: `custody-settle:${question.id}`, questionId: question.id, managerId: this.manager()!.id, transition: { state: "answered", answer: value } });
            continue;
          }
          const recipient = this.get(question.thread_id)!;
          if (this.rootConsentQuestion(recipient, question.id)) continue;
          this.sql("UPDATE thread SET held=0,state='running',metadata=json_remove(metadata,'$.archiveInterruption','$.archived','$.archivedAt') WHERE id=?").run(recipient.id);
          const body = questionAnswerBody(question, value);
          this.insertMessage(`question-answer:${question.id}`, { requestId: `question-answer:${question.id}`, threadId: recipient.id,
            ...(managerId ? { senderId: managerId } : {}), humanActivity: !managerId && input.humanActivity === true, text: managerId ? `Manager decision (not human input):\n${body}` : body,
            delivery: "steer", source: managerId ? "notification" : "explicit", replyTo: question.id }, recipient.settings, recipient.held, managerId ? this.get(managerId)?.agentName : undefined);
          this.sql("UPDATE thread SET held=0,state='running',metadata=json_remove(metadata,'$.archiveInterruption','$.archived','$.archivedAt') WHERE id=?").run(recipient.id);
          resumed.add(recipient.id);
        }
      });
      for (const question of linkedRows) this.changed(question.thread_id);
      for (const id of resumed) this.wake(id);
      void this.routeQuestionCustody();
      return good({ accepted: true, questionId: row.id });
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  async send(request: SendThread): Promise<Result<ThreadMessage>> {
    if (request.senderId && request.delivery === "queue" && this.get(request.threadId)?.metadata?.manager !== true) return bad("invalid_request", "Agents must use steer or hard steer; they cannot queue messages");
    const input = { ...request, delivery: resolveDelivery(request) };
    try {
      const prior = this.request(input.requestId, input, "send"); if (!prior.ok) return prior;
      if (prior.value) return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(prior.value) as Json));
      const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Recipient not found in this environment");
      if (thread.metadata?.archived && input.source !== "notification") return bad("unavailable", "Reopen this closed agent before sending messages");
      if (this.halts.has(thread.id)) return bad("conflict", "Wait for cancellation confirmation before resuming this thread");
      if (typeof input.text !== "string" || !input.text.trim() || !["queue", "steer", "hardSteer"].includes(input.delivery) || input.source !== undefined && !["explicit", "notification"].includes(input.source)) return bad("invalid_request", "Nonempty text and a valid delivery mode and source are required");
      if (input.source !== "notification" && this.row(thread.id)?.held && thread.state === "running") {
        const halted = await this.halt(thread.id); if (!halted.ok) return halted;
        const accepted = this.request(input.requestId, input, "send"); if (!accepted.ok) return accepted;
        if (accepted.value) return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(accepted.value) as Json));
      }
      let senderName = input.senderId ? this.get(input.senderId)?.agentName : undefined;
      if (input.senderId && !this.get(input.senderId) && this.directory) {
        const sender = await this.directory.list({ id: input.senderId, limit: 1 }); if (!sender.ok) return sender;
        senderName = sender.value.threads[0]?.agentName;
        const accepted = this.request(input.requestId, input, "send"); if (!accepted.ok) return accepted;
        if (accepted.value) return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(accepted.value) as Json));
        if (this.get(thread.id)?.metadata?.archived || this.halts.has(thread.id)) return bad("conflict", "Recipient closed during sender lookup");
      }
      let waitResult: WaitResultEvidence | undefined;
      const recipient = this.get(thread.id)!;
      const wait = recipient.waitingOnAgents;
      if (input.source === "notification" && input.senderId && (recipient.dependencies?.includes(input.senderId) || wait?.kind === "agents" && wait.threadIds.includes(input.senderId))
        && !this.get(input.senderId) && resultExecutionId(input.requestId, thread.id)) {
        const after = wait?.kind === "agents" ? wait.after : { [input.senderId]: (recipient.metadata?.peerResultAfter as Record<string, number> | undefined)?.[input.senderId] ?? 0 };
        const current = await (this.directory ?? this).await({ parentId: thread.id, threadIds: [input.senderId], after, timeoutMs: 0, currentAssignment: true });
        if (!current.ok) return current;
        waitResult = { wait, settlement: current.value.settlement };
        const accepted = this.request(input.requestId, input, "send"); if (!accepted.ok) return accepted;
        if (accepted.value) return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(accepted.value) as Json));
        if (this.get(thread.id)?.metadata?.archived || this.halts.has(thread.id)) return bad("conflict", "Recipient closed during result correlation");
      }
      const message = this.transaction(() => {
        const held = !!this.row(thread.id)?.held, explicit = input.source !== "notification";
        const result = this.insertMessage(input.requestId, input, thread.settings, explicit && held || input.delivery === "hardSteer", senderName, waitResult);
        if (explicit && held) this.sql("UPDATE thread SET held=0,state='running',metadata=json_remove(metadata,'$.archiveInterruption','$.watchStopped') WHERE id=?").run(thread.id);
        else if (!held && !thread.metadata?.archived && thread.state !== "running") this.sql("UPDATE thread SET state='running' WHERE id=?").run(thread.id);
        this.recordRequest(input.requestId, input, "send", result.id); return result;
      });
      this.changed(thread.id);
      const runtime = this.runtimes.get(thread.id);
      if (thread.metadata?.manager !== true && input.delivery === "hardSteer" && (runtime || this.opening.has(thread.id) || this.execution(thread.id) || thread.metadata?.runnerReference)) void this.halt(thread.id).then(() => this.wake(thread.id));
      this.wake(thread.id); return good(message);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  async archived(input: ArchivedThreadsQuery): Promise<Result<ArchivedThreadsResult>> {
    const valid = validateArchivedQuery(input);
    if (!valid.ok) return valid;
    if (input.kind === "count") return good({ kind: "count", total: this.archivedCount() });
    const rows = this.sql(`SELECT id,parent_id,title,updated_at,revision,json_extract(metadata,'$.archivedAt') archived_at
      FROM thread WHERE json_extract(metadata,'$.archived')=1`).all() as Array<{
      id: string; parent_id: string | null; title: string; updated_at: number; revision: number; archived_at: string | null;
    }>;
    const query = input.query?.trim().toLowerCase();
    const matches = rows.filter(row => (!input.conversationsOnly || !row.parent_id) && (!query || row.title.toLowerCase().includes(query)));
    matches.sort((left, right) => (input.order === "activity" ? right.updated_at - left.updated_at
      : (right.archived_at ?? new Date(right.updated_at).toISOString()).localeCompare(left.archived_at ?? new Date(left.updated_at).toISOString()))
      || left.id.localeCompare(right.id));
    const revision = createHash("sha256").update(JSON.stringify(matches)).digest("hex");
    if (input.revision !== undefined && input.revision !== revision) return bad("conflict", "Archived threads changed; retry the query");
    const threads = matches.slice(input.offset, input.offset + input.limit).map(row => this.get(row.id)!);
    return good({ kind: "page", total: matches.length, revision, threads });
  }
  async list(input: ThreadList = {}): Promise<Result<ThreadPage>> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return bad("invalid_request", "limit must be between 1 and 1000");
    if (input.state !== undefined && !isThreadState(input.state)) return bad("invalid_request", "Invalid thread state");
    const clauses: string[] = [], values: (string | null | number)[] = [];
    if (input.id !== undefined) { clauses.push("t.id=?"); values.push(input.id); }
    if (input.parentId !== undefined) { clauses.push("t.parent_id IS ?"); values.push(input.parentId); }
    const waiting = "json_extract(t.metadata,'$.agentWait') IS NOT NULL AND json_extract(t.metadata,'$.archived') IS NOT 1";
    if (input.state === "waiting") clauses.push(`t.state='idle' AND (${waiting})`);
    else if (input.state === "idle") clauses.push(`t.state='idle' AND NOT (${waiting})`);
    else if (input.state === "running") clauses.push("t.state='running'");
    if (input.archived === false) clauses.push("json_extract(t.metadata,'$.archived') IS NOT 1");
    else if (input.archived === true) clauses.push("json_extract(t.metadata,'$.archived') IS 1");
    if (input.cursor !== undefined) { clauses.push("t.id>?"); values.push(input.cursor); }
    const rows = this.sql(`SELECT ${ThreadService.THREAD_COLUMNS} FROM thread t ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY t.id LIMIT ?`).all(...values, limit + 1) as Json[];
    const page = rows.map(row => this.project(row));
    return good({ threads: page.slice(0, limit), ...(page.length > limit ? { nextCursor: page[limit - 1]!.id } : {}) });
  }
  async read(input: ThreadRead): Promise<Result<ThreadHistory>> {
    const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Thread not found");
    try {
      const limit = input.limit ?? 20, offset = input.offset ?? Number(input.cursor ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0
        || input.entryId !== undefined && (typeof input.entryId !== "string" || !input.entryId.trim())) return bad("invalid_request", "Invalid history page");
      const indexed = indexedThreadHistory(thread.sessionFile);
      let history: IndexedThreadHistory | undefined;
      if (!indexed.ok) {
        if (indexed.error.code !== "missing" || thread.metadata?.nativeHistoryRequired === true) return historyFailure(indexed.error);
      } else history = indexed.value;
      const metadata = history ? this.nativeContextMetadata(thread, history) : undefined;
      const receipts = metadata?.receipts ?? this.questionAnswerSource(thread.id);
      const layout = metadata?.messages ?? this.nativeContextLayout([], receipts);
      const ordinal = input.entryId === undefined ? offset : layout.findIndex(code => (code < 0 ? receipts[-code - 1]!.entryId : history!.messages[code]!.id) === input.entryId);
      if (ordinal < 0) return bad("not_found", "Transcript entry not found");
      const selected = layout.slice(ordinal, ordinal + (input.entryId === undefined ? limit : 1));
      const entries: Json[] = [];
      const page: ThreadHistory = { entries, ...(input.entryId === undefined && offset + selected.length < layout.length ? { nextCursor: String(offset + selected.length) } : {}) };
      const header = measureJsonBytes(good(page), CONTEXT_WINDOW_MAX_BYTES);
      if (!header.ok) return header;
      let bytes = header.value;
      for (const code of selected) {
        let entry: Json;
        if (code < 0) {
          const receipt = this.questionAnswerEntryById(thread.id, receipts[-code - 1]!.entryId);
          if (!receipt.ok) return receipt;
          entry = receipt.value;
        } else {
          const read = history!.read(history!.messages[code]!);
          if (!read.ok) return historyFailure(read.error);
          entry = read.value;
        }
        if (entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
          const projectedMessage = projectAnthropicNarrationMessage(entry.message);
          const content = (projectedMessage.content as Json[]).filter((block: Json) => block.type !== "thinking").map((block: Json) => {
            const { thinkingSignature, textSignature, encrypted_content, encryptedContent, thoughtSignature, ...visible } = block;
            return visible;
          });
          entry = { ...entry, message: { ...entry.message, content } };
        }
        const measured = measureJsonBytes(entry, CONTEXT_WINDOW_MAX_BYTES - bytes - Number(entries.length > 0));
        if (!measured.ok) return measured;
        bytes += measured.value + Number(entries.length > 0);
        entries.push(entry);
      }
      return good(page);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }

  update(id: string, patch: { title?: string; metadata?: Record<string, unknown>; archived?: boolean }, options: { titleSource?: "agent" } = {}): Result<Thread> {
    if (this.suspended || this.closed) return bad("unavailable", "Thread controller is suspended");
    const thread = this.get(id); if (!thread) return bad("not_found", "Thread not found");
    if (thread.metadata?.manager === true && patch.archived === true) return bad("conflict", "The manager cannot be archived");
    if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim())) return bad("invalid_request", "Thread title must be a nonempty string");
    if (patch.metadata && "titleSource" in patch.metadata && patch.metadata.titleSource !== thread.metadata?.titleSource) return bad("conflict", "Use title control instead of changing metadata.titleSource");
    if (patch.metadata && "autoArchiveViewedAt" in patch.metadata && patch.metadata.autoArchiveViewedAt !== thread.metadata?.autoArchiveViewedAt) return bad("conflict", "Use view control instead of changing metadata.autoArchiveViewedAt");
    if (patch.title !== undefined && options.titleSource === "agent" && thread.metadata?.titleSource === "manual") return bad("conflict", "The person named this thread; their title stays until they rename it again");
    if (patch.metadata && "archived" in patch.metadata && patch.archived === undefined) return bad("invalid_request", "Use the explicit archived control instead of changing metadata.archived");
    for (const key of ["agentWait", "peerDependencies", "explicitDependencies", "waitDependencies", "peerResultAfter", "peerDependents", "peerSubscriberAfter", "dependencyUpdate", "peerDependencyVersion", "dependencyError", "agentName", "cancellationRequest", "cancellationSettled", "foreground", "attentionSummary", "context", "execution", "raw", "telephoneContext", "sandbox", "sandboxProfile", "sandboxGateway", "nativeHistoryRequired", "runnerReference", "ephemeral", "manager"] as const) if (patch.metadata && key in patch.metadata && digest(patch.metadata[key] ?? null) !== digest(thread.metadata?.[key] ?? null)) return bad("conflict", `Thread ${key} is immutable`);
    if (patch.metadata && "mode" in patch.metadata && !isThreadModeName(patch.metadata.mode)) return bad("invalid_request", "A thread mode must be declared in modes.ts");
    if (!validSandboxBoundary({ ...thread.metadata, ...patch.metadata })) return bad("conflict", "Sandbox execution boundary is immutable");
    const admission = patch.metadata && "mode" in patch.metadata ? threadMode(patch.metadata.mode)!.admission : thread.admission;
    if (patch.archived && (this.execution(id) || this.runtimes.get(id)?.busy || thread.state === "running")) return bad("conflict", "Stop this thread before archiving it, or use control(update)");
    // Archiving an archived thread is a no-op rather than a fresh archivedAt: a
    // subtree cascade reaches the same thread from more than one owner.
    if (patch.archived && thread.metadata?.archived && patch.title === undefined && !patch.metadata) return good(thread);
    const metadata = { ...thread.metadata, ...patch.metadata, ...(patch.title === undefined ? {} : { titleSource: options.titleSource ?? "manual" }), ...(patch.archived === undefined ? {} : { archived: patch.archived, archivedAt: patch.archived ? new Date().toISOString() : null }) };
    this.sql("UPDATE thread SET title=?,metadata=?,admission=?,held=CASE WHEN ? THEN 0 ELSE held END,state=CASE WHEN ? THEN 'idle' ELSE state END WHERE id=?").run(patch.title?.trim() ?? thread.title, JSON.stringify(metadata), admission, patch.archived ? 1 : 0, patch.archived ? 1 : 0, id);
    this.changed(id);
    if (patch.title !== undefined && this.runtimes.has(id)) void this.serial(id, async () => {
      const runtime = this.runtimes.get(id); if (!runtime || this.suspended) return;
      await this.rpc(runtime, { type: "set_session_name", name: this.get(id)!.title });
    }).catch(error => {
      if (this.suspended || this.closed) return;
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.nameError',?) WHERE id=?").run(errorText(error), id); this.changed(id);
    });
    return good(this.get(id)!);
  }
  async cancelMessage(threadId: string, messageId: string): Promise<Result<ThreadMessage>> {
    if (this.suspended || this.closed) return bad("unavailable", "Thread controller is suspended");
    return this.serial(threadId, async () => {
      const work = this.sql("SELECT * FROM thread_work WHERE id=? AND thread_id=?").get(messageId, threadId) as Json | undefined;
      if (!work) return bad("not_found", "Message not found");
      if (work.status !== "queued") return bad("conflict", "Message has already entered execution");
      this.sql("UPDATE thread_work SET status='done',outcome='cancelled' WHERE id=?").run(messageId);
      if (!this.execution(threadId) && !this.pending(threadId).length && !this.row(threadId)?.held) this.state(threadId, "idle");
      else this.changed(threadId);
      return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(messageId) as Json));
    });
  }
  async promoteMessage(threadId: string, messageId: string, delivery: Delivery): Promise<Result<ThreadMessage>> {
    if (this.suspended || this.closed) return bad("unavailable", "Thread controller is suspended");
    if (!["queue", "steer", "hardSteer"].includes(delivery)) return bad("invalid_request", "Invalid delivery mode");
    const work = this.sql("SELECT * FROM thread_work WHERE id=? AND thread_id=?").get(messageId, threadId) as Json | undefined;
    if (!work) return bad("not_found", "Message not found");
    if (work.status !== "queued") return bad("conflict", "Message has already entered execution");
    if (delivery === "hardSteer" && this.row(threadId)?.held && this.get(threadId)?.state === "running") {
      const halted = await this.halt(threadId); if (!halted.ok) return halted;
    }
    this.sql("UPDATE thread_work SET delivery=?,front=? WHERE id=?").run(delivery, delivery === "hardSteer" ? Date.now() : 0, messageId);
    if (delivery === "hardSteer") {
      this.sql("UPDATE thread SET held=0,state='running',metadata=json_remove(metadata,'$.archiveInterruption') WHERE id=?").run(threadId);
      if (this.runtimes.has(threadId) || this.opening.has(threadId) || this.execution(threadId) || this.get(threadId)?.metadata?.runnerReference) void this.halt(threadId).then(() => this.wake(threadId));
    }
    this.changed(threadId); this.wake(threadId); return good({ ...this.message(work), delivery });
  }
  private autoArchiveViewedAt(thread: Thread): number | undefined {
    const viewedAt = thread.metadata?.autoArchiveViewedAt;
    return typeof viewedAt === "number" && Number.isSafeInteger(viewedAt) && viewedAt > 0 && viewedAt >= thread.updatedAt ? viewedAt : undefined;
  }
  private hasAutoArchiveWork(thread: Thread): boolean {
    const runtime = this.runtimes.get(thread.id);
    return !!(thread.metadata?.manager === true || thread.metadata?.startupFailure || thread.metadata?.agentWait || thread.dependencies?.length || thread.wakeSchedule || thread.state !== "idle" || thread.pendingMessages > 0
      || this.sql("SELECT 1 FROM thread_question WHERE thread_id=? AND accepted_at IS NULL LIMIT 1").get(thread.id)
      || this.execution(thread.id) || (!runtime && thread.metadata?.runnerReference) || runtime?.busy || runtime?.commandRunning
      || this.opening.has(thread.id) || this.operations.has(thread.id) || this.halts.has(thread.id) || this.waitRegistering.has(thread.id));
  }
  async control(input: ThreadControl): Promise<Result<Thread>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (!this.get(input.threadId)) return bad("not_found", "Thread not found");
    const manager = this.get(input.threadId)!.metadata?.manager === true;
    if (manager && (input.action === "close" || input.action === "stop" && input.reason === "archive" || input.action === "update" && input.archived === true))
      return bad("conflict", "The manager cannot be closed or archived; cancel its current work instead");
    if (manager && input.action === "archiveInactive") return good(this.get(input.threadId)!);
    if (input.action === "resultSubscribe") {
      if (typeof input.dependentId !== "string" || !input.dependentId.trim() || input.dependentId === input.threadId || typeof input.active !== "boolean" || input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) return bad("invalid_request", "Invalid result subscription");
      const current = this.get(input.threadId)!;
      const incoming = current.metadata?.peerDependents as string[] | undefined ?? [];
      const dependents = input.active ? [...new Set([...incoming, input.dependentId])] : incoming.filter(id => id !== input.dependentId);
      const cursors = { ...(current.metadata?.peerSubscriberAfter as Record<string, number> | undefined) };
      if (input.active) cursors[input.dependentId] = input.after ?? 0;
      else delete cursors[input.dependentId];
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.peerDependents',json(?),'$.peerSubscriberAfter',json(?)) WHERE id=?").run(JSON.stringify(dependents), JSON.stringify(cursors), current.id);
      if (input.active && !current.held && current.state === "idle" && !current.pendingMessages) {
        const settlement = this.latestSettlement(current.id);
        const result = settlement && this.sql("SELECT * FROM thread_execution WHERE id=?").get(settlement.executionId) as Json | undefined;
        if (settlement && result && this.currentAssignmentResult(result)) {
          this.queueResult(current, input.dependentId, settlement.executionId, settlement.workId, settlement.outcome, settlement.finalMessage, settlement.error);
        } else if (current.metadata?.archived) {
          this.queueResult(current, input.dependentId, `closed:${current.id}:${current.revision}`, undefined, "cancelled", null);
        }
      }
      this.changed(current.id);
      void this.routeNotifications();
      return good(this.get(current.id)!);
    }
    if (input.action === "dependencies") {
      if (this.waitRegistering.has(input.threadId)) return bad("conflict", "A wait registration is already in progress");
      this.waitRegistering.add(input.threadId);
      try {
        const updated = await this.updateDependencies(input.threadId, input.threadIds); if (!updated.ok) return updated;
        if (this.closed || this.suspended) return bad("unavailable", "Dependency registration remains with its owner during handoff");
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.agentWait') WHERE id=?").run(input.threadId);
        this.changed(input.threadId);
        return good(this.get(input.threadId)!);
      } finally { this.waitRegistering.delete(input.threadId); }
    }
    if (input.action === "placement") {
      if (typeof input.foreground !== "boolean") return bad("invalid_request", "Placement requires an explicit foreground boolean");
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.foreground',json(?)) WHERE id=?").run(JSON.stringify(input.foreground), input.threadId);
      this.changed(input.threadId);
      return good(this.get(input.threadId)!);
    }
    if (input.action === "open" || input.action === "reopen" || input.action === "restore" || input.action === "resume") {
      if (this.halts.has(input.threadId) || this.row(input.threadId)?.held && (this.execution(input.threadId) || this.runtimes.get(input.threadId)?.busy || this.capacityLedger?.current(input.threadId).some(row => row.entered_native && row.state !== "releasing"))) return bad("conflict", "Cancellation must be confirmed before reopening");
      if (this.get(input.threadId)!.metadata?.archived || this.row(input.threadId)?.held) {
        for (const row of this.capacityLedger?.current(input.threadId) ?? []) await this.releaseUnenteredCapacity(input.threadId, row.logical_execution_id);
        this.transaction(() => {
          this.sql("UPDATE thread_work SET status='done',outcome='cancelled' WHERE thread_id=? AND status!='done'").run(input.threadId);
          this.sql("DELETE FROM thread_wake WHERE thread_id=?").run(input.threadId);
          this.sql("UPDATE thread SET state='idle',held=0,metadata=json_remove(metadata,'$.archived','$.archivedAt','$.archiveInterruption','$.agentWait','$.watchStopped','$.autoArchiveViewedAt') WHERE id=?").run(input.threadId);
        });
        this.changed(input.threadId);
      }
      if (input.action === "open") {
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.foreground',json('true')) WHERE id=?").run(input.threadId);
        this.changed(input.threadId);
      }
      return good(this.get(input.threadId)!);
    }
    if (input.action === "close" || input.action === "stop" || input.action === "cancel") {
      const id = input.threadId;
      if (manager) this.sql("INSERT INTO manager_watchdog(thread_id,last_human_at,next_due_at,sequence,paused_at) VALUES(?,NULL,NULL,0,?) ON CONFLICT(thread_id) DO UPDATE SET next_due_at=NULL,paused_at=excluded.paused_at").run(id, Date.now());
      if (input.action !== "cancel" && this.get(id)?.metadata?.archived && !this.execution(id) && !this.pending(id).length && !this.runtimes.get(id)?.busy) return good(this.get(id)!);
      this.sql("UPDATE thread SET held=1,metadata=json_set(json_remove(metadata,'$.cancellationSettled'),'$.cancellationRequest',?) WHERE id=?").run(input.action === "cancel" || manager ? "cancel" : "close", id);
      this.changed(id);
      const halted = await this.halt(id); if (!halted.ok) return halted;
      return good(this.get(id)!);
    }
    if (input.action === "view") {
      if (Object.keys(input).some(key => key !== "threadId" && key !== "action")) return bad("invalid_request", "View accepts only threadId and action");
      const current = this.get(input.threadId)!;
      if (current.metadata?.archived || this.hasAutoArchiveWork(current)) return good(current);
      // Viewing is not execution activity and must not emit changed (which would re-view it).
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.autoArchiveViewedAt',?) WHERE id=?").run(Date.now(), input.threadId);
      return good(this.get(input.threadId)!);
    }
    if (input.action === "archiveInactive") {
      if (!Number.isSafeInteger(input.inactiveBefore) || input.inactiveBefore <= 0 || input.inactiveBefore > Date.now()) return bad("invalid_request", "Invalid inactivity cutoff");
      const current = this.get(input.threadId)!;
      if (current.metadata?.archived) return good(current);
      const viewedAt = this.autoArchiveViewedAt(current);
      if (viewedAt === undefined || viewedAt >= input.inactiveBefore) return good(current);
      const latest = this.get(input.threadId)!;
      if (latest.updatedAt >= input.inactiveBefore || (this.autoArchiveViewedAt(latest) ?? Infinity) >= input.inactiveBefore || this.hasAutoArchiveWork(latest)) return good(latest);
      return this.update(input.threadId, { archived: true });
    }
    if (input.action === "rename" || input.action === "title") {
      if (typeof input.title !== "string" || !input.title.trim()) return bad("invalid_request", "A thread title must be nonempty");
      return this.update(input.threadId, { title: input.title }, input.action === "title" ? { titleSource: "agent" } : {});
    }
    if (input.action === "update") {
      if (input.archived === true) { const closed = await this.control({ threadId: input.threadId, action: "close" }); if (!closed.ok) return closed; }
      if (input.archived === false) { const reopened = await this.control({ threadId: input.threadId, action: "reopen" }); if (!reopened.ok) return reopened; }
      return this.update(input.threadId, { title: input.title, metadata: input.metadata });
    }
    if (input.action === "cancelMessage" || input.action === "promoteMessage") {
      const result = input.action === "cancelMessage" ? await this.cancelMessage(input.threadId, input.messageId) : await this.promoteMessage(input.threadId, input.messageId, input.delivery);
      return result.ok ? good(this.get(input.threadId)!) : result;
    }
    if (input.action === "retryWaiting") return this.serial(input.threadId, async () => {
      const id = input.threadId, thread = this.get(id)!;
      if (this.closed || this.suspended || thread.held || thread.metadata?.archived || this.halts.has(id)) return bad("conflict", "Stopped or archived work cannot be retried");
      if (this.runtimes.has(id) || this.opening.has(id) || thread.metadata?.runnerReference) return bad("conflict", "Current native work must settle before switching its model");
      const execution = this.execution(id);
      const work = execution ? undefined : this.sql("SELECT * FROM thread_work WHERE thread_id=? AND status='queued' AND execution_id IS NULL ORDER BY priority DESC,front DESC,ordinal LIMIT 1").get(id) as Json | undefined;
      if (execution ? !thread.metadata?.providerWait : !work || !thread.metadata?.admissionWait) return bad("conflict", "Only dormant provider or admission waiting work can switch models");
      const previous = execution ? this.executionSettings(execution) : JSON.parse(work!.settings) as ThreadSettings;
      const priorSelection = resolveThreadSettings({}, previous);
      // A same-model selection must not bypass its real quota/backoff.
      if (priorSelection.ok && priorSelection.value.model === thread.settings.model) return good(thread);
      this.transaction(() => {
        const record = { executionId: execution?.id ?? null, workId: execution?.work_id ?? work!.id, previous, selected: thread.settings, providerWait: thread.metadata?.providerWait, admissionWait: thread.metadata?.admissionWait, time: Date.now() };
        this.sql("UPDATE thread SET metadata=json_insert(json_set(metadata,'$.modelRetryHistory',json(COALESCE(json_extract(metadata,'$.modelRetryHistory'),'[]'))),'$.modelRetryHistory[#]',json(?)) WHERE id=?").run(JSON.stringify(record), id);
        if (execution) {
          // Original execution attribution and native work receipts remain unchanged.
          this.sql("UPDATE thread_execution SET retry_settings=? WHERE id=? AND ended_at IS NULL").run(JSON.stringify(thread.settings), execution.id);
          const retry = { executionId: execution.id, workId: execution.work_id, model: thread.settings.model, retryAt: 0, broker: false, phase: "retry" };
          this.sql("UPDATE thread SET metadata=json_set(metadata,'$.providerWait',json(?)) WHERE id=?").run(JSON.stringify(retry), id);
        } else this.sql("UPDATE thread_work SET settings=? WHERE id=?").run(JSON.stringify(thread.settings), work!.id);
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.admissionWait') WHERE id=?").run(id);
        if ((thread.metadata?.startupFailure as Json | undefined)?.workId === (execution?.work_id ?? work!.id)) this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.startupFailure','$.executionError') WHERE id=?").run(id);
      });
      this.changed(id); this.wake(id);
      return good(this.get(id)!);
    });
    if (input.action === "settings") {
      const current = this.get(input.threadId)!, settings = resolveThreadSettings(input.settings, current.settings); if (!settings.ok) return settings;
      this.transaction(() => {
        this.sql("UPDATE thread SET settings=? WHERE id=?").run(JSON.stringify(settings.value), input.threadId);
        if (input.settings.model !== undefined) {
          const queued = this.sql("SELECT id,settings FROM thread_work WHERE thread_id=? AND status='queued' AND execution_id IS NULL").all(input.threadId) as Json[];
          for (const work of queued) {
            const accepted = JSON.parse(work.settings) as ThreadSettings;
            if (resolveThreadSettings({ model: accepted.model }).ok) continue;
            const repair = { workId: work.id, previousModel: accepted.model, model: settings.value.model, time: Date.now() };
            this.sql("UPDATE thread_work SET settings=? WHERE id=?").run(JSON.stringify({ ...accepted, model: settings.value.model }), work.id);
            this.sql("UPDATE thread SET metadata=json_insert(json_set(metadata,'$.modelSettingsRepairs',json(COALESCE(json_extract(metadata,'$.modelSettingsRepairs'),'[]'))),'$.modelSettingsRepairs[#]',json(?)) WHERE id=?").run(JSON.stringify(repair), input.threadId);
          }
        }
      });
      this.changed(input.threadId);
      // A session still opening has no native session to command yet. Wait for it, then apply the saved
      // settings to it: Voice sets thinking on the meeting thread at the moment a mention's prompt opens it.
      await this.opening.get(input.threadId)?.catch(() => undefined);
      const runtime = this.runtimes.get(input.threadId), execution = this.execution(input.threadId);
      const activeSettings: ThreadSettings | undefined = execution ? this.executionSettings(execution) : runtime?.settings;
      const activeSelection = activeSettings && resolveThreadSettings({}, activeSettings);
      // An attaching runner has no native session yet either; it keeps the saved settings for its next open.
      if (runtime?.session && activeSettings && activeSelection?.ok && activeSelection.value.model === settings.value.model) {
        const applied = { ...activeSettings };
        const remember = () => {
          runtime.settings = { ...applied };
          if (execution) this.sql(`UPDATE thread_execution SET ${execution.retry_settings ? "retry_settings" : "settings"}=? WHERE id=?`).run(JSON.stringify(applied), execution.id);
        };
        try {
          if (input.settings.speed !== undefined) {
            await this.rpc(runtime, { type: "set_speed", speed: settings.value.speed });
            applied.speed = settings.value.speed; remember();
          }
          if (input.settings.thinkingLevel !== undefined) {
            await this.rpc(runtime, { type: "set_thinking_level", level: settings.value.thinkingLevel });
            applied.thinkingLevel = settings.value.thinkingLevel; remember();
          }
        } catch (error) { return bad("unavailable", `Thread settings were saved, but the running session did not confirm applying them: ${errorText(error)}`); }
      }
      return good(this.get(input.threadId)!);
    }
    return bad("invalid_request", "Unknown thread control action");
  }
  private finishIdleCancellation(id: string): void {
    const thread = this.get(id)!;
    if (thread.metadata?.cancellationSettled) return;
    const executionId = `cancel:${id}:${thread.revision}`;
    const assignments = thread.metadata?.manager === true ? [] : this.sql(`SELECT w.id,w.sender_id FROM thread_work w WHERE w.thread_id=? AND w.sender_id IS NOT NULL AND w.sender_id!=? AND w.source='explicit'
      AND NOT EXISTS(SELECT 1 FROM thread_assignment_reply r WHERE r.work_id=w.id)`).all(id, id) as Array<{ id: string; sender_id: string }>;
    const recipients = [...new Set([...assignments.map(work => work.sender_id), ...((thread.metadata?.peerDependents as string[] | undefined) ?? [])])];
    const now = Date.now();
    this.transaction(() => {
      this.sql(`INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at,ended_at,outcome,final_message,settlement_seq)
        VALUES(?,?,?,?,?,?,'cancelled','null',(SELECT COALESCE(MAX(settlement_seq),0)+1 FROM thread_execution))`).run(executionId, id, executionId, JSON.stringify(thread.settings), now, now);
      for (const work of assignments) this.sql("INSERT INTO thread_assignment_reply(work_id,execution_id) VALUES(?,?)").run(work.id, executionId);
      for (const recipient of recipients) this.queueResult(thread, recipient, executionId, undefined, "cancelled", null);
      this.dischargeSubscribers(id, recipients);
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.cancellationSettled',json('true')) WHERE id=?").run(id);
    });
    const settlement = this.latestSettlement(id)!;
    for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_settled", ...settlement, workIds: [] } });
    void this.routeNotifications();
  }
  private completeCancellation(id: string): void {
    const request = this.get(id)?.metadata?.cancellationRequest;
    if (request !== "close" && request !== "cancel") return;
    this.transaction(() => {
      this.sql("UPDATE thread_work SET status='done',outcome='cancelled' WHERE thread_id=? AND status!='done'").run(id);
      if (this.get(id)?.metadata?.manager !== true) this.sql("DELETE FROM thread_wake WHERE thread_id=?").run(id);
      this.replaceDependencies(id, []);
      this.sql("UPDATE thread SET held=0,state='idle',metadata=json_remove(metadata,'$.cancellationRequest','$.cancellationSettled','$.archiveInterruption','$.watchStopped','$.agentWait','$.admissionWait','$.providerWait') WHERE id=?").run(id);
      if (request === "close") this.sql("UPDATE thread SET metadata=json_set(metadata,'$.archived',json('true'),'$.archivedAt',?) WHERE id=?").run(new Date().toISOString(), id);
    });
    this.changed(id);
    void this.recoverDependencies(id);
  }
  private halt(id: string): Promise<Result<Thread>> {
    const current = this.halts.get(id); if (current) return current;
    const operation = Promise.resolve().then(async (): Promise<Result<Thread>> => {
      this.phase(id, "cancelling", "Awaiting runtime cancellation confirmation");
      try {
        // A rejected startup is not a failed cancellation: inspect the retained runner directly.
        await this.opening.get(id)?.catch(() => undefined);
        await this.releaseFailedStartupCapacity(id);
        await this.recoverMissingStartupCapacity(id);
        const hadReference = !!this.get(id)?.metadata?.runnerReference;
        const runtime = this.runtimes.get(id) ?? await this.attach(id);
        if (!runtime && !hadReference && this.capacityLedger?.current(id).some(row => row.entered_native && row.state !== "releasing")) throw new Error("Native startup custody has no positive absence or settlement proof; global custody retained");
        if (runtime) {
          await this.rpc(runtime, { type: "abort" });
          const state = await this.rpc(runtime, { type: "get_state" });
          if (this.busy(state)) throw new Error("Native cancellation has not positively settled; global custody retained");
          this.adoptLanded(id, state);
        } else {
          const recovered = this.nativeInputReceipts(this.get(id)!);
          if (!recovered.ok) {
            this.sql("UPDATE thread SET held=1,state='running',metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(recovered.error.message, id);
            this.changed(id);
            return bad("cancellation_failed", recovered.error.message);
          }
          this.adoptLanded(id, recovered.value);
        }
        const retainedExecution = this.execution(id);
        if (retainedExecution) this.capacityLedger?.retain(id, retainedExecution.id, retainedExecution.work_id, "work");
        const cancelling = this.get(id)?.metadata?.cancellationRequest;
        if ((cancelling === "close" || cancelling === "cancel") && !this.execution(id)) this.finishIdleCancellation(id);
        else await this.finish(id, runtime, cancelling === "close" || cancelling === "cancel" ? "cancelled" : runtime?.outcome ?? "cancelled", cancelling ? null : runtime?.finalMessage ?? null);
        await this.releaseCapacity(id);
        if (runtime) await this.retire(id, runtime);
        if (this.suspended || this.closed) return bad("unavailable", "Halt remains with the thread owner during handoff");
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.executionError','$.admissionWait') WHERE id=?").run(id);
        this.state(id, this.row(id)?.held ? "idle" : this.pending(id).length ? "running" : "idle");
        this.completeCancellation(id);
        return good(this.get(id)!);
      } catch (error) {
        if (!this.closed && !this.suspended) {
          this.sql("UPDATE thread SET held=1,state='running',metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(errorText(error), id);
          this.changed(id);
        }
        return bad("cancellation_failed", errorText(error));
      }
    }).finally(() => this.halts.delete(id));
    this.halts.set(id, operation); return operation;
  }
  async command(id: string, command: PiCommand): Promise<Result<any>> {
    if (this.suspended || this.closed) return bad("unavailable", "Thread controller is suspended");
    if (!this.get(id)) return bad("not_found", "Thread not found");
    if (this.get(id)?.metadata?.archived) return bad("unavailable", "Restore this archived thread before using its native session");
    if (["prompt", "steer", "follow_up", "abort", "abort_bash", "abort_retry", "clear_queue", "set_model", "set_thinking_level", "set_speed", "set_session_name", "cycle_model", "cycle_thinking_level"].includes(command.type)) return bad("invalid_request", "Use thread messaging or control(settings/update) so the durable owner records this change");
    const durable = ["native_operation", "fork", "clone", "compact", "new_session", "switch_session", "navigate_tree", "bash", "cycle_model", "cycle_thinking_level", "export_html"].includes(command.type);
    const observing = ["get_input_status", "get_state", "get_context", "get_messages", "get_session_stats", "get_available_models", "get_available_thinking_levels", "get_commands", "get_fork_messages", "set_session_name", "extension_ui_response"].includes(command.type);
    if (!observing && !command.id) return bad("invalid_request", "Executing commands require a stable command.id for capacity custody");
    const commandExecution = `command:${id}:${command.id}`;
    if (durable && !command.id) return bad("invalid_request", "Conversation mutations require a stable command.id for receipt replay");
    return this.serial(id, async () => {
      let receipt = false;
      try {
        if (durable) {
          const prior = this.request(command.id!, { threadId: id, command }, "command"); if (!prior.ok) return prior;
          const saved = prior.value ? this.sql("SELECT response FROM thread_request WHERE id=?").get(command.id!) as Json | undefined : undefined;
          if (saved?.response) return JSON.parse(saved.response) as Result<unknown>;
          receipt = !!prior.value;
        }
        const execution = this.execution(id), thread=this.get(id)!, settings = thread.effectiveSettings ?? thread.settings;
        if(command.type==="get_state"&&!this.runtimes.has(id)&&!this.opening.has(id)&&!thread.metadata?.runnerReference&&(!execution||thread.metadata?.providerWait)){
          return good({...threadSettingsMetadata(settings),source:"thread-owner",sessionFile:thread.sessionFile,sessionName:thread.title,
            isStreaming:false,isCompacting:false,isBashRunning:false,localTools:0,pendingCommandCount:0,pendingMessageCount:0,
            threadState:thread.state,pendingWorkCount:thread.pendingMessages,providerWait:thread.metadata?.providerWait,admissionWait:thread.metadata?.admissionWait,
            selectedSettings:thread.settings,effectiveSettings:settings,
            lastAssistantMessage:this.latestSettlement(id)?.finalMessage??null});
        }
        if (!observing) {
          if (execution || this.runtimes.get(id)?.busy) return bad("conflict", "Wait for this thread's current execution to settle");
          if (!await this.recoverUnassignedCapacity(id)) return bad("unavailable", "Global agent capacity: retained native command custody is unresolved");
          const capacity = await this.acquireCapacity(id, commandExecution, command.id!, "command");
          if (!capacity.ok) { this.admissionWait(id, capacity.error); return capacity; }
          if (this.suspended || this.closed || this.row(id)?.held || this.halts.has(id)) { await this.releaseUnenteredCapacity(id, commandExecution); return bad("unavailable", "Command dispatch was closed before native execution"); }
          this.capacityLedger?.entered(id, commandExecution);
        }
        let runtime = await this.open(id, settings, !!execution);
        if (this.runtimes.get(id) !== runtime) runtime = await this.open(id, this.get(id)!.settings, false);
        if (!observing && (runtime.busy || execution)) return bad("conflict", "Wait for this thread's current execution to settle");
        if (durable && !receipt) { this.recordRequest(command.id!, { threadId: id, command }, "command", id); receipt = true; }
        if (!observing) { await runtime.session?.setActive?.(true); runtime.parked = false; }
        runtime.commandRunning = command.type;
        if (durable) this.state(id, "running");
        let result: any;
        try { result = command.type === "get_input_status" ? await this.inputStatus(id, runtime, command) : await this.rpc(runtime, command); } finally { runtime.commandRunning = undefined; }
        if (this.suspended) return bad("unavailable", "Command remains with the native owner during handoff");
        const response = good(result);
        if (receipt) this.sql("UPDATE thread_request SET response=? WHERE id=? AND response IS NULL").run(JSON.stringify(response), command.id!);
        if (this.halts.has(id) || this.runtimes.get(id) !== runtime) return response;
        const state = await this.rpc(runtime, { type: "get_state" });
        this.adoptReference(id, state);
        runtime.busy = this.busy(state);
        if (!runtime.busy && !observing) await this.releaseCapacity(id, commandExecution);
        if (runtime.busy) this.state(id, "running");
        else if (!this.execution(id)) {
          this.state(id, this.row(id)?.held ? "idle" : this.pending(id).length ? "running" : "idle");
          await this.park(id, runtime);
        }
        return response;
      } catch (error) {
        if (!observing && error instanceof RunnerStartupError && !this.get(id)?.metadata?.runnerReference) await this.releaseCapacity(id, commandExecution);
        const uncertain = /uncertain|indeterminate|unconfirmed.outcome/i.test(errorText(error));
        const failure = bad(error instanceof NativeRejection ? error.code : uncertain ? "conflict" : "unavailable", `${command.id ?? command.type}: ${errorText(error)}`);
        if (!this.suspended && !this.closed) {
          if (receipt && error instanceof NativeRejection) this.sql("UPDATE thread_request SET response=? WHERE id=?").run(JSON.stringify(failure), command.id!);
          this.sql("UPDATE thread SET metadata=json_set(metadata,'$.commandError',?) WHERE id=?").run(failure.ok ? "" : failure.error.message, id); this.changed(id);
        }
        return failure;
      }
    });
  }
  private execution(id: string): Json | undefined { return this.sql("SELECT * FROM thread_execution WHERE thread_id=? AND ended_at IS NULL").get(id) as Json | undefined; }
  private executionSettings(execution: Json): ThreadSettings { return JSON.parse(execution.retry_settings ?? execution.settings); }
  private effectiveSettings(id: string): ThreadSettings | undefined {
    const execution = this.execution(id);
    if (execution) return this.executionSettings(execution);
    const work = this.sql("SELECT settings FROM thread_work WHERE thread_id=? AND status!='done' ORDER BY priority DESC,front DESC,ordinal LIMIT 1").get(id) as Json | undefined;
    return work ? JSON.parse(work.settings) : this.runtimes.get(id)?.settings;
  }
  private busy(state: Json): boolean { return !!(state.isStreaming || state.isCompacting || state.isBashRunning || state.localTools > 0 || state.cancellationFailed || state.pendingCommandCount > 0 || state.pendingMessageCount > 0); }
  private nativeInputReceipts(thread: Thread): Result<ReturnType<typeof inputReceipts>> {
    const pending = new Set((this.sql("SELECT id FROM thread_work WHERE thread_id=? AND status='dispatched' AND landed_at IS NULL").all(thread.id) as Array<{ id: string }>).map(work => work.id));
    if (!pending.size) return good(inputReceipts([]));
    const indexed = indexedThreadHistory(thread.sessionFile);
    if (!indexed.ok) return indexed.error.code === "missing" ? good(inputReceipts([])) : historyFailure(indexed.error);
    const history = indexed.value;
    const kinds = new Set(["thread_input", "thread_redelivery", "thread_rejected", "thread_landed", "thread_settled", "thread_deferred", "thread_resume"]);
    const historical = new Map<string, string>();
    let historicalBytes = 0;
    let failure: ThreadError | undefined;
    function* selected(): Generator<Json> {
      for (const descriptor of history.entries) {
        const receipt = descriptor.type === "custom" && descriptor.customType !== undefined && kinds.has(descriptor.customType);
        const user = descriptor.type === "message" && "role" in descriptor && descriptor.role === "user" && historical.size > 0;
        if (!receipt && !user) continue;
        const read = history.read(descriptor);
        if (!read.ok) {
          const failed = historyFailure(read.error);
          if (!failed.ok) failure = failed.error;
          return;
        }
        const entry = read.value;
        if (user) {
          const content = entry.message.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(block => block.type === "text").map(block => block.text).join("") : "";
          const matched = [...historical].find(([, input]) => text === input || input.length > 0 && text.startsWith(`${input}\n\n`));
          if (matched) { historical.delete(matched[0]); historicalBytes -= Buffer.byteLength(matched[1]); }
          yield entry;
          continue;
        }
        const data = entry.data as Json | undefined;
        const ids = Array.isArray(data?.workIds) ? data.workIds.filter((id: unknown) => typeof id === "string" && pending.has(id)) : [];
        if (!data || !(typeof data.workId === "string" && pending.has(data.workId)) && !ids.length) continue;
        if (entry.customType === "thread_input" && !data.receiptVersion && typeof data.workId === "string") {
          const message = typeof data.message === "string" ? data.message : "";
          historicalBytes -= Buffer.byteLength(historical.get(data.workId) ?? "");
          historical.set(data.workId, message); historicalBytes += Buffer.byteLength(message);
          if (historicalBytes > CONTEXT_WINDOW_MAX_BYTES) { failure = { code: "oversized", message: "Unlanded legacy input metadata exceeds 8 MiB" }; return; }
        }
        if (entry.customType === "thread_rejected" && typeof data.workId === "string") {
          historicalBytes -= Buffer.byteLength(historical.get(data.workId) ?? ""); historical.delete(data.workId);
        }
        if (entry.customType === "thread_settled" || entry.customType === "thread_deferred") for (const id of ids) {
          historicalBytes -= Buffer.byteLength(historical.get(id) ?? ""); historical.delete(id);
        }
        yield { ...entry, data: { ...data, ...(Array.isArray(data.workIds) ? { workIds: ids } : {}) } };
      }
    }
    try {
      const receipts = inputReceipts(selected());
      return failure ? { ok: false, error: failure } : good(receipts);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  private adoptLanded(id: string, state: Json): void {
    if (this.suspended || this.closed || !Array.isArray(state.landedWorkIds)) return;
    const landed = new Set(state.landedWorkIds);
    const pending = (this.sql("SELECT id FROM thread_work WHERE thread_id=? AND status='dispatched' AND landed_at IS NULL").all(id) as { id: string }[]).filter(work => landed.has(work.id));
    if (!pending.length) return;
    this.transaction(() => {
      for (const work of pending) this.sql("UPDATE thread_work SET landed_at=? WHERE id=? AND landed_at IS NULL").run(Date.now(), work.id);
    });
    this.changed(id);
  }
  private adoptReference(id: string, state: Json): void {
    this.adoptLanded(id, state);
    const wait = this.get(id)?.metadata?.acknowledgementWait as Json | undefined;
    if (wait && (state.acceptedWorkIds?.includes(wait.workId) || state.completedWorkIds?.includes(wait.workId))) this.confirmInput(id, wait.executionId, wait.workId);
    if (this.suspended || this.closed || typeof state.sessionFile !== "string" || !state.sessionFile) return;
    const changed = this.sql("UPDATE thread SET session_file=?,metadata=json_set(metadata,'$.nativeHistoryRequired',json('true')) WHERE id=? AND (session_file!=? OR json_extract(metadata,'$.nativeHistoryRequired') IS NOT 1)").run(state.sessionFile, id, state.sessionFile).changes;
    if (changed) this.changed(id);
  }
  private async inputStatus(id: string, runtime: Runtime, command: PiCommand): Promise<InputStatus> {
    if (typeof command.commandId !== "string" || typeof command.workId !== "string") throw new NativeRejection("Input status requires commandId and workId", "invalid_request");
    let status: InputStatus;
    try { status = await this.rpc(runtime, { ...command, type: "get_input_status" }); }
    catch (error) {
      if (!(error instanceof NativeRejection) || error.message !== "Unknown command: get_input_status") throw error;
      // Retained adapters append admission synchronously before their first await. This ordered native state read
      // crosses the same runner ingress queue; absence is positive non-admission, not a timeout or file guess.
      const state = await this.rpc(runtime, { type: "get_state" });
      if (state.sessionFile !== this.get(id)?.sessionFile || !Array.isArray(state.acceptedWorkIds) || !Array.isArray(state.completedWorkIds)) throw new Error("Native input barrier did not identify its session and receipts");
      status = { state: state.acceptedWorkIds.includes(command.workId) || state.completedWorkIds.includes(command.workId) ? "accepted" : "never_accepted", commandId: command.commandId, workId: command.workId };
    }
    if (!status || status.commandId !== command.commandId || status.workId !== command.workId
      || !["accepted", "rejected", "in_flight", "never_accepted"].includes(status.state)
      || status.state === "rejected" && typeof status.error !== "string") throw new Error("Invalid native input status response");
    return status;
  }
  private rejectInput(id: string, executionId: string, workId: string, error: string): void {
    if (this.suspended || this.closed || this.row(id)?.held || this.halts.has(id) || this.execution(id)?.id !== executionId) return;
    this.transaction(() => {
      this.sql("UPDATE thread_work SET status='done',outcome='failed' WHERE id=? AND thread_id=? AND execution_id=? AND status='dispatched' AND inserted_at IS NULL AND landed_at IS NULL").run(workId, id, executionId);
      this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.acknowledgementWait') WHERE id=? AND json_extract(metadata,'$.acknowledgementWait.workId')=?").run(id, workId);
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.inputReconciliation',json(?)) WHERE id=?").run(JSON.stringify({ executionId, workId, state: "rejected", error, at: Date.now() }), id);
    });
    this.changed(id);
  }
  private confirmInput(id: string, executionId: string, workId: string): void {
    if (this.suspended || this.closed || this.row(id)?.held || this.halts.has(id) || this.execution(id)?.id !== executionId) return;
    const changed = this.sql("UPDATE thread_work SET inserted_at=COALESCE(inserted_at,?) WHERE id=? AND thread_id=? AND execution_id=? AND status='dispatched' AND inserted_at IS NULL").run(Date.now(), workId, id, executionId).changes;
    if ((this.get(id)?.metadata?.acknowledgementWait as Json | undefined)?.workId === workId) {
      this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.acknowledgementWait') WHERE id=?").run(id);
      this.changed(id);
    }
    if (changed) {
      const message = this.pending(id).find(work => work.id === workId)!;
      for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_message_inserted", workId, executionId, insertedAt: message.insertedAt, message } });
      this.changed(id);
    }
  }
  private async inputRpc(id: string, runtime: Runtime, command: PiCommand): Promise<boolean> {
    const executionId = this.execution(id)!.id, workId = String(command.workId);
    const commandId = `thread-input:${JSON.stringify([executionId, workId])}`;
    try {
      await this.rpc(runtime, { ...command, id: commandId });
      this.confirmInput(id, executionId, workId);
      return true;
    } catch (error) {
      if (!(error instanceof AcknowledgementTimeout)) throw error;
      if (this.suspended || this.closed || this.runtimes.get(id) !== runtime || this.execution(id)?.id !== executionId || this.row(id)?.held) return false;
      const recorded = this.pending(id).find(work => work.id === workId);
      if (recorded?.insertedAt || recorded?.landedAt) { this.confirmInput(id, executionId, workId); return true; }
      const since = Date.now();
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.acknowledgementWait',json(?)) WHERE id=?").run(JSON.stringify({ executionId, workId, commandId, since, nextCheckAt: since + 210_000 }), id);
      runtime.busy = true;
      this.changed(id);
      return false;
    }
  }
  private rpc(runtime: Runtime, command: PiCommand): Promise<any> {
    if (this.suspended || this.closed) return Promise.reject(new Error("Thread controller is suspended"));
    const session = runtime.session;
    if (!session) return Promise.reject(new Error("Pi session is not initialized"));
    const id = command.id ?? `${runtime.epoch}:${++runtime.commandNumber}`;
    return new Promise((resolve, reject) => {
      const timer = command.type === "native_operation" ? undefined : setTimeout(() => { runtime.waiters.delete(id); reject(new AcknowledgementTimeout(`Pi ${command.type} acknowledgement timed out; accepted work remains in custody`)); }, command.type === "compact" ? 240_000 : 30_000);
      runtime.waiters.set(id, { resolve, reject, timer });
      void session.command({ ...command, id }).catch(error => { const waiter = runtime.waiters.get(id); if (waiter) { clearTimeout(waiter.timer); runtime.waiters.delete(id); reject(error); } });
    });
  }
  private exited(id: string, runtime: Runtime, code: number | null | undefined): void {
    if (this.suspended || this.closed || this.runtimes.get(id) !== runtime) return;
    for (const waiter of runtime.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Pi session exited (${code ?? "unknown"})`)); }
    runtime.waiters.clear(); this.runtimes.delete(id);
    if (!runtime.executionId && !this.execution(id)) {
      this.projections.delete(id);
      // A startup exit can race an unacknowledged open. Its reference owns the serial absence fence.
      if (runtime.session && !this.capacityLedger?.current(id).some(row => row.entered_native && row.state !== "releasing"))
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.runnerReference') WHERE id=?").run(id);
      this.changed(id);
    }
    if (runtime.executionId) {
      const projection = this.projections.get(id);
      if (projection) { projection.activity.activityTools.clear(); projection.live.tools = []; }
      this.phase(id, "recovering", `Recovering exited runtime (${code ?? "no exit code"})`);
      this.wake(id);
    }
  }
  private attach(id: string, recoverMissing = false): Promise<Runtime | undefined> {
    const attaching = this.attaching.get(id); if (attaching) return attaching;
    const opening = this.opening.get(id); if (opening) return opening;
    const existing = this.runtimes.get(id); if (existing) return Promise.resolve(existing);
    const operation = this.attachOwned(id, recoverMissing).finally(() => this.attaching.delete(id));
    this.attaching.set(id, operation);
    return operation;
  }
  private async attachOwned(id: string, recoverMissing: boolean): Promise<Runtime | undefined> {
    const thread = this.get(id)!;
    if (thread.metadata?.runnerReference) this.phase(id, "recovering", "Reattaching retained runtime socket");
    if (thread.metadata?.runnerReference && !this.options.attachSession) throw new Error("Native runner attachment is not configured");
    const runtime: Runtime = { epoch: randomUUID(), executionId: this.execution(id)?.id, busy: true, commandNumber: 0, waiters: new Map() };
    this.runtimes.set(id, runtime);
    try {
      const output = (event: PiEvent) => this.output(id, runtime, event), exit = (code: number | null) => this.exited(id, runtime, code);
      const session = recoverMissing
        ? await this.options.recoverSession!(id, output, exit)
        : await this.options.attachSession?.(thread.metadata?.runnerReference as Parameters<AttachPiSession>[0], output, exit);
      if (session) {
        runtime.session = session;
        const state = await this.rpc(runtime, { type: "get_state" });
        this.adoptReference(id, state);
        runtime.busy = this.busy(state); runtime.finalMessage = state.lastAssistantMessage;
        return runtime;
      }
      if (!this.closed && !this.suspended) this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.runnerReference') WHERE id=?").run(id);
      this.runtimes.delete(id); return undefined;
    } catch (error) {
      if (!runtime.session && this.runtimes.get(id) === runtime) this.runtimes.delete(id);
      throw error;
    }
  }
  private environmentKey(thread: Thread, extraEnv: Record<string, string | undefined>): string {
    return digest([import.meta.url, thread.cwd, thread.metadata?.context, thread.metadata?.raw, thread.metadata?.telephoneContext, thread.metadata?.sandbox,
      thread.metadata?.execution, thread.metadata?.manager, sandboxPolicy(thread.metadata ?? {}), thread.role, thread.metadata?.watchList, thread.metadata?.mode,
      this.options.environment?.(thread), extraEnv]);
  }
  private open(id: string, settings: ThreadSettings, recovering: boolean, extraEnv: Record<string, string | undefined> = {}): Promise<Runtime> {
    const opening = this.opening.get(id); if (opening) return opening;
    const attaching = this.attaching.get(id); if (attaching) return attaching.then(runtime => runtime ?? this.open(id, settings, recovering, extraEnv));
    const existing = this.runtimes.get(id); if (existing) return Promise.resolve(existing);
    const operation = this.openOwned(id, settings, recovering, extraEnv).finally(() => this.opening.delete(id));
    this.opening.set(id, operation); return operation;
  }
  private async openOwned(id: string, settings: ThreadSettings, recovering: boolean, extraEnv: Record<string, string | undefined>): Promise<Runtime> {
    const thread = this.get(id)!;
    const recoveredExecution = recovering ? this.execution(id) : undefined;
    const providerWait = recoveredExecution && thread.metadata?.providerWait as Json | undefined;
    if(providerWait?.broker && Date.now()<providerWait.retryAt)throw new AdmissionWait("Waiting for model-broker capacity retry");
    const failure=String(providerWait?.failure??"");
    if(providerWait && (!isRateLimitError(failure)||isCompactionFailure(failure)) && Date.now()<providerWait.retryAt)throw new AdmissionWait("Waiting to retry a transient provider failure");
    if(providerWait && !this.options.admit){
      const env={...process.env,...this.options.environment?.(thread)};
      const ready=modelBrokerUrl(env)||!/^(?:anthropic|openai-codex)(?:-\d+)?\//.test(settings.model)?{available:Date.now()>=providerWait.retryAt,retryAt:providerWait.retryAt}:pooledRetryAvailability(settings.model,env);
      if(!ready.available){
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.providerWait.retryAt',?) WHERE id=?").run(ready.retryAt,id);
        this.admissionWait(id,{code:"unavailable",message:`Provider capacity unavailable for ${settings.model}; next known opportunity ${new Date(ready.retryAt).toISOString()}`});
        throw new AdmissionWait("Provider capacity unavailable");
      }
    }
    this.phase(id, recovering || thread.metadata?.runnerReference ? "recovering" : "starting", recovering ? "Restoring accepted execution" : "Opening execution runtime");
    let recoveredAdmission: ThreadAdmission | undefined;
    if (recoveredExecution) {
      if (!providerWait) this.capacityLedger?.retain(id, recoveredExecution.id, recoveredExecution.work_id, "work");
      const capacity = await this.acquireCapacity(id, recoveredExecution.id, recoveredExecution.work_id, "work");
      if (!capacity.ok) { this.admissionWait(id, capacity.error); throw new AdmissionWait(capacity.error.message); }
      if (!providerWait) this.capacityLedger?.entered(id, recoveredExecution.id);
    }
    if (recoveredExecution && this.options.admit) {
      this.phase(id, "admitting", "Acquiring a model account for retained execution");
      const admitted = await this.options.admit(thread, settings, !providerWait, recoveredExecution.id);
      if (!admitted.ok) {
        if (providerWait) await this.releaseUnenteredCapacity(id, recoveredExecution.id);
        if (admitted.error.code === "unavailable") {
          this.admissionWait(id, admitted.error);
          if(providerWait&&admitted.error.retryAt)this.sql("UPDATE thread SET metadata=json_set(metadata,'$.providerWait.retryAt',?) WHERE id=?").run(admitted.error.retryAt,id);
          throw new AdmissionWait(admitted.error.message);
        }
        throw new Error(admitted.error.message);
      }
      if (this.suspended || this.closed || this.row(id)?.held || this.halts.has(id)) { await admitted.value.release(); await this.releaseUnenteredCapacity(id, recoveredExecution.id); throw new AdmissionWait("Recovery cancelled before opening"); }
      recoveredAdmission = admitted.value; extraEnv = { ...extraEnv, ...admitted.value.env }; settings = admitted.value.settings ?? settings;
      if (recoveredExecution.retry_settings) this.sql("UPDATE thread_execution SET retry_settings=? WHERE id=? AND ended_at IS NULL").run(JSON.stringify(settings), recoveredExecution.id);
    }
    if (this.suspended || this.closed || this.row(id)?.held || this.halts.has(id)) {
      await recoveredAdmission?.release();
      if (recoveredExecution) await this.releaseUnenteredCapacity(id, recoveredExecution.id);
      throw new AdmissionWait("Opening cancelled");
    }
    const runtime: Runtime = { epoch: randomUUID(), busy: true, commandNumber: 0, waiters: new Map(), lease: recoveredAdmission, settings, environmentKey: this.environmentKey(thread, extraEnv) };
    const [provider, ...model] = settings.model.split("/");
    const context = thread.metadata?.context;
    if (context !== undefined && (!isRunContext(context) || thread.metadata?.execution === "root-repair")) throw new Error("Invalid recorded isolated execution boundary");
    const raw = thread.metadata?.raw === true;
    const telephone = thread.metadata?.telephoneContext;
    if (telephone !== undefined && (!raw || !isTelephoneContext(telephone))) throw new Error("Invalid recorded telephone boundary");
    const sandbox = thread.metadata?.sandbox === true;
    if (!validSandboxBoundary(thread.metadata ?? {})) throw new Error("Invalid recorded sandbox boundary");
    if (sandbox && thread.cwd !== join(this.options.sessionsDir, "sandboxes", id)) throw new Error("Sandbox workspace does not match its thread owner");
    if (raw && (context !== undefined || thread.metadata?.execution === "root-repair")) throw new Error("Invalid recorded raw execution boundary");
    const env: NodeJS.ProcessEnv = { ...this.options.environment?.(thread), ...extraEnv, ...(context ? { HOME: join(thread.cwd, ".home") } : {}), PI_THREAD_ID: id, PI_THREAD_SPEED: settings.speed, PI_THREAD_TOKEN: this.options.capability?.issue(id),
      PI_THREAD_DATABASE: this.options.databasePath,
      // Explicit false survives JSON transport and overrides older runners' launch environment.
      PI_THREAD_REQUIRE_SESSION: thread.metadata?.nativeHistoryRequired || recovering ? "1" : "0",
      PI_THREAD_CAN_SPAWN: sandbox ? "0" : "1",
      PI_THREAD_MANAGER: thread.metadata?.manager === true ? "1" : "0",
      PI_THREAD_LIVE_DISPATCHER: thread.metadata?.liveDispatcher === true ? "1" : "0",
      PI_THREAD_MODE: isThreadModeName(thread.metadata?.mode) ? thread.metadata.mode : undefined,
      PI_THREAD_RUNNER_REFERENCE: thread.metadata?.runnerReference ? JSON.stringify(thread.metadata.runnerReference) : undefined,
      PI_THREAD_RECOVERING: recovering ? "1" : "0",
      PI_THREAD_SESSION_KEY: digest([runtime.environmentKey, settings]) };
    const brokerUrl = modelBrokerUrl(env);
    if (brokerUrl) env.PI_MODEL_BROKER_URL = brokerUrl;
    runtime.broker=!!brokerUrl;
    this.runtimes.set(id, runtime);
    try {
      this.phase(id, recovering ? "recovering" : "starting", recovering ? "Reopening retained native session" : "Starting native session");
      if (recoveredExecution) this.capacityLedger?.entered(id, recoveredExecution.id);
      runtime.session = await this.options.openSession({ threadId: id, cwd: thread.cwd, sessionFile: thread.sessionFile,
        args: ["--provider", provider!, "--model", model.join("/"), "--thinking", settings.thinkingLevel, "--name", thread.title, ...(raw ? [RAW_ARGUMENT] : []), ...(telephone ? [TELEPHONE_CONTEXT_ARGUMENT, JSON.stringify(telephone)] : []), ...(sandbox ? [SANDBOX_ARGUMENT, SANDBOX_POLICY_ARGUMENT, JSON.stringify(sandboxPolicy(thread.metadata ?? {}))] : []), ...(context ? ["--orchestrator-context", JSON.stringify(context)] : [])], env, threads: this.directory ?? this },
        event => this.output(id, runtime, event), code => this.exited(id, runtime, code));
      const state = await this.rpc(runtime, { type: "get_state" }); this.adoptReference(id, state);
      this.clearAdmissionWait(id);
      if (env.PI_THREAD_RUNNER_REFERENCE && state.threadSessionKey !== env.PI_THREAD_SESSION_KEY) runtime.environmentKey = undefined;
      runtime.busy = this.busy(state); runtime.finalMessage = state.lastAssistantMessage;
      await this.rpc(runtime, { type: "set_session_name", name: thread.title });
      const execution = this.execution(id);
      if (recovering && execution) {
        runtime.executionId = execution.id;
        const accepted = new Set<string>(state.acceptedWorkIds ?? []), completed = new Set<string>(state.completedWorkIds ?? []);
        const works = this.sql("SELECT * FROM thread_work WHERE execution_id=? AND status!='done' ORDER BY ordinal").all(execution.id) as Json[];
        const last = state.lastAssistantMessage;
        const capacityFailure = last?.stopReason === "error" && (isTransientFailure(last.errorMessage ?? "") || last.errorMessage?.startsWith(POOLED_ACCOUNT_WAIT));
        if (!runtime.busy && completed.has(execution.work_id) && (!providerWait || !capacityFailure)) {
          await this.finish(id, runtime, settledWorkOutcome(undefined, last), last ?? null);
        } else if (!runtime.busy && works.length && !this.row(id)?.held && !this.halts.has(id)) {
          const work = works[0]!, prepared = work.prepared ? JSON.parse(work.prepared) : { text: work.text, images: JSON.parse(work.images) };
          this.phase(id, "preparing", "Resuming accepted input in runtime");
          if (!await this.inputRpc(id, runtime, { type: "prompt", workId: work.id, message: formatThreadMessage(this.message(work), prepared.text), inputOrigin: this.inputOrigin(id, work.id), images: prepared.images, resume: accepted.has(work.id) || work.inserted_at !== null, ...(providerWait ? { resumeProviderWait: true } : {}) })) return runtime;
          if(providerWait)this.sql("UPDATE thread SET metadata=json_set(json_remove(metadata,'$.providerWait','$.admissionWait'),'$.providerRetry',json(?)) WHERE id=?").run(JSON.stringify({executionId:providerWait.executionId,attempts:providerWait.attempts??1}),id);
          this.sql("UPDATE thread_work SET landed_at=COALESCE(landed_at,?) WHERE id=?").run(Date.now(), work.id);
          runtime.busy = true;
        }
      }
      this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.startupFailure') WHERE id=?").run(id);
      return runtime;
    } catch (error) {
      if (!this.suspended) {
        this.runtimes.delete(id);
        try { if (runtime.session && !runtime.busy) await runtime.session.close(); }
        finally { await recoveredAdmission?.release(); }
      }
      throw error;
    }
  }
  private output(id: string, runtime: Runtime, event: PiEvent): void {
    if (this.runtimes.get(id) !== runtime || this.closed || this.suspended) return;
    const parsed = parseRuntimeEvent(event);
    if (!parsed.ok) {
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(parsed.error, id);
      this.changed(id);
      for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_error", error: parsed.error } });
      return;
    }
    // Runner events carry their production time; in-process sessions are stamped here.
    if (typeof event.emittedAt !== "number") event.emittedAt = Date.now();
    const projection = this.projections.get(id) ?? { live: { text: "", thinking: "", isThinking: false, tools: [] }, activity: createExecutionActivity() };
    this.projections.set(id, projection);
    observeExecutionActivity(projection.activity, event);
    if (event.type === "message_start" && (event.message as Json)?.role === "assistant") {
      projection.live.text = ""; projection.live.thinking = "";
      projection.live.messageTimestamp = typeof (event.message as Json).timestamp === "number" ? (event.message as Json).timestamp : null;
    }
    if (event.type === "message_end" && (event.message as Json)?.role === "assistant") {
      projection.live.text = ""; projection.live.thinking = ""; projection.live.messageTimestamp = null;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as Json;
      if (update?.type === "text_delta") projection.live.text += String(update.delta ?? "");
      if (update?.type === "thinking_delta") projection.live.thinking += String(update.delta ?? "");
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      let tool = projection.live.tools.find((tool: Json) => tool.toolCallId === event.toolCallId);
      if (!tool) { tool = { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }; projection.live.tools.push(tool); }
      if (event.type === "tool_execution_update") tool.output = event.partialResult;
    }
    if (event.type === "tool_execution_end") projection.live.tools = projection.live.tools.filter((tool: Json) => tool.toolCallId !== event.toolCallId);
    if (event.type === "response" && event.command === "get_state" && event.success && (event.data as Json)?.live) {
      const live = (event.data as Json).live;
      projection.live.text = live.text ?? "";
      projection.live.thinking = live.thinking ?? "";
      projection.live.messageTimestamp = typeof live.messageTimestamp === "number" ? live.messageTimestamp : null;
      if (live.activity || live.isThinking || live.tools?.length) restoreExecutionActivity(projection.activity, live);
      if (Array.isArray(live.tools)) projection.live.tools = live.tools;
    }
    projection.live.isThinking = projection.activity.activity === "thinking";
    Object.assign(projection.live, executionActivitySnapshot(projection.activity));
    if (event.type === "agent_end" || event.type === "agent_settled") projection.live.tools = [];
    if (event.type === "message_start" && (event.message as Json)?.role === "user") {
      if (typeof event.inputWorkId === "string") this.adoptLanded(id, { landedWorkIds: [event.inputWorkId] });
      else this.land(id, contentText((event.message as Json).content, ""));
    }
    if (event.type === "response") {
      const waiter = runtime.waiters.get(String(event.id)), inputReceipt = inputCommandReceipt(event.id);
      if (event.inputUnconfirmed === true) {
        if (waiter) { clearTimeout(waiter.timer); runtime.waiters.delete(String(event.id)); waiter.reject(new AcknowledgementTimeout(String(event.error))); }
        return;
      }
      if (waiter) { clearTimeout(waiter.timer); runtime.waiters.delete(String(event.id)); event.success === false ? waiter.reject(new NativeRejection(String(event.error ?? "Pi command rejected"), event.errorCode === "oversized" || event.errorCode === "invalid_request" ? event.errorCode : "unavailable")) : waiter.resolve(event.data ?? {}); }
      else if (inputReceipt) {
        const [executionId, workId] = inputReceipt;
        if (this.execution(id)?.id === executionId && !this.row(id)?.held && !this.halts.has(id)) {
          if (event.success === false) void this.serial(id, async () => {
            if (this.runtimes.get(id) !== runtime || this.execution(id)?.id !== executionId || this.row(id)?.held) return;
            await this.finish(id, runtime, "failed", null, String(event.error ?? "Pi input rejected"));
          });
          else { this.confirmInput(id, executionId, workId); this.wake(id); }
        }
      }
    }
    if (event.type === "runner_attached") {
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.runnerReference',json(?)) WHERE id=?")
        .run(JSON.stringify({ control: event.control, socketPath: event.socketPath }), id);
      return;
    }
    if (event.type === "command_settled") {
      const response = event.response as Json;
      this.sql("UPDATE thread_request SET response=? WHERE id=? AND kind='command'").run(JSON.stringify(response.success ? good(response.data) : bad("unavailable", String(response.error))), String(event.commandId));
      this.sql("UPDATE thread SET metadata=json_set(metadata,'$.commandError',?) WHERE id=?").run(response.success ? null : String(response.error), id);
      this.changed(id);
    }
    if (event.type === "agent_start" || event.type === "compaction_start" || event.type === "auto_compaction_start") { runtime.busy = true; if (!this.row(id)?.held) this.state(id, "running"); }
    if (event.type === "message_end" && (event.message as Json)?.role === "assistant") runtime.finalMessage = event.message as Json;
    if (event.type === "agent_settled" && (event.workIds as string[] | undefined)?.includes(this.execution(id)?.work_id)) {
      runtime.finalMessage = event.lastAssistantMessage as Json | undefined;
      runtime.outcome = event.outcome as WorkOutcome;
    }
    if (event.type === "session_changed") this.adoptReference(id, event);
    for (const listener of this.listeners) listener({ threadId: id, event });
    if (!this.halts.has(id) && (event.type === "agent_settled" || event.type === "compaction_end" || event.type === "auto_compaction_end")) {
      const executionId = runtime.executionId;
      void this.serial(id, async () => {
        if (this.runtimes.get(id) !== runtime || runtime.executionId !== executionId || event.type !== "agent_settled" && runtime.executionId) return;
        const execution = this.execution(id);
        if (execution && Array.isArray(event.workIds) && !event.workIds.includes(execution.work_id)) return;
        const state = await this.rpc(runtime, { type: "get_state" }); this.adoptReference(id, state);
        if (this.busy(state)) return;
        if (execution && Array.isArray(state.completedWorkIds) && !state.completedWorkIds.includes(execution.work_id)) return;
        if (!runtime.executionId) { runtime.busy = false; await this.releaseCapacity(id); this.clearAdmissionWait(id); this.state(id, this.row(id)?.held ? "idle" : this.pending(id).length ? "running" : "idle"); await this.park(id, runtime); return; }
        const last = "lastAssistantMessage" in event ? event.lastAssistantMessage as Json | null : state.lastAssistantMessage ?? runtime.finalMessage;
        const outcome = settledWorkOutcome(event.outcome, last);
        const settledOutcome = this.row(id)?.held ? "cancelled" : outcome;
        await this.finish(id, runtime, settledOutcome, last ?? null, settledOutcome === "failed" ? last?.errorMessage : undefined);
      }).then(() => this.wake(id)).catch(error => {
        if (this.closed || this.suspended) return;
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(errorText(error), id); this.changed(id);
        for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_error", error: errorText(error) } });
      });
    }
  }
  private queuedWork(id: string): boolean { return !!this.sql("SELECT 1 FROM thread_work WHERE id=? AND status='queued'").get(id); }
  private async drain(id: string): Promise<void> {
    if (this.suspended || this.closed) return;
    const thread = this.get(id); if (!thread || thread.metadata?.archived || this.row(id)?.held || this.halts.has(id) || this.closed) return;
    const env = this.options.environment?.(thread);
    if (env && [env.PI_MODEL_DELIVERY_TIMEZONE, env.PI_PERSON_TIMEZONE_FILE, env.PI_PERSON_SETTINGS_DATA, env.PI_REMOTE_DATA].some(value => value !== undefined)) {
      const timezone = readMessageDeliveryTimezone(env);
      if (!timezone.ok) {
        this.admissionWait(id, { code: timezone.error.code === "invalid" ? "invalid_request" : "unavailable", message: `Owner timezone authority is not ready: ${timezone.error.message}` });
        return;
      }
    }
    if (!await this.recoverUnassignedCapacity(id)) return;
    const admissionWait = thread.metadata?.admissionWait as Json | undefined;
    if (Number(admissionWait?.retryAt) > Date.now()) return;
    const startup = thread.metadata?.startupFailure as Json | undefined;
    const nextWork = this.execution(id)?.work_id ?? this.pending(id)[0]?.id;
    if (startup && startup.workId === nextWork && Number(startup.retryAt) > Date.now()) return;
    let execution = this.execution(id), runtime = this.runtimes.get(id);
    if ((execution || runtime || thread.metadata?.runnerReference) && this.pending(id).some(work => work.delivery === "hardSteer" && work.state === "queued")) {
      const halted = await this.halt(id); if (!halted.ok) return;
      execution = undefined; runtime = undefined;
    }
    if (execution && !runtime) runtime = await this.open(id, this.executionSettings(execution), true);
    execution = this.execution(id);
    const acknowledgement = this.get(id)?.metadata?.acknowledgementWait as Json | undefined;
    if (acknowledgement && execution?.id === acknowledgement.executionId && runtime) {
      if (Date.now() >= acknowledgement.nextCheckAt) {
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.acknowledgementWait.overdue',json('true'),'$.acknowledgementWait.nextCheckAt',?) WHERE id=?").run(Date.now() + 30_000, id);
        this.changed(id);
        try {
          const status = await this.inputStatus(id, runtime, { type: "get_input_status", commandId: acknowledgement.commandId, workId: acknowledgement.workId });
          if (status.state === "accepted") this.confirmInput(id, acknowledgement.executionId, acknowledgement.workId);
          else if (status.state === "rejected" || status.state === "never_accepted") this.rejectInput(id, acknowledgement.executionId, acknowledgement.workId,
            status.state === "rejected" ? status.error : "Native ingress barrier proves this input was never accepted; no replay performed");
        }
        catch (error) {
          if (!(error instanceof AcknowledgementTimeout)) throw error;
        }
      }
      if (this.get(id)?.metadata?.acknowledgementWait) return;
    }
    const work = this.sql(`SELECT * FROM thread_work WHERE thread_id=? AND status='queued' ${execution ? "AND delivery IN ('steer','hardSteer')" : ""} ORDER BY priority DESC,front DESC,ordinal LIMIT 1`).get(id) as Json | undefined;
    if (!work) { if (!execution && !runtime?.busy) { this.state(id, "idle"); if (runtime) await this.park(id, runtime); } return; }
    const stillNext = () => thread.metadata?.manager !== true || (this.sql(`SELECT id FROM thread_work WHERE thread_id=? AND status='queued' ${execution ? "AND delivery IN ('steer','hardSteer')" : ""} ORDER BY priority DESC,front DESC,ordinal LIMIT 1`).get(id) as Json | undefined)?.id === work.id;
    if (!execution && runtime?.busy) return;
    if (work.id.startsWith(MANAGER_WATCHDOG_PREFIX)
      && (!await this.validateManagerCheck(id, work.id) || this.managerWatchdogApproved !== work.id || !this.queuedWork(work.id))) return;
    if (work.prepared === null) {
      if (!execution) this.phase(id, "preparing", "Preparing queued input and attachments");
      const prepared = this.options.prepareMessage ? await this.options.prepareMessage(thread, this.message(work)) : good({ text: work.text as string, images: JSON.parse(work.images) as unknown[] });
      if (!prepared.ok) throw new Error(prepared.error.message);
      if (this.suspended || this.row(id)?.held || this.halts.has(id) || !this.queuedWork(work.id)) return;
      work.prepared = JSON.stringify(prepared.value);
      this.sql("UPDATE thread_work SET prepared=? WHERE id=? AND prepared IS NULL").run(work.prepared, work.id);
    }
    if (!stillNext()) { this.wake(id); return; }
    if (!execution) {
      const settings = JSON.parse(work.settings) as ThreadSettings, executionId = this.capacityLedger?.candidate(id, work.id) ?? randomUUID();
      this.phase(id, "admitting", "Acquiring global execution capacity");
      const capacity = await this.acquireCapacity(id, executionId, work.id, "work");
      if (!capacity.ok) { this.admissionWait(id, capacity.error); return; }
      if (this.suspended || this.closed || this.row(id)?.held || this.halts.has(id) || !this.queuedWork(work.id) || !stillNext()) { await this.releaseUnenteredCapacity(id, executionId); this.wake(id); return; }
      this.phase(id, "admitting", "Acquiring a model account");
      const admission = this.options.admit ? await this.options.admit(thread, settings, false, executionId) : good<ThreadAdmission>({ release() {} });
      if (!this.queuedWork(work.id) || !stillNext()) { if (admission.ok) await admission.value.release(); await this.releaseUnenteredCapacity(id, executionId); this.wake(id); return; }
      if (!admission.ok) {
        await this.releaseUnenteredCapacity(id, executionId);
        // Capacity refusals are retried by reconcile; anything else will refuse identically forever.
        if (admission.error.code !== "unavailable") { await this.rejectStartup(id, admission.error.message); return; }
        this.admissionWait(id, admission.error); return;
      }
      if (this.suspended || this.row(id)?.held || this.halts.has(id)) { await admission.value.release(); await this.releaseUnenteredCapacity(id, executionId); return; }
      const effectiveSettings = admission.value.settings ?? settings;
      this.state(id, "running");
      try {
        if (runtime && (runtime.environmentKey !== this.environmentKey(thread, admission.value.env ?? {}) || digest(runtime.settings ?? null) !== digest(effectiveSettings))) {
          await this.retire(id, runtime); runtime = undefined;
        }
        this.capacityLedger?.entered(id, executionId);
        runtime = await this.open(id, effectiveSettings, false, admission.value.env);
        try { await runtime.session?.setActive?.(true); }
        catch (error) {
          if (this.runtimes.get(id) === runtime) throw error;
          // Reclamation raced admission. No work has entered native custody yet.
          runtime = await this.open(id, effectiveSettings, false, admission.value.env);
          await runtime.session?.setActive?.(true);
        }
        this.clearAdmissionWait(id);
        runtime.parked = false;
      } catch (error) {
        await admission.value.release();
        if (error instanceof RunnerStartupError && !this.get(id)?.metadata?.runnerReference) await this.releaseCapacity(id, executionId);
        throw error;
      }
      this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.startupFailure') WHERE id=?").run(id);
      runtime.lease = admission.value;
      if (this.suspended || this.row(id)?.held || this.halts.has(id) || !this.queuedWork(work.id) || !stillNext()) {
        await admission.value.release(); runtime.lease = undefined;
        if (!runtime.busy) await this.releaseCapacity(id, executionId);
        if (!this.halts.has(id)) await this.retire(id, runtime);
        this.wake(id); return;
      }
      this.transaction(() => {
        this.sql("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES(?,?,?,?,?)").run(executionId, id, work.id, JSON.stringify(admission.value.settings ?? settings), Date.now());
        this.sql("UPDATE thread_work SET status='dispatched',execution_id=? WHERE id=?").run(executionId, work.id);
      });
      runtime.executionId = executionId; runtime.finalMessage = undefined; runtime.outcome = undefined; execution = this.execution(id)!;
    } else this.sql("UPDATE thread_work SET status='dispatched',execution_id=? WHERE id=?").run(execution.id, work.id);
    try {
      const prepared = JSON.parse(work.prepared);
      const prompt = !runtime!.busy;
      if (prompt) this.phase(id, "preparing", "Delivering accepted input to runtime");
      if (!await this.inputRpc(id, runtime!, { type: prompt ? "prompt" : "steer", workId: work.id, message: formatThreadMessage(this.message(work), prepared.text), inputOrigin: this.inputOrigin(id, work.id), images: prepared.images ?? [] })) return;
      const insertedAt = Date.now();
      if (this.suspended || this.row(id)?.held || this.halts.has(id) || this.runtimes.get(id) !== runtime) return;
      this.sql("UPDATE thread_work SET inserted_at=COALESCE(inserted_at,?),landed_at=CASE WHEN ? THEN COALESCE(landed_at,?) ELSE landed_at END WHERE id=? AND status='dispatched'").run(insertedAt, prompt ? 1 : 0, insertedAt, work.id);
      runtime!.busy = true; this.state(id, "running");
      this.wake(id);
    } catch (error) {
      if (this.halts.has(id) || this.runtimes.get(id) !== runtime) return;
      if (error instanceof NativeRejection && !this.suspended && runtime) {
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(error.message, id);
        await this.finish(id, runtime, "failed", null);
      } else throw error;
    }
  }
  /**
   * How a watch check ended, for recording on its items. A check is open only while it still has work of its own
   * (a turn, queued input, a dependency wait or wake); pending questions do not keep it open. A held or archived check
   * without a settlement did not finish.
   */
  watchCheckOutcome(id: string): Result<import("./watch-list.js").WatchCheckOutcome> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    try {
      const thread = this.get(id);
      if (!thread) return good({ status: "missing" });
      const ended = !!thread.held || !!thread.metadata?.archived;
      if (!ended && (threadHasOutstandingWork(thread) || this.execution(id) || this.opening.has(id))) return good({ status: "open" });
      const settlement = this.latestSettlement(id);
      if (settlement?.outcome === "complete") return good({ status: "complete", at: settlement.time });
      if (settlement?.outcome === "failed") return good({ status: "failed", at: settlement.time, error: settlement.error ?? "Check failed without a recorded error" });
      if (settlement?.outcome === "cancelled") return good({ status: "failed", at: settlement.time, error: "Check was cancelled before it finished" });
      const startup = (thread.metadata?.startupFailure as Json | undefined)?.error;
      if (thread.held) return good({ status: "failed", at: thread.updatedAt, error: typeof startup === "string" ? `Check failed to start: ${startup}` : "Check was stopped before it finished" });
      if (thread.metadata?.archived) return good({ status: "failed", at: thread.updatedAt, error: "Check was archived before it finished" });
      return good({ status: "failed", at: thread.updatedAt, error: "Check went idle without a settled turn" });
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  private async rejectStartup(id: string, error: string): Promise<void> {
    // Startup acknowledgements can be lost. Confirm absence or cancellation before settling.
    this.sql("UPDATE thread SET held=1 WHERE id=?").run(id);
    await this.releaseFailedStartupCapacity(id);
    await this.recoverMissingStartupCapacity(id);
    const hadReference = !!this.get(id)?.metadata?.runnerReference;
    const runtime = this.runtimes.get(id) ?? await this.attach(id);
    if (!runtime && !hadReference && this.capacityLedger?.current(id).some(row => row.entered_native && row.state !== "releasing")) throw new Error("Native startup custody has no positive absence or settlement proof; global custody retained");
    if (runtime) {
      await this.rpc(runtime, { type: "abort" });
      const state = await this.rpc(runtime, { type: "get_state" });
      if (this.busy(state)) throw new Error("Native startup cancellation has not positively settled; global custody retained");
      this.adoptLanded(id, state);
    }
    await this.releaseCapacity(id);
    this.transaction(() => {
      if (this.execution(id)) return;
      const work = this.sql("SELECT id,settings FROM thread_work WHERE thread_id=? AND status='queued' ORDER BY priority DESC,front DESC,ordinal LIMIT 1").get(id) as Json | undefined;
      if (!work) return;
      const executionId = this.capacityLedger?.candidate(id, work.id) ?? randomUUID();
      this.sql("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES(?,?,?,?,?)").run(executionId, id, work.id, work.settings, Date.now());
      this.sql("UPDATE thread_work SET status='dispatched',execution_id=? WHERE id=?").run(executionId, work.id);
    });
    if (runtime) runtime.executionId = this.execution(id)?.id;
    await this.finish(id, runtime, "failed", null, error);
    if (this.closed || this.suspended) return;
    this.sql("UPDATE thread SET state='idle',metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(error, id);
    this.changed(id);
  }
  private async waitForProvider(id:string,runtime:Runtime|undefined,execution:Json,failure:string):Promise<void>{
    const metadata=this.get(id)?.metadata, prior=metadata?.providerWait as Json|undefined, retried=metadata?.providerRetry as Json|undefined;
    const attempts=(prior?.executionId===execution.id?prior!.attempts??1:retried?.executionId===execution.id?retried!.attempts??1:0)+1;
    const wait={executionId:execution.id,workId:execution.work_id,model:this.executionSettings(execution).model,failure,attempts,since:prior?.since??Date.now(),lastActivityAt:Date.now(),retryAt:transientRetryAt(failure,attempts),broker:runtime?.broker??prior?.broker??false};
    this.sql("UPDATE thread SET state='running',metadata=json_set(metadata,'$.providerWait',json(?)) WHERE id=?").run(JSON.stringify(wait),id);
    this.admissionWait(id,{code:"unavailable",message:`Accepted work is waiting for provider capacity on ${wait.model}: ${failure}`});
    if(runtime){
      runtime.busy=false;
      if(runtime.lease){const lease=runtime.lease;runtime.lease=undefined;await lease.release();}
      // Keep execution/work custody in SQLite, but retire the idle native runner.
      runtime.executionId=undefined;
      await this.retire(id,runtime);
    }
    if (runtime && !runtime.busy) await this.releaseCapacity(id, execution.id);
    else await this.releaseUnenteredCapacity(id, execution.id);
    this.changed(id);
  }
  private queueResult(thread: Thread, recipient: string, executionId: string, workId: string | undefined, outcome: WorkOutcome, finalMessage: unknown, error?: string): boolean {
    const receipt = `thread-result:${executionId}:${recipient}`;
    if (this.sql("SELECT 1 FROM thread_work WHERE id=?").get(receipt)) return true;
    const cursor = (this.get(thread.id)?.metadata?.peerSubscriberAfter as Record<string, number> | undefined)?.[recipient];
    const settlement = this.sql("SELECT settlement_seq FROM thread_execution WHERE id=?").get(executionId) as { settlement_seq: number } | undefined;
    if (outcome !== "cancelled" && cursor !== undefined && settlement && settlement.settlement_seq <= cursor) return false;
    this.insertMessage(receipt, {
      requestId: receipt, threadId: recipient, senderId: thread.id,
      text: serializeThreadNotification({ type: "thread_idle", title: thread.title, outcome, finalMessage, ...(error ? { error } : {}) }),
      delivery: "steer", source: "notification", replyTo: workId,
    }, this.get(recipient)?.settings ?? thread.settings, false, thread.agentName);
    if (this.row(recipient)) {
      if (!this.row(recipient)?.held && !this.get(recipient)?.metadata?.archived) this.sql("UPDATE thread SET state='running' WHERE id=?").run(recipient);
      this.changed(recipient); this.wake(recipient);
    }
    return true;
  }
  private dischargeSubscribers(id: string, recipients: string[]): void {
    const thread = this.get(id)!;
    const remaining = ((thread.metadata?.peerDependents as string[] | undefined) ?? []).filter(recipient => !recipients.includes(recipient));
    const cursors = Object.fromEntries(remaining.map(recipient => [recipient, (thread.metadata?.peerSubscriberAfter as Record<string, number> | undefined)?.[recipient] ?? 0]));
    this.sql("UPDATE thread SET metadata=json_set(metadata,'$.peerDependents',json(?),'$.peerSubscriberAfter',json(?)) WHERE id=?").run(JSON.stringify(remaining), JSON.stringify(cursors), id);
  }
  private async finish(id: string, runtime: Runtime | undefined, outcome: WorkOutcome, finalMessage: Json | null, error?: string): Promise<void> {
    if (this.suspended || this.closed) return;
    const cancellation = this.get(id)?.metadata?.cancellationRequest;
    if (cancellation === "close" || cancellation === "cancel") { outcome = "cancelled"; finalMessage = null; error = undefined; }
    const failure=error??finalMessage?.errorMessage??"";
    const execution = this.execution(id); if (!execution || runtime && runtime.executionId !== execution.id) return;
    if(outcome==="failed"&&!this.row(id)?.held&&(isTransientFailure(failure)||failure.startsWith(POOLED_ACCOUNT_WAIT))){
      await this.waitForProvider(id,runtime,execution,failure);return;
    }
    this.phase(id, "finishing", "Saving turn receipts and notifying dependents");
    if (runtime && outcome === "complete") {
      const state = await this.rpc(runtime, { type: "get_state" });
      if (this.busy(state) || this.execution(id)?.id !== execution.id) return;
    }
    const thread = this.get(id)!;
    const assignmentPending = outcome !== "cancelled" && !!(thread.metadata?.agentWait || thread.dependencies?.length || thread.wakeSchedule
      || this.sql("SELECT 1 FROM thread_question WHERE thread_id=? AND accepted_at IS NULL LIMIT 1").get(id));
    const incompleteResult = outcome === "complete" && !assignmentPending
      && !(finalMessage?.role === "assistant" && finalText(finalMessage)?.trim());
    if (incompleteResult) {
      outcome = "failed";
      error = "Native turn ended without a final result or a durable dependency wait";
    }
    const assignments = assignmentPending || thread.metadata?.manager === true ? [] : this.sql(`SELECT w.id,w.sender_id FROM thread_work w WHERE w.thread_id=? AND w.sender_id IS NOT NULL AND w.sender_id!=? AND w.source='explicit'
      AND (w.status='done' OR w.execution_id=? OR ?) AND NOT EXISTS(SELECT 1 FROM thread_assignment_reply r WHERE r.work_id=w.id)`).all(id, id, execution.id, outcome === "cancelled" ? 1 : 0) as Array<{ id: string; sender_id: string }>;
    const recipients = assignmentPending ? [] : [...new Set([...assignments.map(work => work.sender_id), ...((thread.metadata?.peerDependents as string[] | undefined) ?? [])])];
    this.capacityLedger?.retain(id, execution.id, execution.work_id, "work");
    let workIds: string[] = [];
    this.transaction(() => {
      this.capacityLedger?.requestRelease(id, execution.id);
      if (outcome === "cancelled") this.sql("UPDATE thread_work SET status='queued',execution_id=NULL,inserted_at=NULL WHERE execution_id=? AND status='dispatched' AND landed_at IS NULL AND id!=?").run(execution.id, execution.work_id);
      workIds = (this.sql("SELECT id FROM thread_work WHERE execution_id=? AND status!='done'").all(execution.id) as { id: string }[]).map(work => work.id);
      this.sql("UPDATE thread_execution SET outcome=?,final_message=?,error=?,assignment_pending=?,ended_at=?,settlement_seq=(SELECT COALESCE(MAX(settlement_seq),0)+1 FROM thread_execution) WHERE id=? AND ended_at IS NULL").run(outcome, JSON.stringify(finalMessage), error ?? null, assignmentPending ? 1 : 0, Date.now(), execution.id);
      this.sql("UPDATE thread_work SET status='done',outcome=?,final_message=?,error=? WHERE execution_id=? AND status!='done'").run(outcome, JSON.stringify(finalMessage), error ?? null, execution.id);
      this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.providerWait','$.admissionWait','$.providerRetry','$.acknowledgementWait','$.incompleteResult') WHERE id=?").run(id);
      if (incompleteResult) this.sql("UPDATE thread SET metadata=json_set(metadata,'$.incompleteResult',json(?)) WHERE id=?").run(JSON.stringify({ executionId: execution.id, error }), id);
      this.sql("UPDATE thread SET state=CASE WHEN held=1 THEN 'idle' WHEN EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=thread.id AND w.status!='done') THEN 'running' ELSE 'idle' END,revision=revision+1,updated_at=? WHERE id=?").run(Date.now(), id);
      for (const work of assignments) this.sql("INSERT INTO thread_assignment_reply(work_id,execution_id) VALUES(?,?)").run(work.id, execution.id);
      const delivered = recipients.filter(recipient => this.queueResult(thread, recipient, execution.id, execution.work_id, outcome, finalMessage, error));
      if (!assignmentPending) this.dischargeSubscribers(id, delivered);
      if (cancellation === "close" || cancellation === "cancel") this.sql("UPDATE thread SET metadata=json_set(metadata,'$.cancellationSettled',json('true')) WHERE id=?").run(id);
    });
    if (runtime) { runtime.executionId = undefined; runtime.busy = false; }
    if (runtime?.lease) { const lease = runtime.lease; runtime.lease = undefined; await lease.release(); }
    await this.releaseCapacity(id, execution.id);
    if (this.suspended || this.closed) return;
    this.changed(id);
    for (const recipient of recipients) if (this.row(recipient)) {
      if (!this.row(recipient)?.held && !this.get(recipient)?.metadata?.archived) this.sql("UPDATE thread SET state='running' WHERE id=?").run(recipient);
      this.changed(recipient); this.wake(recipient);
    }
    void this.routeNotifications();
    const settled = this.sql("SELECT settlement_seq,ended_at FROM thread_execution WHERE id=?").get(execution.id) as Json;
    for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_settled", seq: settled.settlement_seq, executionId: execution.id, workId: execution.work_id, workIds, outcome, ...(assignmentPending ? { assignmentPending: true } : {}), time: settled.ended_at, finalMessage, ...(error ? { error } : {}) } });
    if (runtime) await this.park(id, runtime);
    if (!assignmentPending) this.archiveBackgroundAfterCurrentOperation(id);
  }
  private async park(id: string, runtime: Runtime): Promise<void> {
    if (this.suspended || this.halts.has(id) || !runtime.session || runtime.busy || runtime.commandRunning || runtime.executionId || this.execution(id) || this.runtimes.get(id) !== runtime) return;
    const thread = this.get(id);
    if (!thread) return;
    const completed = thread.state === "idle" && !thread.pendingMessages && !thread.waitingOnAgents && !thread.wakeSchedule;
    if (!runtime.environmentKey || thread.metadata?.archived || thread.held || completed && this.options.retireIdleSession?.(thread)) { await this.retire(id, runtime); return; }
    if (!runtime.parked) { await runtime.session.setActive?.(false); runtime.parked = true; }
  }
  private async retire(id: string, runtime: Runtime): Promise<void> {
    if (this.suspended || !runtime.session || runtime.busy || runtime.executionId || this.runtimes.get(id) !== runtime) return;
    this.runtimes.delete(id);
    try { await runtime.session.close(); this.projections.delete(id); this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.runnerReference') WHERE id=?").run(id); }
    catch (error) { if (!this.runtimes.has(id) && !this.suspended) this.runtimes.set(id, runtime); throw error; }
  }

  importState(threads: ImportThread[], messages: ImportMessage[]): Result<void> {
    if (this.started || this.suspended || this.closed) return bad("conflict", "Import requires an inactive thread controller");
    try {
      return this.transaction(() => {
        for (const thread of threads) { const result = this.importThread(thread); if (!result.ok) throw Object.assign(new Error(result.error.message), { threadError: result.error }); }
        for (const message of messages) { const result = this.importMessage(message); if (!result.ok) throw Object.assign(new Error(result.error.message), { threadError: result.error }); }
        return good(undefined);
      });
    } catch (error) { return { ok: false, error: (error as { threadError?: import("./contracts.js").ThreadError }).threadError ?? { code: "unavailable", message: errorText(error) } }; }
  }
  importThread(input: ImportThread): Result<Thread> {
    try {
      const existing = this.get(input.id); if (existing) return existing.sessionFile === input.sessionFile ? good(existing) : bad("conflict", "Imported thread identity names a different transcript");
      if (input.metadata?.context !== undefined && (!isRunContext(input.metadata.context) || input.metadata.execution === "root-repair")) return bad("invalid_request", "Invalid imported isolated execution boundary");
      if (!validSandboxBoundary(input.metadata ?? {}) || input.metadata?.sandbox && input.cwd !== join(this.options.sessionsDir, "sandboxes", input.id)) return bad("invalid_request", "Invalid imported sandbox boundary");
      if (input.metadata?.raw !== undefined && (input.metadata.raw !== true || input.metadata.context !== undefined || input.metadata.execution === "root-repair")) return bad("invalid_request", "Invalid imported raw execution boundary");
      const settings = validateThreadSettings(input.settings); if (!settings.ok) return settings;
      const metadata = { ...input.metadata, agentName: typeof input.metadata?.agentName === "string" && input.metadata.agentName.trim() ? input.metadata.agentName : getRandomName() };
      this.sql("INSERT INTO thread(id,parent_id,title,cwd,session_file,settings,admission,state,held,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.id, input.parentId ?? null, input.title, input.cwd, input.sessionFile, JSON.stringify(settings.value), input.parentId ? "force" : input.admission ?? "force", "idle", input.held ? 1 : 0, input.createdAt ?? Date.now(), input.updatedAt ?? Date.now(), JSON.stringify(metadata));
      return good(this.get(input.id)!);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  importMessage(input: ImportMessage): Result<ThreadMessage> {
    try {
      const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Import the thread before its input");
      const prior = this.sql("SELECT * FROM thread_work WHERE id=?").get(input.id) as Json | undefined;
      if (prior) return prior.thread_id === input.threadId && prior.text === input.text ? good(this.message(prior)) : bad("conflict", "Imported message identity has different input");
      const settings = validateThreadSettings(input.settings === undefined ? thread.settings : input.settings);
      if (!settings.ok) return settings;
      this.transaction(() => {
        this.insertMessage(input.id, { requestId: input.requestId ?? input.id, threadId: input.threadId, senderId: input.senderId ?? undefined, humanActivity: input.humanActivity, text: input.text, images: input.images, delivery: resolveDelivery({ senderId: input.senderId ?? undefined, delivery: input.delivery }), source: input.source, replyTo: input.replyTo }, settings.value);
        this.sql("INSERT INTO thread_request(id,hash,kind,target) VALUES(?,'import','import-message',?)").run(input.requestId ?? input.id, input.id);
        const done = input.state === "done";
        const executionId = input.executionId ?? `import:${input.id}`;
        if (input.state === "dispatched") this.sql("INSERT OR IGNORE INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES(?,?,?,?,?)").run(executionId, input.threadId, input.id, JSON.stringify(settings.value), input.createdAt ?? Date.now());
        if (done) this.sql("INSERT OR IGNORE INTO thread_execution(id,thread_id,work_id,settings,created_at,ended_at,outcome,final_message) VALUES(?,?,?,?,?,?,?,?)")
          .run(executionId, input.threadId, input.id, JSON.stringify(settings.value), input.createdAt ?? Date.now(), input.createdAt ?? Date.now(), input.outcome ?? "complete", JSON.stringify(input.finalMessage ?? null));
        this.sql("UPDATE thread_work SET status=?,execution_id=?,created_at=?,inserted_at=?,outcome=?,final_message=? WHERE id=?")
          .run(input.state ?? "queued", done || input.state === "dispatched" ? executionId : null, input.createdAt ?? Date.now(), input.insertedAt ?? null, input.outcome ?? (done ? "complete" : null), input.finalMessage === undefined ? null : JSON.stringify(input.finalMessage), input.id);
        this.sql("UPDATE thread_human_activity SET created_at=(SELECT created_at FROM thread_work WHERE id=?) WHERE work_id=?").run(input.id, input.id);
        if (!done && !this.row(input.threadId)?.held) this.sql("UPDATE thread SET state='running' WHERE id=?").run(input.threadId);
      });
      return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(input.id) as Json));
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  private async routeNotifications(): Promise<void> {
    if (!this.directory || this.routing || this.suspended || this.closed) return;
    this.routing = true;
    try {
      const pending = this.sql("SELECT w.* FROM thread_work w LEFT JOIN thread t ON t.id=w.thread_id WHERE t.id IS NULL AND w.source='notification' AND w.status='queued' ORDER BY w.ordinal").all() as Json[];
      for (const work of pending) {
        if (this.suspended) return;
        const result = await this.directory.send({ requestId: work.id, threadId: work.thread_id, senderId: work.sender_id, text: work.text, delivery: "steer", source: "notification", replyTo: work.reply_to });
        if (this.suspended) return;
        if (result.ok) this.sql("UPDATE thread_work SET status='done' WHERE id=?").run(work.id);
        else this.sql("UPDATE thread_work SET error=? WHERE id=?").run(result.error.message, work.id);
      }
    } finally { this.routing = false; }
  }
  suspend(): void {
    if (this.suspended || this.closed) return;
    this.suspended = true; this.started = false; clearInterval(this.timer);
    for (const cancel of this.awaiting) cancel();
    for (const runtime of this.runtimes.values()) {
      for (const waiter of runtime.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Thread controller suspended; execution remains with its runner")); }
      runtime.waiters.clear();
    }
  }
  retirementPending(): { operations: number; halts: number; opening: number; attaching: number; dependencies: number } {
    return { operations: this.operations.size, halts: this.halts.size, opening: this.opening.size, attaching: this.attaching.size, dependencies: this.dependencyOperations.size };
  }
  async detach(): Promise<Result<void>> {
    if (this.closed) return good(undefined);
    this.suspend();
    await Promise.allSettled([...this.operations.values(), ...this.halts.values(), ...this.opening.values(), ...this.attaching.values(), ...this.dependencyOperations.values()]);
    // Native sessions outlive controllers, including idle ones. The successor
    // retires them with its context listener already serving; shutdown hooks
    // must not hold this listener's own handoff hostage.
    for (const [id, runtime] of this.runtimes) if (runtime.session && !this.get(id)?.metadata?.runnerReference && !runtime.busy && !runtime.executionId && !this.execution(id)) {
      try {
        await runtime.session.close();
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.runnerReference') WHERE id=?").run(id);
      } catch (error) { return bad("unavailable", errorText(error)); }
    }
    this.runtimes.clear(); this.listeners.clear(); this.nativeContexts.clear();
    if (!this.closed) { this.closed = true; this.db.close(); }
    return good(undefined);
  }
  async close(): Promise<Result<void>> {
    if (this.closed) return good(undefined);
    if (this.sql("SELECT 1 FROM thread_execution WHERE ended_at IS NULL LIMIT 1").get() || [...this.runtimes.values()].some(runtime => runtime.busy) || this.operations.size || this.opening.size || this.halts.size) return bad("conflict", "Active execution must settle before controller handoff");
    this.started = false; clearInterval(this.timer);
    try {
      for (const [id, runtime] of this.runtimes) { await runtime.session?.close(); this.runtimes.delete(id); this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.runnerReference') WHERE id=?").run(id); }
      this.closed = true;
      for (const cancel of this.awaiting) cancel();
      this.db.close(); this.listeners.clear(); this.nativeContexts.clear(); return good(undefined);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
}
