import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { memoryClient } from "./client.js";
import { oneKenanEnabled } from "./config.js";
import type { MemoryClient, MemoryInput, MemoryRequest, MemoryResult, MemoryValue } from "./contract.js";

export type ActionSpec = {
  action: string;
  recipients: string[];
  summary: string;
  actedFor?: string;
  affected?: string[];
  obviouslyPrivate?: boolean;
  threadId?: string;
  roomId?: string;
  externalId?: string;
};
export type ActionTicket = { id: string; spec: ActionSpec; startedAt: string };
export type ActionOutcome = "confirmed" | "failed" | "unconfirmed";
export type JournalResult = { ok: true } | { ok: false; error: string };
type Options = { enabled?: () => boolean; directory?: string; client?: MemoryClient; person?: string; autoDrain?: boolean };
const compact = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 800);
const intimate = /\b(?:medical|diagnos\w*|prescription|medication|therapy|therapist|psychiatr\w*|doctor|physician|cancer|pregnan\w*|sexual\w*|sex|orgasm\w*|porn\w*|romantic|divorce|relationship|conflict|bank|mortgage|salary|income|tax|insurance|debt|password|credential|secret|passport|identity|confidential|private)\b/i;
export function actionObviouslyPrivate(spec: ActionSpec): boolean { return spec.obviouslyPrivate === true || process.env.PI_KENAN_ACTION_PRIVATE === "1" || intimate.test(spec.summary); }

export const actionJournalEnabled = oneKenanEnabled;
export function actionPerson(): string { return process.env.PI_KENAN_PERSON ?? process.env.PI_REMOTE_SENDER_ID ?? process.env.USER ?? "kenan"; }
function journalClient(): MemoryClient {
  return { async request<T = MemoryValue>(request: MemoryRequest): Promise<MemoryResult<T>> {
    try {
      const path = process.env.PI_KENAN_MEMORY_PUBLISHER_TOKEN_FILE ?? (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "kenan-memory-publisher") : undefined);
      return memoryClient({ token: path ? readFileSync(path, "utf8").trim() : undefined }).request<T>(request);
    } catch { return { ok: false, error: "unavailable", message: "Action journal publisher credential unavailable; receipts retained" }; }
  } };
}

export class ActionJournal {
  readonly directory: string;
  private readonly enabled: () => boolean;
  private readonly client: MemoryClient;
  private readonly person: string;
  private readonly autoDrain: boolean;
  private draining?: Promise<JournalResult>;
  constructor(options: Options = {}) {
    this.directory = options.directory ?? process.env.PI_KENAN_ACTION_JOURNAL_DIR ?? "/var/lib/pi-stack/kenan-actions";
    this.enabled = options.enabled ?? actionJournalEnabled;
    this.client = options.client ?? journalClient();
    this.person = options.person ?? actionPerson();
    this.autoDrain = options.autoDrain ?? true;
  }
  private persist(ticket: ActionTicket, outcome: "attempted" | ActionOutcome, detail = ""): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const spec = ticket.spec;
    const person = spec.actedFor ?? this.person;
    const item: MemoryInput = {
      text: `Kenan ${outcome === "attempted" ? "is attempting" : outcome === "confirmed" ? "completed" : outcome === "failed" ? "did not complete" : "could not confirm"} ${spec.action} for ${person}, to ${spec.recipients.map(compact).join(", ") || "their calendar"}. ${compact(spec.summary)}${spec.externalId ? ` Reference: ${compact(spec.externalId)}.` : ""}${detail ? ` Outcome: ${compact(detail)}` : ""}${outcome === "attempted" ? " This records an attempt, not proof it happened; if no outcome follows, it may or may not have executed. Do not retry automatically." : ""}`,
      about: [...new Set([person, ...(spec.affected ?? []), ...spec.recipients.filter(value => value.trim())])].slice(0, 100),
      source: { actedFor: person, action: `${spec.action}:${outcome}`, externalId: `action:${ticket.id}:${outcome}` },
      setting: { person, ...(spec.threadId ? { threadId: spec.threadId } : {}), ...(spec.roomId ? { roomId: spec.roomId } : {}) },
      occurredAt: outcome === "attempted" ? ticket.startedAt : new Date().toISOString(),
      obviouslyPrivate: actionObviouslyPrivate(spec),
    };
    const file = join(this.directory, `${ticket.id}.${outcome}.json`), temp = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(item)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(this.directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
    if (this.autoDrain) void this.drain();
  }
  begin(spec: ActionSpec): ActionTicket | null {
    if (!this.enabled()) return null;
    const ticket: ActionTicket = { id: randomUUID(), spec: { ...spec, actedFor: spec.actedFor ?? this.person, threadId: spec.threadId ?? process.env.PI_THREAD_ID ?? process.env.PI_REMOTE_SESSION_ID }, startedAt: new Date().toISOString() };
    // Intent must be durable before the irreversible send. Failure prevents dispatch.
    this.persist(ticket, "attempted");
    return ticket;
  }
  finish(ticket: ActionTicket | null, outcome: ActionOutcome, detail = ""): JournalResult {
    if (!ticket) return { ok: true };
    try { this.persist(ticket, outcome, detail); return { ok: true }; }
    catch (cause) { return { ok: false, error: `Action ${ticket.id} ${outcome}; outcome journal could not be saved (${String(cause)}). The durable attempt remains. Do not repeat the action.` }; }
  }
  drain(): Promise<JournalResult> {
    if (this.draining) return this.draining;
    this.draining = this.flush().catch(cause => ({ ok: false as const, error: `Action journal drain failed; receipts retained: ${String(cause)}` })).finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async flush(): Promise<JournalResult> {
    if (!this.enabled() || !existsSync(this.directory)) return { ok: true };
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]+\.(attempted|confirmed|failed|unconfirmed)\.json$/.test(name)).sort()) {
      const path = join(this.directory, file);
      let item: MemoryInput;
      try { item = JSON.parse(readFileSync(path, "utf8")); }
      catch (cause) { if (!existsSync(path)) continue; return { ok: false, error: `Invalid journal receipt ${file}: ${String(cause)}` }; }
      const result: MemoryResult = await this.client.request({ operation: "write", item });
      if (!result.ok) return { ok: false, error: `Action journal pending: ${result.error}: ${result.message}` };
      try { unlinkSync(path); } catch (cause) { if (existsSync(path)) return { ok: false, error: `Memory accepted ${file}, but receipt cleanup failed: ${String(cause)}` }; }
    }
    return { ok: true };
  }
}
export const actionJournal = new ActionJournal();

export function journalWarning(result: JournalResult): string | undefined { return result.ok ? undefined : result.error; }
