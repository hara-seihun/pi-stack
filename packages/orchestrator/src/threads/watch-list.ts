import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "../sqlite.js";
import type { Result, SpawnThread, ThreadApi, ThreadSettings } from "./contracts.js";
import { resolveThreadSettings } from "./settings.js";

export interface WatchItem {
  id: string; what: string; why: string; how?: string; cadenceMs?: number; nextDueAt: number;
  addedBy: string; createdAt: number; updatedAt: number; lastCheck?: WatchCheck; destination?: string;
}
export type WatchCheck =
  | { threadId: string; status: "scheduled" }
  | { threadId: string; status: "complete"; at: number }
  | { threadId: string; status: "failed"; at: number; error: string };
export type WatchCheckOutcome =
  | { status: "open" } | { status: "missing" }
  | { status: "complete"; at: number } | { status: "failed"; at: number; error: string };
export type WatchFields = Pick<WatchItem, "what" | "why" | "how" | "cadenceMs" | "nextDueAt" | "destination">;
export type WatchRequest = { threadId: string } & (
  | { action: "list" } | { action: "checkNow"; requestId: string }
  | { action: "add"; requestId: string; item: Omit<WatchFields, "nextDueAt"> & { nextDueAt?: number } }
  | { action: "update"; requestId: string; id: string; patch: Partial<Omit<WatchFields, "how" | "cadenceMs">> & { how?: string | null; cadenceMs?: number | null } }
  | { action: "remove"; requestId: string; id: string });
export type WatchResponse = { items: WatchItem[] } | { item: WatchItem } | { removed: true; id: string } | { scheduledThreadIds: string[] };
export interface WatchApi { watch(input: WatchRequest): Promise<Result<WatchResponse>> }
export interface WatchListOptions {
  databasePath: string;
  threads: Pick<ThreadApi, "spawn" | "list" | "questions">;
  placement: (destination: string) => Result<Pick<SpawnThread, "cwd" | "metadata">>;
  destinations?: readonly string[]; defaultDestination?: string;
  destinationOf?: (threadId: string) => string | undefined;
  intervalMs?: number; settings?: ThreadSettings;
  checkOutcome: (threadId: string) => Result<WatchCheckOutcome>;
  enabled?: boolean;
  onError: (error: string | null) => void;
}
export interface PendingWatchDecision { threadId: string; question: string }
export const DEFAULT_WATCH_INTERVAL_MS = 45 * 60_000;
export function watchInterval(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WATCH_INTERVAL_MS;
  const interval = Number(value);
  if (!Number.isSafeInteger(interval) || interval < 60_000) throw new Error("PI_REMOTE_WATCH_INTERVAL_MS must be an integer of at least 60000");
  return interval;
}
export function watchSettings(model: string | undefined): Result<ThreadSettings> {
  return resolveThreadSettings({ model: model === undefined ? "anthropic/claude-opus-5-5" : model, thinkingLevel: "high", speed: "standard" });
}
export function watchPrompt(items: WatchItem[], destination?: string, decisions: PendingWatchDecision[] = []): string {
  return `Adopted watch occurrence for ${destination ?? "the owning person"}. Complete this accepted check, preserve unanswered decisions, write the result and next action to the owning Markdown notes, and finish. Kenaznia judges future timing; do not schedule workers or park on wakes.\n\nItems:\n${JSON.stringify(items)}\n\nUnanswered decisions:\n${JSON.stringify(decisions)}`;
}
const good = <T>(value: T): Result<T> => ({ ok: true, value });
const unavailable = (message: string): Result<never> => ({ ok: false, error: { code: "unavailable", message } });

export interface WatchDutyExport {
  items: Array<WatchItem & { lastThreadId?: string }>;
  pendingOccurrences: Array<{ id: string; input: SpawnThread; delivery: { retryAt: number; error: string } | null }>;
  nextWakeAt: number;
  requests: Array<{ id: string; input: string; response: string }>;
  markdownReceipt: string | null;
}

/** Custody reader/drainer for accepted occurrences. Future duties live in Markdown, not a worker factory. */
export class WatchList implements WatchApi {
  private readonly db: DatabaseSync;
  private stopped = false;
  private ticking?: Promise<Result<void>>;
  constructor(private readonly options: WatchListOptions) {
    this.db = openSqlite(options.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS watch_item (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_request (id TEXT PRIMARY KEY, input TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_wake (id TEXT PRIMARY KEY, input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_delivery (id TEXT PRIMARY KEY, retryAt INTEGER NOT NULL, error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_schedule (id INTEGER PRIMARY KEY CHECK(id=1), nextWakeAt INTEGER NOT NULL);
      INSERT OR IGNORE INTO watch_schedule(id,nextWakeAt) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS watch_markdown_adoption (id INTEGER PRIMARY KEY CHECK(id=1), receipt TEXT NOT NULL);`);
  }
  exportDuties(): WatchDutyExport {
    const items = (this.db.prepare("SELECT body FROM watch_item ORDER BY rowid").all() as { body: string }[]).map(row => JSON.parse(row.body));
    const pendingOccurrences = (this.db.prepare("SELECT w.id,w.input,d.retryAt,d.error FROM watch_wake w LEFT JOIN watch_delivery d ON d.id=w.id ORDER BY w.rowid").all() as Array<{ id: string; input: string; retryAt: number | null; error: string | null }>).map(row => ({
      id: row.id, input: JSON.parse(row.input) as SpawnThread,
      delivery: row.retryAt === null ? null : { retryAt: row.retryAt, error: row.error! },
    }));
    const next = this.db.prepare("SELECT nextWakeAt FROM watch_schedule WHERE id=1").get() as { nextWakeAt: number };
    const receipt = this.db.prepare("SELECT receipt FROM watch_markdown_adoption WHERE id=1").get() as { receipt: string } | undefined;
    return { items, pendingOccurrences, nextWakeAt: next.nextWakeAt,
      requests: this.db.prepare("SELECT id,input,response FROM watch_request ORDER BY rowid").all() as WatchDutyExport["requests"], markdownReceipt: receipt?.receipt ?? null };
  }
  adoptDuties(markdownReceipt: string): Result<void> {
    if (!markdownReceipt.trim()) return { ok: false, error: { code: "invalid_request", message: "A durable Markdown custody receipt is required" } };
    try {
      const prior = this.exportDuties().markdownReceipt;
      if (prior !== null && prior !== markdownReceipt) return { ok: false, error: { code: "conflict", message: "Watch duties already have a different Markdown custody receipt" } };
      this.db.prepare("INSERT OR IGNORE INTO watch_markdown_adoption(id,receipt) VALUES(1,?)").run(markdownReceipt);
      return good(undefined);
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
  }
  async watch(input: WatchRequest): Promise<Result<WatchResponse>> {
    if (this.stopped) return unavailable("Watch occurrence custodian is stopping");
    if (input.action === "list") return good({ items: this.exportDuties().items });
    const prior = this.db.prepare("SELECT input,response FROM watch_request WHERE id=?").get(input.requestId) as { input: string; response: string } | undefined;
    if (prior && prior.input === JSON.stringify(input)) return good(JSON.parse(prior.response));
    return { ok: false, error: { code: "invalid_request", message: "Persistent watch duties are Markdown. Ask Kenaznia to change the owning notes or dispatch a check." } };
  }
  backfill(): Result<number> { return good(0); }
  start(): void { /* No timer: core adoption/drain owns accepted occurrences. */ }
  tick(now = Date.now()): Promise<Result<void>> {
    if (this.stopped || this.options.enabled === false) return Promise.resolve(good(undefined));
    if (this.ticking) return this.ticking;
    this.ticking = this.drain(now).catch(error => unavailable(error instanceof Error ? error.message : String(error))).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async drain(now: number): Promise<Result<void>> {
    for (const occurrence of this.exportDuties().pendingOccurrences) {
      if (this.stopped) return good(undefined);
      if (occurrence.delivery !== null && occurrence.delivery.retryAt > now) continue;
      const accepted = await this.options.threads.spawn(occurrence.input);
      if (!accepted.ok) return accepted;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM watch_wake WHERE id=?").run(occurrence.id);
        this.db.prepare("DELETE FROM watch_delivery WHERE id=?").run(occurrence.id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    return good(undefined);
  }
  stop(): void { this.stopped = true; }
  async close(): Promise<void> { this.stop(); await this.ticking; this.db.close(); }
}
