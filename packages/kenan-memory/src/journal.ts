import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { memoryClient } from "./client.js";
import { oneKenanEnabled } from "./config.js";
import type { MemoryClient, MemoryInput, MemoryRequest, MemoryResult, MemoryValue } from "./contract.js";
import { stateValue } from "./explicit-state.js";

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
const outcomeWords = {
  attempted: "is attempting", confirmed: "completed", failed: "did not complete", unconfirmed: "could not confirm",
} satisfies Record<"attempted" | ActionOutcome, string>;
export type JournalResult = { ok: true } | { ok: false; error: string };
type Options = { enabled?: () => boolean; directory?: string; client?: MemoryClient; person?: string; autoDrain?: boolean };
const compact = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 800);
const intimate = /\b(?:medical|diagnos\w*|prescription|medication|therapy|therapist|psychiatr\w*|doctor|physician|cancer|pregnan\w*|sexual\w*|sex|orgasm\w*|porn\w*|romantic|divorce|relationship|conflict|bank|mortgage|salary|income|tax|insurance|debt|password|credential|secret|passport|identity|confidential|private)\b/i;
export function actionObviouslyPrivate(spec: ActionSpec): boolean { return spec.obviouslyPrivate === true || process.env.PI_KENAN_ACTION_PRIVATE === "1" || intimate.test(spec.summary); }

export const actionJournalEnabled = oneKenanEnabled;
export function actionPerson(): string { return process.env.PI_KENAN_PERSON ?? process.env.PI_REMOTE_SENDER_ID ?? process.env.USER ?? "kenan"; }
export function actionJournalDirectory(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.()): string {
  let privateDir = env.PI_REMOTE_PRIVATE_DIR;
  if (!privateDir && env.PI_REMOTE_CONFIG && existsSync(env.PI_REMOTE_CONFIG)) {
    privateDir = JSON.parse(readFileSync(env.PI_REMOTE_CONFIG, "utf8")).unlock?.mountpoint;
  }
  if (uid !== 0 && privateDir && isAbsolute(privateDir)) return join(privateDir, ".kenan-actions");
  return env.PI_KENAN_ACTION_JOURNAL_DIR ?? (privateDir ? join(privateDir, ".kenan-actions") : "/var/lib/pi-stack/kenan-actions");
}

export function journalDrainDirectories(env: NodeJS.ProcessEnv = process.env, mounted = (path: string) => spawnSync("mountpoint", ["-q", "--", path], { timeout: 1000 }).status === 0): string[] {
  const directories = [actionJournalDirectory(env)];
  const signalJournal = (privateDir: unknown, data: unknown): string | null => {
    if (typeof privateDir !== "string" || typeof data !== "string" || !isAbsolute(privateDir) || !isAbsolute(data) || !mounted(privateDir) || !existsSync(data)) return null;
    const suffix = relative(realpathSync(privateDir), realpathSync(data));
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../")) return null;
    const path = join(data, "messaging", "action-journal");
    if (existsSync(path)) {
      const scope = relative(realpathSync(privateDir), realpathSync(path));
      if (isAbsolute(scope) || scope === ".." || scope.startsWith("../")) return null;
    }
    return path;
  };
  const ownSignal = signalJournal(env.PI_REMOTE_PRIVATE_DIR, env.PI_REMOTE_DATA);
  if (ownSignal) directories.push(ownSignal);
  const registry = env.PI_REMOTE_PERSONS_DIR ?? "/var/lib/pi-remote/persons";
  if (existsSync(registry)) for (const file of readdirSync(registry).filter(name => name.endsWith(".json")).sort()) {
    const person = JSON.parse(readFileSync(join(registry, file), "utf8"));
    const mountpoint = person.unlock?.mountpoint;
    if (person.version !== 1 || typeof mountpoint !== "string" || !isAbsolute(mountpoint) || !mounted(mountpoint)) continue;
    directories.push(join(mountpoint, ".kenan-actions"));
    const signal = signalJournal(mountpoint, person.environment?.PI_REMOTE_DATA);
    if (signal) directories.push(signal);
  }
  return [...new Set(directories)];
}

export function journalClient(): MemoryClient {
  return { async request<T = MemoryValue>(request: MemoryRequest): Promise<MemoryResult<T>> {
    try {
      const path = process.env.PI_KENAN_MEMORY_PUBLISHER_TOKEN_FILE ?? (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "kenan-memory-publisher") : undefined);
      let token: string | null = null;
      if (path) try { token = readFileSync(path, "utf8").trim(); }
      catch (cause) { if (!["ENOENT", "EACCES"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause; }
      // Journal replay outlives model sessions. No publisher means verified socket UID,
      // never an inherited session token whose thread constraint may be stale.
      return memoryClient({ token }).request<T>(request);
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
    this.directory = options.directory ?? actionJournalDirectory();
    this.enabled = options.enabled ?? actionJournalEnabled;
    this.client = options.client ?? journalClient();
    this.person = options.person ?? actionPerson();
    this.autoDrain = options.autoDrain ?? true;
  }
  private persist(ticket: ActionTicket, outcome: "attempted" | ActionOutcome, detail = ""): void {
    const outcomeWord = stateValue(outcomeWords, outcome);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const spec = ticket.spec;
    const person = spec.actedFor ?? this.person;
    const item: MemoryInput = {
      text: `Kenan ${outcomeWord} ${spec.action} for ${person}, to ${spec.recipients.map(compact).join(", ") || "their calendar"}. ${compact(spec.summary)}${spec.externalId ? ` Reference: ${compact(spec.externalId)}.` : ""}${detail ? ` Outcome: ${compact(detail)}` : ""}${outcome === "attempted" ? " This records an attempt, not proof it happened; if no outcome follows, it may or may not have executed. Do not retry automatically." : ""}`,
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
    if (outcome !== "confirmed" && outcome !== "failed" && outcome !== "unconfirmed") return { ok: false, error: `Unknown action outcome: ${String(outcome)}` };
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
