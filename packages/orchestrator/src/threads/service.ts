import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readThreadHistory, visibleThreadHistory } from "pi-orchestrator/history";
import { contentText } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "../sqlite.js";
import { isRunContext } from "../isolated-context-contract.js";
import { isModelConfigurationError } from "../provider-errors.js";
import { resolveSpawnSettings, resolveThreadSettings } from "./settings.js";
import { formatThreadMessage, serializeThreadNotification } from "./message-format.js";
import { RAW_ARGUMENT } from "./pi-raw.js";
import { isThreadState, resolveDelivery, validateThreadAwait, THREAD_AWAIT_TIMEOUT_MS } from "./contracts.js";
import type { AttachPiSession, AwaitThreads, Delivery, OpenPiSession, PiCommand, PiEvent, PiSession, Result, SendThread, SpawnThread, Thread, ThreadApi, ThreadAwaitResult, ThreadControl, ThreadError, ThreadHistory, ThreadInspection, ThreadList, ThreadMessage, ThreadPage, ThreadRead, ThreadSettings, ThreadSettlement, ThreadSettlements, WorkOutcome } from "./contracts.js";

type Json = Record<string, any>;
export interface ThreadAdmission { env?: Record<string, string | undefined>; settings?: ThreadSettings; release(): void | Promise<void> }
export interface ThreadServiceOptions {
  databasePath: string;
  sessionsDir: string;
  openSession: OpenPiSession;
  attachSession?: AttachPiSession;
  workersOnly?: boolean;
  environment?: (thread: Thread) => Record<string, string | undefined>;
  admit?: (thread: Thread, settings: ThreadSettings, recovering: boolean, executionId: string) => Promise<Result<ThreadAdmission>>;
  prepareMessage?: (thread: Thread, message: ThreadMessage) => Promise<Result<{ text: string; images?: unknown[] }>>;
  onChange?: (thread: Thread) => void;
}
export type ThreadServiceEvent = { threadId: string; event: PiEvent } | { threadId: string; type: "changed" };
export type PendingMessage = Omit<ThreadMessage, "state" | "insertedAt" | "landedAt"> & { state: "queued" | "dispatched"; insertedAt: number | null; landedAt: number | null };
export interface ImportThread {
  id: string; parentId?: string | null; title: string; cwd: string; sessionFile: string;
  settings: ThreadSettings; admission?: "force" | "background"; held?: boolean;
  createdAt?: number; updatedAt?: number; metadata?: Record<string, unknown>;
}
export interface ImportMessage {
  id: string; threadId: string; requestId?: string; senderId?: string | null; text: string; images?: unknown[];
  delivery?: Delivery; source?: "explicit" | "notification"; replyTo?: string; createdAt?: number;
  state?: "queued" | "dispatched" | "done"; insertedAt?: number; outcome?: WorkOutcome;
  executionId?: string; finalMessage?: Record<string, unknown> | null; settings?: ThreadSettings;
}
class NativeRejection extends Error {}
class AdmissionWait extends Error {}
interface Runtime {
  session: PiSession; epoch: string; executionId?: string; lease?: ThreadAdmission; busy: boolean; settings?: ThreadSettings;
  finalMessage?: Json; outcome?: WorkOutcome; commandRunning?: string; commandNumber: number; waiters: Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
}
const good = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = <T = never>(code: "not_found" | "invalid_request" | "conflict" | "no_pending_messages" | "unavailable" | "cancellation_failed", message: string): Result<T> => ({ ok: false, error: { code, message } });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export class ThreadService implements ThreadApi {
  private readonly db: DatabaseSync;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly halts = new Map<string, Promise<Result<Thread>>>();
  private readonly opening = new Map<string, Promise<Runtime>>();
  private readonly listeners = new Set<(event: ThreadServiceEvent) => void>();
  private readonly awaiting = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private suspended = false;
  private directory?: ThreadApi;
  private workerOwner?: (parent: Thread, input: SpawnThread) => ThreadApi | undefined;
  private routing = false;
  private transactionDepth = 0;
  private readonly projections = new Map<string, { context?: Json; live: Json }>();
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
    if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true });
    mkdirSync(options.sessionsDir, { recursive: true });
    this.db = openSqlite(options.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS thread (
        id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, cwd TEXT NOT NULL, session_file TEXT NOT NULL,
        settings TEXT NOT NULL, admission TEXT NOT NULL, state TEXT NOT NULL, held INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS thread_parent ON thread(parent_id,updated_at);
      CREATE TABLE IF NOT EXISTS thread_work (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
        sender_id TEXT, text TEXT NOT NULL, images TEXT NOT NULL, delivery TEXT NOT NULL, source TEXT NOT NULL,
        reply_to TEXT, status TEXT NOT NULL DEFAULT 'queued', front INTEGER NOT NULL DEFAULT 0,
        settings TEXT NOT NULL, prepared TEXT, execution_id TEXT, created_at INTEGER NOT NULL, inserted_at INTEGER,
        landed_at INTEGER, outcome TEXT, final_message TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS thread_work_queue ON thread_work(thread_id,status,front DESC,ordinal);
      CREATE TABLE IF NOT EXISTS thread_execution (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES thread(id), work_id TEXT NOT NULL,
        settings TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, settlement_seq INTEGER UNIQUE, outcome TEXT, final_message TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS thread_request (id TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, response TEXT);
      DROP INDEX IF EXISTS thread_execution_active;
      UPDATE thread SET state='idle',held=1 WHERE state='stopped';
      UPDATE thread_work SET status='dispatched' WHERE status IN ('dispatching','inserted');`);
    const executionColumns = this.sql("PRAGMA table_info(thread_execution)").all() as { name: string }[];
    if (executionColumns.some(column => column.name === "state")) this.db.exec("ALTER TABLE thread_execution DROP COLUMN state");
    if (!(this.sql("PRAGMA table_info(thread_work)").all() as { name: string }[]).some(column => column.name === "landed_at")) this.db.exec("ALTER TABLE thread_work ADD COLUMN landed_at INTEGER; UPDATE thread_work SET landed_at=inserted_at WHERE status='dispatched' AND inserted_at IS NOT NULL");
    this.db.exec(`CREATE INDEX IF NOT EXISTS thread_execution_settlements ON thread_execution(thread_id,ended_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS thread_execution_await ON thread_execution(thread_id,settlement_seq);
      CREATE UNIQUE INDEX IF NOT EXISTS thread_execution_active ON thread_execution(thread_id) WHERE ended_at IS NULL;
      UPDATE thread SET state=CASE
        WHEN json_extract(metadata,'$.runnerReference') IS NOT NULL OR EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=thread.id AND e.ended_at IS NULL) THEN 'running'
        WHEN held=1 THEN 'idle'
        WHEN EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=thread.id AND w.status!='done') OR state IN ('starting','running','stopping') THEN 'running'
        ELSE 'idle' END WHERE state NOT IN ('idle','running');`);
  }

  private transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth++, savepoint = `thread_import_${depth}`;
    try {
      this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      try { const result = operation(); this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT"); return result; }
      catch (error) { this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK"); throw error; }
    } finally { this.transactionDepth--; }
  }
  private static readonly THREAD_COLUMNS = "t.*,(SELECT count(*) FROM thread_work w WHERE w.thread_id=t.id AND w.status!='done') pending_count";
  private row(id: string): Json | undefined { return this.sql(`SELECT ${ThreadService.THREAD_COLUMNS} FROM thread t WHERE id=?`).get(id) as Json | undefined; }
  private project(row: Json): Thread {
    const pending = row.pending_count ?? (this.sql("SELECT count(*) n FROM thread_work WHERE thread_id=? AND status!='done'").get(row.id) as { n: number }).n;
    return { id: row.id, parentId: row.parent_id, role: this.options.workersOnly || row.parent_id ? "worker" : "conversation", title: row.title, cwd: row.cwd, sessionFile: row.session_file,
      settings: JSON.parse(row.settings), admission: row.admission, state: row.state, held: !!row.held, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, pendingMessages: pending, metadata: JSON.parse(row.metadata) };
  }
  get(id: string): Thread | null { const row = this.row(id); return row ? this.project(row) : null; }
  /** Every thread, or with `archived: false` only the ones still in play; archived threads outnumber live ones many times over on a long-lived account. */
  snapshot(options: { archived?: boolean } = {}): Thread[] {
    const where = options.archived === false ? " WHERE json_extract(t.metadata,'$.archived') IS NOT 1" : "";
    return (this.sql(`SELECT ${ThreadService.THREAD_COLUMNS} FROM thread t${where} ORDER BY created_at,id`).all() as Json[]).map(row => this.project(row));
  }
  archivedCount(): number { return (this.sql("SELECT count(*) n FROM thread WHERE json_extract(metadata,'$.archived')=1").get() as { n: number }).n; }
  settlements(after = 0, limit = 100): Result<ThreadSettlements> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) return bad("invalid_request", "Invalid settlement cursor or limit");
    const rows = this.sql("SELECT * FROM thread_execution WHERE settlement_seq>? ORDER BY settlement_seq LIMIT ?").all(after, limit) as Json[];
    return good({ items: rows.map(row => ({ seq: row.settlement_seq, executionId: row.id, threadId: row.thread_id, workId: row.work_id, outcome: row.outcome, time: row.ended_at, finalMessage: JSON.parse(row.final_message ?? "null"), ...(row.error ? { error: row.error } : {}) })), cursor: rows.at(-1)?.settlement_seq ?? after });
  }
  async await(input: AwaitThreads, signal?: AbortSignal): Promise<Result<ThreadAwaitResult>> {
    const valid = validateThreadAwait(input); if (!valid.ok) return valid;
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (signal?.aborted) return bad("unavailable", "Thread await cancelled");
    const ids = new Set(input.threadIds);
    for (const id of ids) {
      const thread = this.get(id);
      if (!thread) return bad("not_found", `Thread ${id} was not found`);
      if (thread.parentId !== input.parentId) return bad("invalid_request", `Thread ${id} is not a direct child of ${input.parentId}`);
    }
    const cursors = Object.fromEntries(input.threadIds.map(id => [id, input.after && Object.hasOwn(input.after, id) ? input.after[id]! : 0]));
    const query = JSON.stringify(cursors);
    const response = (settlement: ThreadSettlement | null): Result<ThreadAwaitResult> => good({
      settlement,
      remainingThreadIds: input.threadIds.filter(id => id !== settlement?.threadId),
      after: { ...input.after, ...cursors, ...(settlement ? { [settlement.threadId]: settlement.seq } : {}) },
    });
    const completed = (): ThreadSettlement | null => {
      const row = this.sql(`SELECT e.* FROM json_each(?) target JOIN thread_execution e ON e.thread_id=target.key
        WHERE e.settlement_seq>target.value ORDER BY e.settlement_seq LIMIT 1`).get(query) as Json | undefined;
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
  live(id: string): Json | undefined { return this.projections.get(id)?.live; }
  latestSettlement(id: string): import("./contracts.js").ThreadSettlement | null {
    const row = this.sql("SELECT * FROM thread_execution WHERE thread_id=? AND ended_at IS NOT NULL ORDER BY ended_at DESC,id DESC LIMIT 1").get(id) as Json | undefined;
    return row ? { seq: row.settlement_seq ?? 0, executionId: row.id, threadId: row.thread_id, workId: row.work_id, outcome: row.outcome, time: row.ended_at, finalMessage: JSON.parse(row.final_message ?? "null"), ...(row.error ? { error: row.error } : {}) } : null;
  }
  async inspect(id: string): Promise<Result<ThreadInspection>> {
    const thread = this.get(id); if (!thread) return bad("not_found", "Thread not found");
    const projection = this.projections.get(id);
    try {
      const context = this.execution(id) && projection?.context ? projection.context : { source: "native-history", systemPrompt: "", tools: [], messages: readThreadHistory(thread.sessionFile).flatMap(entry => entry.type === "message" ? [entry.message] : entry.type === "custom_message" ? [{ role: "custom", content: entry.content, customType: entry.customType, details: entry.details }] : []) };
      return good({ thread, pending: this.pending(id), context, ...(projection ? { live: projection.live } : {}) });
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  private message(row: Json): ThreadMessage { return { id: row.id, threadId: row.thread_id, senderId: row.sender_id, text: row.text, images: JSON.parse(row.images), delivery: row.delivery, source: row.source, state: row.status, createdAt: row.created_at, insertedAt: row.inserted_at, landedAt: row.landed_at, ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.reply_to ? { replyTo: row.reply_to } : {}) }; }
  pending(id: string): PendingMessage[] {
    return this.sql("SELECT * FROM thread_work WHERE thread_id=? AND status!='done' ORDER BY front DESC,ordinal").all(id).map(row => this.message(row as Json) as PendingMessage);
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
    this.sql("UPDATE thread SET revision=revision+1,updated_at=? WHERE id=?").run(Date.now(), id);
    const thread = this.get(id); if (thread) this.options.onChange?.(thread);
    for (const listener of this.listeners) listener({ threadId: id, type: "changed" });
  }
  private state(id: string, state: Thread["state"]): void {
    if (this.suspended || this.closed) return;
    const changed = this.sql("UPDATE thread SET state=?,metadata=CASE WHEN ?='running' THEN json_remove(metadata,'$.executionError') ELSE metadata END WHERE id=? AND (state!=? OR (?='running' AND json_extract(metadata,'$.executionError') IS NOT NULL))").run(state, state, id, state, state).changes;
    if (changed) this.changed(id);
  }
  /** Record why a queued thread could not be admitted. Reconcile retries it, so this is a wait, not a settlement. */
  private admissionWait(id: string, error: ThreadError): void {
    if (this.suspended || this.closed) return;
    const existing = this.get(id)?.metadata?.admissionWait as Json | undefined;
    const wait = { code: error.code, message: error.message, since: existing?.message === error.message ? existing.since : Date.now(), observedAt: Date.now() };
    this.sql("UPDATE thread SET metadata=json_set(metadata,'$.admissionWait',json(?)) WHERE id=?").run(JSON.stringify(wait), id);
    if (existing?.message !== error.message) this.changed(id);
  }
  private clearAdmissionWait(id: string): void {
    if (this.suspended || this.closed) return;
    const cleared = this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.admissionWait') WHERE id=? AND json_extract(metadata,'$.admissionWait') IS NOT NULL").run(id).changes;
    if (cleared) this.changed(id);
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
        const work = this.execution(id)?.work_id ?? this.pending(id)[0]?.id;
        if (!work) throw error;
        const prior = this.get(id)?.metadata?.startupFailure as Json | undefined;
        const attempts = prior && prior.workId === work ? Number(prior.attempts) + 1 : 1;
        const permanent = isModelConfigurationError(message) || /Pi cwd admission rejected|Invalid recorded (?:runner|isolated)|Compiled thread runner is missing/.test(message);
        const failure = { workId: work, attempts, error: message, retryAt: Date.now() + Math.min(attempts * 5_000, 30_000) };
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.startupFailure',json(?),'$.executionError',?) WHERE id=?").run(JSON.stringify(failure), message, id);
        this.changed(id);
        if (permanent || attempts >= 3) await this.rejectStartup(id, message);
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
      this.reconcile();
    }
    return good(undefined);
  }
  reconcile(): void {
    if (!this.started || this.closed || this.suspended) return;
    void this.routeNotifications();
    const rows = this.sql("SELECT id,held FROM thread WHERE state='running' OR EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=thread.id AND e.ended_at IS NULL) OR (held=0 AND EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=thread.id AND w.status!='done'))").all() as { id: string; held: number }[];
    for (const row of rows) {
      if (row.held) void this.halt(row.id);
      else if (!this.operations.has(row.id) && !this.halts.has(row.id)) this.wake(row.id);
    }
    for (const [id, runtime] of this.runtimes) if (!runtime.busy && !runtime.executionId && !this.operations.has(id) && !this.halts.has(id) && !this.opening.has(id)) void this.serial(id, () => this.retire(id, runtime)).catch(error => {
      if (!this.suspended && !this.closed) { this.sql("UPDATE thread SET metadata=json_set(metadata,'$.cleanupError',?) WHERE id=?").run(errorText(error), id); this.changed(id); }
    });
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
  private insertMessage(id: string, input: SendThread, settings: ThreadSettings, front = false): ThreadMessage {
    this.sql("INSERT INTO thread_work(id,thread_id,sender_id,text,images,delivery,source,reply_to,front,settings,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.threadId, input.senderId ?? null, input.text, JSON.stringify(input.images ?? []), resolveDelivery(input), input.source ?? "explicit", input.replyTo ?? null, front ? Date.now() : 0, JSON.stringify(settings), Date.now());
    return this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(id) as Json);
  }
  async spawn(input: SpawnThread): Promise<Result<Thread>> {
    try {
      const prior = this.request(input.requestId, input, "spawn"); if (!prior.ok) return prior;
      if (prior.value) return good(this.get(prior.value)!);
      if (!input.cwd || typeof input.cwd !== "string" || input.message !== undefined && (typeof input.message !== "string" || !input.message.trim())) return bad("invalid_request", "cwd and a nonempty assignment when supplied are required");
      let parent = input.parentId ? this.get(input.parentId) : null;
      if (input.parentId && !parent && this.directory) {
        const found = await this.directory.list({ id: input.parentId, limit: 1 });
        if (!found.ok) return found;
        parent = found.value.threads[0] ?? null;
        const accepted = this.request(input.requestId, input, "spawn"); if (!accepted.ok) return accepted;
        if (accepted.value) return good(this.get(accepted.value)!);
      }
      if (input.parentId && !parent) return bad("not_found", "Parent thread is not accessible to this service");
      if (input.ephemeral !== undefined && typeof input.ephemeral !== "boolean") return bad("invalid_request", "ephemeral must be a boolean");
      if (input.ephemeral && !parent) return bad("invalid_request", "Only subagents can be ephemeral");
      if (input.ephemeral && !input.message) return bad("invalid_request", "Ephemeral subagents need an initial assignment");
      if (input.metadata && "ephemeral" in input.metadata) return bad("invalid_request", "Set ephemeral on the spawn request, not in metadata");
      if (parent && (parent.parentId || parent.role === "worker")) return bad("invalid_request", "Orchestrator workers cannot spawn subagents. Report the remaining work to the parent conversation.");
      if (parent?.metadata?.archived) return bad("unavailable", "Restore the parent before creating children");
      if (parent?.held) return bad("unavailable", "Resume the parent conversation before creating workers");
      const settings = resolveSpawnSettings(input.settings, parent); if (!settings.ok) return settings;
      if (["direct", "lane"].includes(String(input.metadata?.source)) && !settings.value.model.startsWith("openai-codex/")) return bad("invalid_request", "Orchestrator-scheduled work requires an OpenAI Codex model");
      // Check local receipts first so retries of previously accepted children retain their identity.
      const workerOwner = parent && this.workerOwner?.(parent, input);
      if (workerOwner) return workerOwner.spawn(input);
      const metadata: Record<string, unknown> = { ...Object.fromEntries(["profileId", "meetingId", "bashTimeoutSeconds", "context", "execution", "source", "raw"].filter(key => parent?.metadata?.[key] !== undefined).map(key => [key, parent!.metadata![key]])), ...input.metadata, ...(input.ephemeral ? { ephemeral: true } : {}) };
      for (const key of ["context", "execution", "raw"] as const) if (parent && input.metadata && key in input.metadata && digest(input.metadata[key] ?? null) !== digest(parent.metadata?.[key] ?? null)) return bad("conflict", "A child must remain in its parent's execution boundary");
      if (metadata.context !== undefined && !isRunContext(metadata.context)) return bad("invalid_request", "Invalid isolated context contract");
      if (metadata.execution === "root-repair" && metadata.context) return bad("invalid_request", "Root repair requires full normal Pi context");
      if (metadata.raw !== undefined && metadata.raw !== true) return bad("invalid_request", "Thread metadata raw must be true when present");
      if (metadata.raw === true && (metadata.context !== undefined || metadata.execution === "root-repair")) return bad("invalid_request", "Raw threads carry no isolated context and cannot perform root repair");
      if (input.admission !== undefined && !["force", "background"].includes(input.admission)) return bad("invalid_request", "Invalid admission policy");
      const id = input.id ?? randomUUID();
      if (input.parentId === id) return bad("invalid_request", "A thread cannot be its own parent");
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return bad("invalid_request", "Thread ID must be a nonempty filename-safe identifier");
      if (this.get(id)) return bad("conflict", "Thread ID already exists");
      this.transaction(() => {
        const now = Date.now();
        this.sql("INSERT INTO thread(id,parent_id,title,cwd,session_file,settings,admission,state,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, input.parentId ?? null, input.title ?? `Thread ${id.slice(0, 8)}`, input.cwd, join(this.options.sessionsDir, `${id}.jsonl`), JSON.stringify(settings.value), input.parentId ? "force" : input.admission ?? "force", input.message ? "running" : "idle", now, now, JSON.stringify(metadata));
        if (input.message) this.insertMessage(input.requestId, { requestId: input.requestId, threadId: id, senderId: input.parentId, text: input.message, images: input.images, delivery: resolveDelivery({ senderId: input.parentId }) }, settings.value);
        this.recordRequest(input.requestId, input, "spawn", id);
      });
      this.changed(id); this.wake(id); return good(this.get(id)!);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  async send(request: SendThread): Promise<Result<ThreadMessage>> {
    if (request.senderId && request.delivery === "queue") return bad("invalid_request", "Agents must use steer or hard steer; they cannot queue messages");
    const input = { ...request, delivery: resolveDelivery(request) };
    try {
      const prior = this.request(input.requestId, input, "send"); if (!prior.ok) return prior;
      if (prior.value) return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(prior.value) as Json));
      const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Recipient not found in this environment");
      if (thread.metadata?.archived) return bad("unavailable", "Restore this archived thread before sending messages");
      if (this.halts.has(thread.id)) return bad("conflict", "Wait for cancellation confirmation before resuming this thread");
      if (typeof input.text !== "string" || !input.text.trim() || !["queue", "steer", "hardSteer"].includes(input.delivery) || input.source !== undefined && !["explicit", "notification"].includes(input.source)) return bad("invalid_request", "Nonempty text and a valid delivery mode and source are required");
      if (input.source !== "notification" && this.row(thread.id)?.held && thread.state === "running") {
        const halted = await this.halt(thread.id); if (!halted.ok) return halted;
        const accepted = this.request(input.requestId, input, "send"); if (!accepted.ok) return accepted;
        if (accepted.value) return good(this.message(this.sql("SELECT * FROM thread_work WHERE id=?").get(accepted.value) as Json));
      }
      const message = this.transaction(() => {
        const held = !!this.row(thread.id)?.held, explicit = input.source !== "notification";
        const result = this.insertMessage(input.requestId, input, thread.settings, explicit && held || input.delivery === "hardSteer");
        if (explicit && held) this.sql("UPDATE thread SET held=0,state='running' WHERE id=?").run(thread.id);
        else if (!held && thread.state === "idle") this.sql("UPDATE thread SET state='running' WHERE id=?").run(thread.id);
        this.recordRequest(input.requestId, input, "send", result.id); return result;
      });
      this.changed(thread.id);
      const runtime = this.runtimes.get(thread.id);
      if (input.delivery === "hardSteer" && runtime?.commandRunning) void this.halt(thread.id).then(() => this.wake(thread.id));
      this.wake(thread.id); return good(message);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  async list(input: ThreadList = {}): Promise<Result<ThreadPage>> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return bad("invalid_request", "limit must be between 1 and 1000");
    if (input.state !== undefined && !isThreadState(input.state)) return bad("invalid_request", "Invalid thread state");
    const clauses: string[] = [], values: (string | null | number)[] = [];
    if (input.id !== undefined) { clauses.push("t.id=?"); values.push(input.id); }
    if (input.parentId !== undefined) { clauses.push("t.parent_id IS ?"); values.push(input.parentId); }
    if (input.state !== undefined) { clauses.push("t.state=?"); values.push(input.state); }
    if (input.cursor !== undefined) { clauses.push("t.id>?"); values.push(input.cursor); }
    const rows = this.sql(`SELECT t.*,(SELECT count(*) FROM thread_work w WHERE w.thread_id=t.id AND w.status!='done') pending_count FROM thread t ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY t.id LIMIT ?`).all(...values, limit + 1) as Json[];
    const page = rows.map(row => this.project(row));
    return good({ threads: page.slice(0, limit), ...(page.length > limit ? { nextCursor: page[limit - 1]!.id } : {}) });
  }
  async read(input: ThreadRead): Promise<Result<ThreadHistory>> {
    const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Thread not found");
    try {
      const limit = input.limit ?? 20, offset = input.offset ?? Number(input.cursor ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return bad("invalid_request", "Invalid history page");
      const entries = visibleThreadHistory(thread.sessionFile) as Json[];
      if (input.entryId) { const entry = entries.find(entry => entry.id === input.entryId); return entry ? good({ entries: [entry] }) : bad("not_found", "Transcript entry not found"); }
      const selected = entries.slice(offset, offset + limit);
      return good({ entries: selected, ...(offset + selected.length < entries.length ? { nextCursor: String(offset + selected.length) } : {}) });
    } catch (error) { return bad("unavailable", errorText(error)); }
  }

  update(id: string, patch: { title?: string; metadata?: Record<string, unknown>; archived?: boolean }): Result<Thread> {
    if (this.suspended || this.closed) return bad("unavailable", "Thread controller is suspended");
    const thread = this.get(id); if (!thread) return bad("not_found", "Thread not found");
    if (patch.title !== undefined && !patch.title.trim()) return bad("invalid_request", "Thread title cannot be empty");
    if (patch.metadata && "archived" in patch.metadata && patch.archived === undefined) return bad("invalid_request", "Use the explicit archived control instead of changing metadata.archived");
    for (const key of ["context", "execution", "nativeHistoryRequired", "runnerReference", "ephemeral"] as const) if (patch.metadata && key in patch.metadata && digest(patch.metadata[key] ?? null) !== digest(thread.metadata?.[key] ?? null)) return bad("conflict", `Thread ${key} is immutable`);
    if (patch.archived && (this.execution(id) || this.runtimes.get(id)?.busy || thread.state === "running")) return bad("conflict", "Stop this thread before archiving it, or use control(update)");
    // Archiving an archived thread is a no-op rather than a fresh archivedAt: a
    // subtree cascade reaches the same thread from more than one owner.
    if (patch.archived && thread.metadata?.archived && patch.title === undefined && !patch.metadata) return good(thread);
    const metadata = { ...thread.metadata, ...patch.metadata, ...(patch.archived === undefined ? {} : { archived: patch.archived, archivedAt: patch.archived ? new Date().toISOString() : null }) };
    this.sql("UPDATE thread SET title=?,metadata=?,held=CASE WHEN ? THEN 1 ELSE held END,state=CASE WHEN ? THEN 'idle' ELSE state END WHERE id=?").run(patch.title ?? thread.title, JSON.stringify(metadata), patch.archived ? 1 : 0, patch.archived ? 1 : 0, id);
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
      this.sql("UPDATE thread SET held=0,state='running' WHERE id=?").run(threadId);
      if (this.runtimes.get(threadId)?.commandRunning) void this.halt(threadId).then(() => this.wake(threadId));
    }
    this.changed(threadId); this.wake(threadId); return good({ ...this.message(work), delivery });
  }
  async control(input: ThreadControl): Promise<Result<Thread>> {
    if (this.closed || this.suspended) return bad("unavailable", "Thread controller is suspended");
    if (!this.get(input.threadId)) return bad("not_found", "Thread not found");
    if (input.action === "archiveInactive") {
      if (!Number.isSafeInteger(input.inactiveBefore) || input.inactiveBefore <= 0 || input.inactiveBefore > Date.now()) return bad("invalid_request", "Invalid inactivity cutoff");
      const current = this.get(input.threadId)!;
      if (current.metadata?.archived) return good(current);
      const descendants = this.sql("WITH RECURSIVE descendants(id) AS (SELECT ? UNION SELECT t.id FROM thread t JOIN descendants d ON t.parent_id=d.id) SELECT thread.* FROM thread JOIN descendants USING(id)").all(input.threadId) as Json[];
      for (const row of descendants) {
        const thread = this.project(row);
        if (thread.metadata?.archived) continue;
        const runtime = this.runtimes.get(thread.id);
        if (thread.updatedAt >= input.inactiveBefore || thread.state !== "idle" || thread.pendingMessages > 0 || this.execution(thread.id) || runtime?.busy || runtime?.commandRunning || this.operations.has(thread.id) || this.halts.has(thread.id)) return good(current);
      }
      // No await/stop between the authoritative check and mutation: new work cannot race it.
      // The whole subtree goes together; a finished worker without its conversation is noise in every list.
      const archived = this.update(input.threadId, { archived: true });
      if (archived.ok) for (const row of descendants) if (row.id !== input.threadId) this.update(row.id, { archived: true });
      return archived;
    }
    if (input.action === "update") {
      if (input.archived) { const stopped = await this.control({ threadId: input.threadId, action: "stop", descendants: true }); if (!stopped.ok) return stopped; }
      const updated = this.update(input.threadId, input);
      if (updated.ok && input.archived) for (const id of this.descendantIds(input.threadId)) this.update(id, { archived: true });
      return updated;
    }
    if (input.action === "cancelMessage" || input.action === "promoteMessage") {
      const result = input.action === "cancelMessage" ? await this.cancelMessage(input.threadId, input.messageId) : await this.promoteMessage(input.threadId, input.messageId, input.delivery);
      return result.ok ? good(this.get(input.threadId)!) : result;
    }
    if (input.action === "settings") {
      const current = this.get(input.threadId)!, settings = resolveThreadSettings(input.settings, current.settings); if (!settings.ok) return settings;
      if ((current.parentId || ["direct", "lane"].includes(String(current.metadata?.source))) && !settings.value.model.startsWith("openai-codex/")) return bad("invalid_request", "Orchestrator-scheduled work requires an OpenAI Codex model");
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
      const runtime = this.runtimes.get(input.threadId), execution = this.execution(input.threadId);
      const activeSettings: ThreadSettings | undefined = execution ? JSON.parse(execution.settings) : runtime?.settings;
      const activeSelection = activeSettings && resolveThreadSettings({}, activeSettings);
      if (runtime && activeSettings && activeSelection?.ok && activeSelection.value.model === settings.value.model) {
        const applied = { ...activeSettings };
        const remember = () => {
          runtime.settings = { ...applied };
          if (execution) this.sql("UPDATE thread_execution SET settings=? WHERE id=?").run(JSON.stringify(applied), execution.id);
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
    if (input.action === "resume") {
      if (this.get(input.threadId)?.metadata?.archived) return bad("unavailable", "Restore this archived thread before resuming it");
      if (!this.pending(input.threadId).some(work => work.state === "queued")) return bad("no_pending_messages", "This thread has no pending messages");
      if (this.row(input.threadId)?.held && (this.execution(input.threadId) || this.runtimes.has(input.threadId) || this.halts.has(input.threadId))) {
        const halted = await this.halt(input.threadId); if (!halted.ok) return halted;
      }
      this.sql("UPDATE thread SET held=0,state='running' WHERE id=?").run(input.threadId);
      this.changed(input.threadId); this.wake(input.threadId); return good(this.get(input.threadId)!);
    }
    if (input.action !== "stop" || typeof input.descendants !== "boolean") return bad("invalid_request", "Stop must explicitly select whether descendants stop too");
    const ids = new Set([input.threadId, ...(input.descendants ? this.descendantIds(input.threadId) : [])]);
    for (const id of ids) { this.sql("UPDATE thread SET held=1 WHERE id=?").run(id); this.changed(id); }
    const results = await Promise.all([...ids].map(id => this.halt(id)));
    const failure = results.find(result => !result.ok); if (failure && !failure.ok) return failure;
    return good(this.get(input.threadId)!);
  }
  /** Every thread below `id` in this owner, nearest first; children owned elsewhere are the directory's to find. */
  private descendantIds(id: string): string[] {
    return (this.sql("WITH RECURSIVE descendants(id,depth) AS (SELECT ?,0 UNION ALL SELECT t.id,d.depth+1 FROM thread t JOIN descendants d ON t.parent_id=d.id) SELECT id FROM descendants WHERE depth>0 ORDER BY depth,id").all(id) as { id: string }[]).map(row => row.id);
  }
  private halt(id: string): Promise<Result<Thread>> {
    const current = this.halts.get(id); if (current) return current;
    const operation = Promise.resolve().then(async (): Promise<Result<Thread>> => {
      try {
        // A rejected startup is not a failed cancellation: inspect the retained runner directly.
        await this.opening.get(id)?.catch(() => undefined);
        const runtime = this.runtimes.get(id) ?? await this.attach(id);
        if (runtime) await this.rpc(runtime, { type: "abort" });
        await this.finish(id, runtime, runtime?.outcome ?? "cancelled", runtime?.finalMessage ?? null);
        if (runtime) await this.retire(id, runtime);
        if (this.suspended || this.closed) return bad("unavailable", "Halt remains with the thread owner during handoff");
        this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.executionError','$.admissionWait') WHERE id=?").run(id);
        this.state(id, this.row(id)?.held ? "idle" : this.pending(id).length ? "running" : "idle");
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
    const durable = ["fork", "clone", "compact", "new_session", "switch_session", "navigate_tree", "bash", "cycle_model", "cycle_thinking_level", "export_html"].includes(command.type);
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
        const execution = this.execution(id), settings = execution ? JSON.parse(execution.settings) : this.get(id)!.settings;
        let runtime = await this.open(id, settings, !!execution);
        if (this.runtimes.get(id) !== runtime) runtime = await this.open(id, this.get(id)!.settings, false);
        const observing = ["get_state", "get_context", "get_messages", "get_session_stats", "get_available_models", "get_available_thinking_levels", "get_commands", "get_fork_messages", "set_session_name", "extension_ui_response"].includes(command.type);
        if (!observing && (runtime.busy || execution)) return bad("conflict", "Wait for this thread's current execution to settle");
        if (durable && !receipt) { this.recordRequest(command.id!, { threadId: id, command }, "command", id); receipt = true; }
        runtime.commandRunning = command.type;
        if (durable) this.state(id, "running");
        let result: any;
        try { result = await this.rpc(runtime, command); } finally { runtime.commandRunning = undefined; }
        if (this.suspended) return bad("unavailable", "Command remains with the native owner during handoff");
        const response = good(result);
        if (receipt) this.sql("UPDATE thread_request SET response=? WHERE id=? AND response IS NULL").run(JSON.stringify(response), command.id!);
        if (this.halts.has(id) || this.runtimes.get(id) !== runtime) return response;
        const state = await this.rpc(runtime, { type: "get_state" });
        this.adoptReference(id, state);
        runtime.busy = this.busy(state);
        if (runtime.busy) this.state(id, "running");
        else if (!this.execution(id)) {
          this.state(id, this.row(id)?.held ? "idle" : this.pending(id).length ? "running" : "idle");
          await this.retire(id, runtime);
        }
        return response;
      } catch (error) {
        const uncertain = /uncertain|indeterminate|unconfirmed.outcome/i.test(errorText(error));
        const failure = bad(uncertain ? "conflict" : "unavailable", `${command.id ?? command.type}: ${errorText(error)}`);
        if (!this.suspended && !this.closed) {
          if (receipt && error instanceof NativeRejection) this.sql("UPDATE thread_request SET response=? WHERE id=?").run(JSON.stringify(failure), command.id!);
          this.sql("UPDATE thread SET metadata=json_set(metadata,'$.commandError',?) WHERE id=?").run(failure.ok ? "" : failure.error.message, id); this.changed(id);
        }
        return failure;
      }
    });
  }
  private execution(id: string): Json | undefined { return this.sql("SELECT * FROM thread_execution WHERE thread_id=? AND ended_at IS NULL").get(id) as Json | undefined; }
  private busy(state: Json): boolean { return !!(state.isStreaming || state.isCompacting || state.isBashRunning || state.localTools > 0 || state.cancellationFailed || state.pendingCommandCount > 0 || state.pendingMessageCount > 0); }
  private adoptReference(id: string, state: Json): void {
    if (this.suspended || this.closed || typeof state.sessionFile !== "string" || !state.sessionFile) return;
    const changed = this.sql("UPDATE thread SET session_file=?,metadata=json_set(metadata,'$.nativeHistoryRequired',json('true')) WHERE id=? AND (session_file!=? OR json_extract(metadata,'$.nativeHistoryRequired') IS NOT 1)").run(state.sessionFile, id, state.sessionFile).changes;
    if (changed) this.changed(id);
  }
  private rpc(runtime: Runtime, command: PiCommand): Promise<any> {
    if (this.suspended || this.closed) return Promise.reject(new Error("Thread controller is suspended"));
    const id = command.id ?? `${runtime.epoch}:${++runtime.commandNumber}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { runtime.waiters.delete(id); reject(new Error(`Pi ${command.type} acknowledgement timed out; accepted work remains in custody`)); }, command.type === "compact" ? 240_000 : 30_000);
      runtime.waiters.set(id, { resolve, reject, timer });
      void runtime.session.command({ ...command, id }).catch(error => { const waiter = runtime.waiters.get(id); if (waiter) { clearTimeout(waiter.timer); runtime.waiters.delete(id); reject(error); } });
    });
  }
  private exited(id: string, runtime: Runtime, code: number | null | undefined): void {
    if (this.suspended || this.closed || this.runtimes.get(id) !== runtime) return;
    for (const waiter of runtime.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Pi session exited (${code ?? "unknown"})`)); }
    runtime.waiters.clear(); this.runtimes.delete(id);
    if (runtime.executionId) this.wake(id);
  }
  private async attach(id: string): Promise<Runtime | undefined> {
    const thread = this.get(id)!;
    if (thread.metadata?.runnerReference && !this.options.attachSession) throw new Error("Native runner attachment is not configured");
    const runtime: Runtime = { session: undefined as unknown as PiSession, epoch: randomUUID(), executionId: this.execution(id)?.id, busy: true, commandNumber: 0, waiters: new Map() };
    this.runtimes.set(id, runtime);
    try {
      const session = await this.options.attachSession?.(thread.metadata?.runnerReference as Parameters<AttachPiSession>[0], event => this.output(id, runtime, event), code => this.exited(id, runtime, code));
      if (session) { runtime.session = session; return runtime; }
      if (!this.closed && !this.suspended) this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.runnerReference') WHERE id=?").run(id);
      this.runtimes.delete(id); return undefined;
    } catch (error) { this.runtimes.delete(id); throw error; }
  }
  private open(id: string, settings: ThreadSettings, recovering: boolean, extraEnv: Record<string, string | undefined> = {}): Promise<Runtime> {
    const opening = this.opening.get(id); if (opening) return opening;
    const existing = this.runtimes.get(id); if (existing) return Promise.resolve(existing);
    const operation = this.openOwned(id, settings, recovering, extraEnv).finally(() => this.opening.delete(id));
    this.opening.set(id, operation); return operation;
  }
  private async openOwned(id: string, settings: ThreadSettings, recovering: boolean, extraEnv: Record<string, string | undefined>): Promise<Runtime> {
    const thread = this.get(id)!;
    const recoveredExecution = recovering ? this.execution(id) : undefined;
    let recoveredAdmission: ThreadAdmission | undefined;
    if (recoveredExecution && this.options.admit) {
      const admitted = await this.options.admit(thread, settings, true, recoveredExecution.id);
      if (!admitted.ok) {
        if (admitted.error.code === "unavailable") {
          this.admissionWait(id, admitted.error);
          throw new AdmissionWait(admitted.error.message);
        }
        throw new Error(admitted.error.message);
      }
      this.clearAdmissionWait(id);
      recoveredAdmission = admitted.value; extraEnv = { ...extraEnv, ...admitted.value.env }; settings = admitted.value.settings ?? settings;
    }
    const runtime: Runtime = { session: undefined as unknown as PiSession, epoch: randomUUID(), busy: false, commandNumber: 0, waiters: new Map(), lease: recoveredAdmission, settings };
    const [provider, ...model] = settings.model.split("/");
    const context = thread.metadata?.context;
    if (context !== undefined && (!isRunContext(context) || thread.metadata?.execution === "root-repair")) throw new Error("Invalid recorded isolated execution boundary");
    const raw = thread.metadata?.raw === true;
    if (raw && (context !== undefined || thread.metadata?.execution === "root-repair")) throw new Error("Invalid recorded raw execution boundary");
    const env = { ...this.options.environment?.(thread), ...extraEnv, ...(context ? { HOME: join(thread.cwd, ".home") } : {}), PI_THREAD_ID: id, PI_THREAD_SPEED: settings.speed,
      PI_THREAD_DATABASE: this.options.databasePath,
      // Explicit false survives JSON transport and overrides older runners' launch environment.
      PI_THREAD_REQUIRE_SESSION: thread.metadata?.nativeHistoryRequired || recovering ? "1" : "0",
      PI_THREAD_CAN_SPAWN: thread.role === "worker" ? "0" : "1",
      PI_THREAD_RUNNER_REFERENCE: thread.metadata?.runnerReference ? JSON.stringify(thread.metadata.runnerReference) : undefined };
    this.runtimes.set(id, runtime);
    try {
      runtime.session = await this.options.openSession({ threadId: id, cwd: thread.cwd, sessionFile: thread.sessionFile,
        args: ["--provider", provider!, "--model", model.join("/"), "--thinking", settings.thinkingLevel, "--name", thread.title, ...(raw ? [RAW_ARGUMENT] : []), ...(context ? ["--orchestrator-context", JSON.stringify(context)] : [])], env, threads: this.directory ?? this },
        event => this.output(id, runtime, event), code => this.exited(id, runtime, code));
      const state = await this.rpc(runtime, { type: "get_state" }); this.adoptReference(id, state);
      await this.rpc(runtime, { type: "set_session_name", name: thread.title });
      runtime.busy = this.busy(state); runtime.finalMessage = state.lastAssistantMessage;
      const execution = this.execution(id);
      if (recovering && execution) {
        runtime.executionId = execution.id;
        const accepted = new Set<string>(state.acceptedWorkIds ?? []), completed = new Set<string>(state.completedWorkIds ?? []);
        const works = this.sql("SELECT * FROM thread_work WHERE execution_id=? AND status!='done' ORDER BY ordinal").all(execution.id) as Json[];
        if (!runtime.busy && completed.has(execution.work_id)) {
          const last = state.lastAssistantMessage;
          await this.finish(id, runtime, last?.stopReason === "error" ? "failed" : last?.stopReason === "aborted" ? "cancelled" : "complete", last ?? null);
        } else if (!runtime.busy && works.length && !this.row(id)?.held && !this.halts.has(id)) {
          const work = works[0]!, prepared = work.prepared ? JSON.parse(work.prepared) : { text: work.text, images: JSON.parse(work.images) };
          await this.rpc(runtime, { type: "prompt", workId: work.id, message: formatThreadMessage(this.message(work), prepared.text), images: prepared.images, resume: accepted.has(work.id) || work.inserted_at !== null });
          this.sql("UPDATE thread_work SET landed_at=COALESCE(landed_at,?) WHERE id=?").run(Date.now(), work.id);
          runtime.busy = true;
        }
      }
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
    const projection = this.projections.get(id) ?? { live: { text: "", thinking: "", isThinking: false, tools: [] } };
    this.projections.set(id, projection);
    if (event.type === "context_update" && event.context) {
      projection.context = event.context as Json;
      const text = (message: Json) => (message.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("");
      const final = runtime.finalMessage, finalText = final && text(final);
      if (finalText && projection.context.messages?.some((message: Json) => message.role === "assistant" && text(message) === finalText)) { projection.live.text = ""; projection.live.thinking = ""; }
    }
    if (event.type === "message_start" && (event.message as Json)?.role === "assistant") { projection.live.text = ""; projection.live.thinking = ""; }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as Json;
      if (update?.type === "text_delta") projection.live.text += String(update.delta ?? "");
      if (update?.type === "thinking_start" || update?.type === "thinking_delta") projection.live.isThinking = true;
      if (update?.type === "thinking_delta") projection.live.thinking += String(update.delta ?? "");
      if (update?.type === "thinking_end") projection.live.isThinking = false;
    }
    if (event.type === "message_end") projection.live.isThinking = false;
    if (event.type === "tool_execution_start") projection.live.tools.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    if (event.type === "tool_execution_update") { const tool = projection.live.tools.find((tool: Json) => tool.toolCallId === event.toolCallId); if (tool) tool.output = event.partialResult; }
    if (event.type === "tool_execution_end") projection.live.tools = projection.live.tools.filter((tool: Json) => tool.toolCallId !== event.toolCallId);
    if (event.type === "response" && event.command === "get_state" && event.success && (event.data as Json)?.live) {
      const live = (event.data as Json).live;
      if (live.text || !projection.live.text) projection.live.text = live.text ?? "";
      if (live.thinking || !projection.live.thinking) projection.live.thinking = live.thinking ?? "";
      projection.live.isThinking = !!live.isThinking;
      if (Array.isArray(live.tools)) projection.live.tools = live.tools;
    }
    if (event.type === "message_start" && (event.message as Json)?.role === "user") this.land(id, contentText((event.message as Json).content, ""));
    if (event.type === "response") {
      const waiter = runtime.waiters.get(String(event.id));
      if (waiter) { clearTimeout(waiter.timer); runtime.waiters.delete(String(event.id)); event.success === false ? waiter.reject(new NativeRejection(String(event.error ?? "Pi command rejected"))) : waiter.resolve(event.data ?? {}); }
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
      void this.serial(id, async () => {
        if (this.runtimes.get(id) !== runtime || event.type !== "agent_settled" && runtime.executionId) return;
        const state = await this.rpc(runtime, { type: "get_state" }); this.adoptReference(id, state);
        if (this.busy(state)) return;
        if (!runtime.executionId) { runtime.busy = false; this.state(id, this.row(id)?.held ? "idle" : this.pending(id).length ? "running" : "idle"); await this.retire(id, runtime); return; }
        const last = "lastAssistantMessage" in event ? event.lastAssistantMessage as Json | null : state.lastAssistantMessage ?? runtime.finalMessage;
        const outcome = ["complete", "failed", "cancelled"].includes(String(event.outcome)) ? event.outcome as WorkOutcome : last?.stopReason === "error" ? "failed" : last?.stopReason === "aborted" ? "cancelled" : "complete";
        const settledOutcome = this.row(id)?.held ? "cancelled" : outcome;
        await this.finish(id, runtime, settledOutcome, last ?? null, settledOutcome === "failed" ? last?.errorMessage : undefined);
      }).then(() => this.wake(id)).catch(error => {
        if (this.closed || this.suspended) return;
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(errorText(error), id); this.changed(id);
        for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_error", error: errorText(error) } });
      });
    }
  }
  private async drain(id: string): Promise<void> {
    if (this.suspended || this.closed) return;
    const thread = this.get(id); if (!thread || this.row(id)?.held || this.halts.has(id) || this.closed) return;
    const startup = thread.metadata?.startupFailure as Json | undefined;
    const nextWork = this.execution(id)?.work_id ?? this.pending(id)[0]?.id;
    if (startup && startup.workId === nextWork && Number(startup.retryAt) > Date.now()) return;
    let execution = this.execution(id), runtime = this.runtimes.get(id);
    if ((execution || runtime || thread.metadata?.runnerReference) && this.pending(id).some(work => work.delivery === "hardSteer" && work.state === "queued")) {
      const halted = await this.halt(id); if (!halted.ok) return;
      execution = undefined; runtime = undefined;
    } else if (!execution && !runtime && thread.metadata?.runnerReference) runtime = await this.open(id, thread.settings, false);
    if (execution && !runtime) runtime = await this.open(id, JSON.parse(execution.settings), true);
    execution = this.execution(id);
    const work = this.sql(`SELECT * FROM thread_work WHERE thread_id=? AND status='queued' ${execution ? "AND delivery IN ('steer','hardSteer')" : ""} ORDER BY front DESC,ordinal LIMIT 1`).get(id) as Json | undefined;
    if (!work) { if (!execution && !runtime?.busy) { this.state(id, "idle"); if (runtime) await this.retire(id, runtime); } return; }
    if (!execution && runtime?.busy) return;
    if (work.prepared === null) {
      const prepared = this.options.prepareMessage ? await this.options.prepareMessage(thread, this.message(work)) : good({ text: work.text as string, images: JSON.parse(work.images) as unknown[] });
      if (!prepared.ok) throw new Error(prepared.error.message);
      if (this.suspended || this.row(id)?.held || this.halts.has(id)) return;
      work.prepared = JSON.stringify(prepared.value);
      this.sql("UPDATE thread_work SET prepared=? WHERE id=? AND prepared IS NULL").run(work.prepared, work.id);
    }
    if (!execution) {
      const settings = JSON.parse(work.settings) as ThreadSettings, executionId = randomUUID();
      const admission = this.options.admit ? await this.options.admit(thread, settings, false, executionId) : good<ThreadAdmission>({ release() {} });
      if (!admission.ok) {
        // Capacity refusals are retried by reconcile; anything else will refuse identically forever.
        if (admission.error.code !== "unavailable") { await this.rejectStartup(id, admission.error.message); return; }
        this.admissionWait(id, admission.error); return;
      }
      this.clearAdmissionWait(id);
      if (this.suspended || this.row(id)?.held || this.halts.has(id)) { await admission.value.release(); return; }
      if (runtime) { await this.retire(id, runtime); runtime = undefined; }
      this.state(id, "running");
      try { runtime = await this.open(id, admission.value.settings ?? settings, false, admission.value.env); }
      catch (error) { await admission.value.release(); throw error; }
      this.sql("UPDATE thread SET metadata=json_remove(metadata,'$.startupFailure') WHERE id=?").run(id);
      runtime.lease = admission.value;
      if (this.suspended || this.row(id)?.held || this.halts.has(id)) { await admission.value.release(); runtime.lease = undefined; await this.retire(id, runtime); return; }
      this.transaction(() => {
        this.sql("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES(?,?,?,?,?)").run(executionId, id, work.id, JSON.stringify(admission.value.settings ?? settings), Date.now());
        this.sql("UPDATE thread_work SET status='dispatched',execution_id=? WHERE id=?").run(executionId, work.id);
      });
      runtime.executionId = executionId; runtime.finalMessage = undefined; runtime.outcome = undefined; execution = this.execution(id)!;
    } else this.sql("UPDATE thread_work SET status='dispatched',execution_id=? WHERE id=?").run(execution.id, work.id);
    try {
      const prepared = JSON.parse(work.prepared);
      const prompt = !runtime!.busy;
      await this.rpc(runtime!, { type: prompt ? "prompt" : "steer", workId: work.id, message: formatThreadMessage(this.message(work), prepared.text), images: prepared.images ?? [] });
      const insertedAt = Date.now();
      if (this.suspended || this.row(id)?.held) return;
      this.sql("UPDATE thread_work SET inserted_at=COALESCE(inserted_at,?),landed_at=CASE WHEN ? THEN COALESCE(landed_at,?) ELSE landed_at END WHERE id=? AND status='dispatched'").run(insertedAt, prompt ? 1 : 0, insertedAt, work.id);
      runtime!.busy = true; this.state(id, "running");
      for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_message_inserted", workId: work.id, executionId: runtime!.executionId, insertedAt, message: { ...this.message(work), insertedAt, state: "dispatched" } } });
      this.wake(id);
    } catch (error) {
      if (error instanceof NativeRejection && !this.suspended && runtime) {
        this.sql("UPDATE thread SET metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(error.message, id);
        await this.finish(id, runtime, "failed", null);
      } else throw error;
    }
  }
  private async rejectStartup(id: string, error: string): Promise<void> {
    // Startup acknowledgements can be lost. Confirm absence or cancellation before settling.
    this.sql("UPDATE thread SET held=1 WHERE id=?").run(id);
    const runtime = this.runtimes.get(id) ?? await this.attach(id);
    if (runtime) await this.rpc(runtime, { type: "abort" });
    this.transaction(() => {
      if (this.execution(id)) return;
      const work = this.sql("SELECT id,settings FROM thread_work WHERE thread_id=? AND status='queued' ORDER BY front DESC,ordinal LIMIT 1").get(id) as Json | undefined;
      if (!work) return;
      const executionId = randomUUID();
      this.sql("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES(?,?,?,?,?)").run(executionId, id, work.id, work.settings, Date.now());
      this.sql("UPDATE thread_work SET status='dispatched',execution_id=? WHERE id=?").run(executionId, work.id);
    });
    if (runtime) runtime.executionId = this.execution(id)?.id;
    await this.finish(id, runtime, "failed", null, error);
    if (this.closed || this.suspended) return;
    this.sql("UPDATE thread SET state='idle',metadata=json_set(metadata,'$.executionError',?) WHERE id=?").run(error, id);
    this.changed(id);
  }
  private async finish(id: string, runtime: Runtime | undefined, outcome: WorkOutcome, finalMessage: Json | null, error?: string): Promise<void> {
    if (this.suspended || this.closed) return;
    const execution = this.execution(id); if (!execution || runtime && runtime.executionId !== execution.id) { if (runtime) runtime.busy = false; return; }
    const thread = this.get(id)!, workIds = (this.sql("SELECT id FROM thread_work WHERE execution_id=? AND status!='done'").all(execution.id) as { id: string }[]).map(work => work.id);
    this.transaction(() => {
      this.sql("UPDATE thread_execution SET outcome=?,final_message=?,error=?,ended_at=?,settlement_seq=(SELECT COALESCE(MAX(settlement_seq),0)+1 FROM thread_execution) WHERE id=? AND ended_at IS NULL").run(outcome, JSON.stringify(finalMessage), error ?? null, Date.now(), execution.id);
      this.sql("UPDATE thread_work SET status='done',outcome=?,final_message=?,error=? WHERE execution_id=? AND status!='done'").run(outcome, JSON.stringify(finalMessage), error ?? null, execution.id);
      this.sql("UPDATE thread SET state=CASE WHEN held=1 THEN 'idle' WHEN EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=thread.id AND w.status!='done') THEN 'running' ELSE 'idle' END,revision=revision+1,updated_at=? WHERE id=?").run(Date.now(), id);
      if (thread.metadata?.ephemeral && !this.sql("SELECT 1 FROM thread_work WHERE thread_id=? AND status!='done' LIMIT 1").get(id)) {
        this.sql("UPDATE thread SET held=1,metadata=json_set(metadata,'$.archived',json('true'),'$.archivedAt',?) WHERE id=?").run(new Date().toISOString(), id);
      }
      if (thread.parentId) {
        const receipt = `thread-result:${execution.id}`;
        if (!this.sql("SELECT 1 FROM thread_work WHERE id=?").get(receipt)) this.insertMessage(receipt, {
          requestId: receipt, threadId: thread.parentId, senderId: id, text: serializeThreadNotification({ type: "thread_idle", title: thread.title, outcome, finalMessage, ...(error ? { error } : {}) }),
          delivery: "steer", source: "notification", replyTo: execution.work_id,
        }, this.get(thread.parentId)?.settings ?? thread.settings);
      }
    });
    if (runtime) { runtime.executionId = undefined; runtime.busy = false; }
    if (runtime?.lease) { const lease = runtime.lease; runtime.lease = undefined; await lease.release(); }
    if (this.suspended || this.closed) return;
    this.changed(id);
    if (thread.parentId && this.row(thread.parentId)) { this.changed(thread.parentId); this.wake(thread.parentId); }
    void this.routeNotifications();
    const settled = this.sql("SELECT settlement_seq,ended_at FROM thread_execution WHERE id=?").get(execution.id) as Json;
    for (const listener of this.listeners) listener({ threadId: id, event: { type: "thread_settled", seq: settled.settlement_seq, executionId: execution.id, workId: execution.work_id, workIds, outcome, time: settled.ended_at, finalMessage, ...(error ? { error } : {}) } });
    if (runtime) await this.retire(id, runtime);
  }
  private async retire(id: string, runtime: Runtime): Promise<void> {
    if (this.suspended || runtime.busy || runtime.executionId || this.runtimes.get(id) !== runtime) return;
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
      if (input.metadata?.raw !== undefined && (input.metadata.raw !== true || input.metadata.context !== undefined || input.metadata.execution === "root-repair")) return bad("invalid_request", "Invalid imported raw execution boundary");
      const settings = resolveThreadSettings(input.settings); if (!settings.ok) return settings;
      this.sql("INSERT INTO thread(id,parent_id,title,cwd,session_file,settings,admission,state,held,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.id, input.parentId ?? null, input.title, input.cwd, input.sessionFile, JSON.stringify(settings.value), input.parentId ? "force" : input.admission ?? "force", "idle", input.held ? 1 : 0, input.createdAt ?? Date.now(), input.updatedAt ?? Date.now(), JSON.stringify(input.metadata ?? {}));
      return good(this.get(input.id)!);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
  importMessage(input: ImportMessage): Result<ThreadMessage> {
    try {
      const thread = this.get(input.threadId); if (!thread) return bad("not_found", "Import the thread before its input");
      const prior = this.sql("SELECT * FROM thread_work WHERE id=?").get(input.id) as Json | undefined;
      if (prior) return prior.thread_id === input.threadId && prior.text === input.text ? good(this.message(prior)) : bad("conflict", "Imported message identity has different input");
      this.transaction(() => {
        this.insertMessage(input.id, { requestId: input.requestId ?? input.id, threadId: input.threadId, senderId: input.senderId ?? undefined, text: input.text, images: input.images, delivery: resolveDelivery({ senderId: input.senderId ?? undefined, delivery: input.delivery }), source: input.source, replyTo: input.replyTo }, input.settings ?? thread.settings);
        this.sql("INSERT INTO thread_request(id,hash,kind,target) VALUES(?,'import','import-message',?)").run(input.requestId ?? input.id, input.id);
        const done = input.state === "done";
        const executionId = input.executionId ?? `import:${input.id}`;
        if (input.state === "dispatched") this.sql("INSERT OR IGNORE INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES(?,?,?,?,?)").run(executionId, input.threadId, input.id, JSON.stringify(input.settings ?? thread.settings), input.createdAt ?? Date.now());
        if (done) this.sql("INSERT OR IGNORE INTO thread_execution(id,thread_id,work_id,settings,created_at,ended_at,outcome,final_message) VALUES(?,?,?,?,?,?,?,?)")
          .run(executionId, input.threadId, input.id, JSON.stringify(input.settings ?? thread.settings), input.createdAt ?? Date.now(), input.createdAt ?? Date.now(), input.outcome ?? "complete", JSON.stringify(input.finalMessage ?? null));
        this.sql("UPDATE thread_work SET status=?,execution_id=?,created_at=?,inserted_at=?,outcome=?,final_message=? WHERE id=?")
          .run(input.state ?? "queued", done || input.state === "dispatched" ? executionId : null, input.createdAt ?? Date.now(), input.insertedAt ?? null, input.outcome ?? (done ? "complete" : null), input.finalMessage === undefined ? null : JSON.stringify(input.finalMessage), input.id);
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
  async detach(): Promise<Result<void>> {
    this.suspend();
    await Promise.allSettled([...this.operations.values(), ...this.halts.values()]);
    for (const runtime of this.runtimes.values()) if (!runtime.busy && !runtime.executionId) {
      try { await runtime.session.close(); } catch (error) { return bad("unavailable", errorText(error)); }
    }
    this.runtimes.clear(); this.listeners.clear();
    if (!this.closed) { this.closed = true; this.db.close(); }
    return good(undefined);
  }
  async close(): Promise<Result<void>> {
    if (this.closed) return good(undefined);
    if (this.sql("SELECT 1 FROM thread_execution WHERE ended_at IS NULL LIMIT 1").get() || [...this.runtimes.values()].some(runtime => runtime.busy) || this.operations.size) return bad("conflict", "Active execution must settle before controller handoff");
    this.started = false; clearInterval(this.timer);
    try {
      for (const [id, runtime] of this.runtimes) { this.runtimes.delete(id); await runtime.session.close(); }
      this.closed = true;
      for (const cancel of this.awaiting) cancel();
      this.db.close(); this.listeners.clear(); return good(undefined);
    } catch (error) { return bad("unavailable", errorText(error)); }
  }
}
