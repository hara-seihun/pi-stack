import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "./sqlite.js";
import type { Admission, SettingsOverrides, ThreadApi, ThreadSettings } from "./threads/contracts.js";
import { resolveThreadSettings } from "./threads/settings.js";

export type ScheduleState = "active" | "paused";
export type ScheduleOccurrenceState = "pending" | "accepted" | "failed";

export interface ScheduleOccurrence {
  scheduledAt: number;
  state: ScheduleOccurrenceState;
  threadId: string;
  error?: string;
}

export interface Schedule {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  intervalMs: number;
  nextRunAt: number;
  settings: ThreadSettings;
  admission: Admission;
  state: ScheduleState;
  createdAt: number;
  updatedAt: number;
  lastThreadId?: string;
  lastScheduledAt?: number;
  lastError?: string;
  lastOccurrence?: ScheduleOccurrence;
}

export interface CreateSchedule {
  id?: string;
  title?: string;
  prompt: string;
  cwd: string;
  intervalMs: number;
  startAt?: number;
  settings?: SettingsOverrides;
  admission?: Admission;
}

export type ScheduleErrorCode = "not_found" | "invalid_request" | "conflict" | "unavailable";
export type ScheduleResult<T> = { ok: true; value: T } | { ok: false; error: { code: ScheduleErrorCode; message: string } };

export interface ScheduleServiceOptions {
  databasePath: string;
  threads: ThreadApi;
  now?: () => number;
}

type Row = Record<string, any>;
const good = <T>(value: T): ScheduleResult<T> => ({ ok: true, value });
const bad = <T = never>(code: ScheduleErrorCode, message: string): ScheduleResult<T> => ({ ok: false, error: { code, message } });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 366 * 24 * 60 * 60_000;

export class ScheduleService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private operations: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: ScheduleServiceOptions) {
    this.db = openSqlite(options.databasePath);
    this.now = options.now ?? Date.now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS recurring_schedule (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
        interval_ms INTEGER NOT NULL, next_run_at INTEGER NOT NULL, settings TEXT NOT NULL,
        admission TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_thread_id TEXT, last_scheduled_at INTEGER, last_error TEXT);
      CREATE INDEX IF NOT EXISTS recurring_schedule_due ON recurring_schedule(state,next_run_at);
      CREATE TABLE IF NOT EXISTS schedule_occurrence (
        schedule_id TEXT NOT NULL REFERENCES recurring_schedule(id) ON DELETE CASCADE,
        scheduled_at INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(schedule_id,scheduled_at));
      CREATE INDEX IF NOT EXISTS schedule_occurrence_pending ON schedule_occurrence(status,created_at);`);
  }

  private exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.operations.catch(() => {}).then(() => {
      if (this.closed) throw new Error("Schedule service is closed");
      return operation();
    });
    this.operations = next.then(() => {}, () => {});
    return next;
  }

  private occurrence(row: Row | undefined): ScheduleOccurrence | undefined {
    return row ? {
      scheduledAt: row.scheduled_at,
      state: row.status,
      threadId: row.thread_id,
      ...(row.error ? { error: row.error } : {}),
    } : undefined;
  }

  private project(row: Row): Schedule {
    const occurrence = this.db.prepare("SELECT * FROM schedule_occurrence WHERE schedule_id=? ORDER BY scheduled_at DESC LIMIT 1").get(row.id) as Row | undefined;
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      cwd: row.cwd,
      intervalMs: row.interval_ms,
      nextRunAt: row.next_run_at,
      settings: JSON.parse(row.settings),
      admission: row.admission,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_thread_id ? { lastThreadId: row.last_thread_id } : {}),
      ...(row.last_scheduled_at !== null ? { lastScheduledAt: row.last_scheduled_at } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(occurrence ? { lastOccurrence: this.occurrence(occurrence) } : {}),
    };
  }

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM recurring_schedule WHERE id=?").get(id) as Row | undefined;
  }

  list(): ScheduleResult<{ schedules: Schedule[] }> {
    if (this.closed) return bad("unavailable", "Schedule service is closed");
    try {
      const schedules = (this.db.prepare("SELECT * FROM recurring_schedule ORDER BY created_at,id").all() as Row[]).map(row => this.project(row));
      return good({ schedules });
    } catch (error) {
      return bad("unavailable", errorText(error));
    }
  }

  get(id: string): ScheduleResult<Schedule> {
    if (this.closed) return bad("unavailable", "Schedule service is closed");
    try {
      const row = this.row(id);
      return row ? good(this.project(row)) : bad("not_found", `Schedule ${id} was not found`);
    } catch (error) {
      return bad("unavailable", errorText(error));
    }
  }

  create(input: CreateSchedule): Promise<ScheduleResult<Schedule>> {
    return this.exclusive(() => {
      const valid = this.validate(input);
      if (!valid.ok) return valid;
      const id = input.id ?? randomUUID();
      if (this.row(id)) return bad("conflict", `Schedule ${id} already exists`);
      const now = this.now();
      const nextRunAt = input.startAt ?? now + input.intervalMs;
      try {
        this.db.prepare(`INSERT INTO recurring_schedule
          (id,title,prompt,cwd,interval_ms,next_run_at,settings,admission,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.title?.trim() || `Schedule ${id.slice(0, 8)}`, input.prompt, input.cwd,
            input.intervalMs, nextRunAt, JSON.stringify(valid.value), input.admission ?? "force", "active", now, now);
        return good(this.project(this.row(id)!));
      } catch (error) {
        return bad("unavailable", errorText(error));
      }
    });
  }

  private validate(input: CreateSchedule): ScheduleResult<ThreadSettings> {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["id", "title", "prompt", "cwd", "intervalMs", "startAt", "settings", "admission"].includes(key))) {
      return bad("invalid_request", "Expected schedule id, title, prompt, cwd, intervalMs, startAt, settings, and admission fields");
    }
    if (input.id !== undefined && (typeof input.id !== "string" || input.id.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.id))) {
      return bad("invalid_request", "Schedule ID must be at most 100 filename-safe characters");
    }
    if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) return bad("invalid_request", "Schedule title must be nonempty");
    if (typeof input.prompt !== "string" || !input.prompt.trim()) return bad("invalid_request", "Schedule prompt must be nonempty");
    if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return bad("invalid_request", "Schedule cwd must be an absolute path");
    if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS || input.intervalMs > MAX_INTERVAL_MS) {
      return bad("invalid_request", `Schedule intervalMs must be ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS}`);
    }
    if (input.startAt !== undefined && (!Number.isSafeInteger(input.startAt) || input.startAt < 0)) return bad("invalid_request", "Schedule startAt must be a Unix timestamp in milliseconds");
    if (input.admission !== undefined && input.admission !== "force" && input.admission !== "background") return bad("invalid_request", "Schedule admission must be force or background");
    const settings = resolveThreadSettings(input.settings);
    return settings.ok ? good(settings.value) : bad("invalid_request", settings.error.message);
  }

  pause(id: string): Promise<ScheduleResult<Schedule>> {
    return this.setState(id, "paused");
  }

  resume(id: string): Promise<ScheduleResult<Schedule>> {
    return this.setState(id, "active");
  }

  private setState(id: string, state: ScheduleState): Promise<ScheduleResult<Schedule>> {
    return this.exclusive(() => {
      const row = this.row(id);
      if (!row) return bad("not_found", `Schedule ${id} was not found`);
      this.db.prepare("UPDATE recurring_schedule SET state=?,updated_at=?,last_error=CASE WHEN ?='active' THEN NULL ELSE last_error END WHERE id=?")
        .run(state, this.now(), state, id);
      return good(this.project(this.row(id)!));
    });
  }

  remove(id: string): Promise<ScheduleResult<{ id: string; removed: true }>> {
    return this.exclusive(() => {
      const removed = this.db.prepare("DELETE FROM recurring_schedule WHERE id=?").run(id).changes;
      return removed ? good({ id, removed: true }) : bad("not_found", `Schedule ${id} was not found`);
    });
  }

  reconcile(): Promise<void> {
    return this.exclusive(async () => {
      const rows = this.db.prepare("SELECT * FROM recurring_schedule WHERE state='active' ORDER BY next_run_at,id").all() as Row[];
      for (const initial of rows) {
        const current = this.row(initial.id);
        if (!current || current.state !== "active") continue;
        const pending = this.db.prepare("SELECT * FROM schedule_occurrence WHERE schedule_id=? AND status='pending' ORDER BY scheduled_at LIMIT 1").get(current.id) as Row | undefined;
        if (pending) {
          await this.dispatch(current, pending);
          continue;
        }
        if (!await this.previousFinished(current)) continue;
        const now = this.now();
        if (current.next_run_at > now) continue;
        const missed = Math.floor((now - current.next_run_at) / current.interval_ms);
        const scheduledAt = current.next_run_at + missed * current.interval_ms;
        const nextRunAt = scheduledAt + current.interval_ms;
        const threadId = `schedule:${current.id}:${scheduledAt}`;
        const requestId = `schedule:${current.id}:${scheduledAt}`;
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const latest = this.row(current.id);
          if (!latest || latest.state !== "active" || latest.next_run_at !== current.next_run_at) {
            this.db.exec("ROLLBACK");
            continue;
          }
          this.db.prepare(`INSERT INTO schedule_occurrence
            (schedule_id,scheduled_at,request_id,thread_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
            .run(current.id, scheduledAt, requestId, threadId, "pending", now, now);
          this.db.prepare("UPDATE recurring_schedule SET next_run_at=?,updated_at=? WHERE id=?").run(nextRunAt, now, current.id);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        const occurrence = this.db.prepare("SELECT * FROM schedule_occurrence WHERE schedule_id=? AND scheduled_at=?").get(current.id, scheduledAt) as Row;
        await this.dispatch(this.row(current.id)!, occurrence);
      }
    });
  }

  private async previousFinished(schedule: Row): Promise<boolean> {
    if (!schedule.last_thread_id) return true;
    const result = await this.options.threads.list({ id: schedule.last_thread_id, limit: 1 });
    if (!result.ok) return false;
    const thread = result.value.threads[0];
    return !thread || thread.state === "idle" && thread.pendingMessages === 0;
  }

  private async dispatch(schedule: Row, occurrence: Row): Promise<void> {
    const result = await this.options.threads.spawn({
      requestId: occurrence.request_id,
      id: occurrence.thread_id,
      title: `${schedule.title} ${new Date(occurrence.scheduled_at).toISOString()}`,
      cwd: schedule.cwd,
      message: schedule.prompt,
      settings: JSON.parse(schedule.settings),
      admission: schedule.admission,
      metadata: { scheduleId: schedule.id, scheduledAt: occurrence.scheduled_at },
    });
    const now = this.now();
    if (result.ok) {
      this.db.prepare("UPDATE schedule_occurrence SET status='accepted',error=NULL,updated_at=? WHERE schedule_id=? AND scheduled_at=?")
        .run(now, schedule.id, occurrence.scheduled_at);
      this.db.prepare("UPDATE recurring_schedule SET last_thread_id=?,last_scheduled_at=?,last_error=NULL,updated_at=? WHERE id=?")
        .run(result.value.id, occurrence.scheduled_at, now, schedule.id);
      return;
    }
    if (result.error.code === "unavailable" || result.error.retryable) return;
    this.db.prepare("UPDATE schedule_occurrence SET status='failed',error=?,updated_at=? WHERE schedule_id=? AND scheduled_at=?")
      .run(result.error.message, now, schedule.id, occurrence.scheduled_at);
    this.db.prepare("UPDATE recurring_schedule SET state='paused',last_error=?,updated_at=? WHERE id=?")
      .run(result.error.message, now, schedule.id);
  }

  async close(): Promise<void> {
    await this.operations.catch(() => {});
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function response<T>(result: ScheduleResult<T>): Response {
  if (result.ok) return Response.json(result);
  const status = result.error.code === "not_found" ? 404 : result.error.code === "conflict" ? 409 : result.error.code === "invalid_request" ? 400 : 503;
  return Response.json(result, { status });
}

export async function scheduleHttp(service: ScheduleService, request: Request, prefix = "/v1/schedules"): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return undefined;
  const suffix = path.slice(prefix.length).replace(/^\//, "");
  const parts = suffix ? suffix.split("/").map(decodeURIComponent) : [];
  try {
    if (!parts.length && request.method === "GET") return response(service.list());
    if (!parts.length && request.method === "POST") {
      let input: unknown;
      try { input = await request.json(); }
      catch { return response(bad("invalid_request", "Expected a JSON object")); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return response(bad("invalid_request", "Expected a JSON object"));
      const created = await service.create(input as CreateSchedule);
      if (created.ok) await service.reconcile();
      return response(created);
    }
    if (parts.length === 1 && request.method === "GET") return response(service.get(parts[0]!));
    if (parts.length === 1 && request.method === "DELETE") return response(await service.remove(parts[0]!));
    if (parts.length === 2 && request.method === "POST" && parts[1] === "pause") return response(await service.pause(parts[0]!));
    if (parts.length === 2 && request.method === "POST" && parts[1] === "resume") {
      const resumed = await service.resume(parts[0]!);
      if (resumed.ok) await service.reconcile();
      return response(resumed);
    }
    return Response.json({ ok: false, error: { code: "not_found", message: "Schedule route was not found" } }, { status: 404 });
  } catch (error) {
    return response(bad("unavailable", errorText(error)));
  }
}
