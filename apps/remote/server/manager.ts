import type { Database } from "bun:sqlite";
import { watchSettings, type Result, type SpawnThread, type Thread, type ThreadApi, type ThreadSettings } from "pi-orchestrator/api";
import type { ManagerView } from "./protocol";
import type { ThreadDestination } from "./thread-model-defaults";

export const MANAGER_HEARTBEAT_MS = 4 * 60 * 60_000;

export function managerDestination(destinations: readonly ThreadDestination[], configured: string | undefined): Result<ThreadDestination> {
  const full = destinations.filter(destination => !destination.raw && !destination.sandbox);
  const id = configured === undefined ? (full.find(destination => destination.id === "personal") ?? full.find(destination => destination.id === "home") ?? full[0])?.id : configured;
  const destination = full.find(destination => destination.id === id);
  return destination ? { ok: true, value: destination } : { ok: false, error: { code: "invalid_request", message: "PI_REMOTE_MANAGER_DESTINATION must name an offered full-context destination" } };
}

export function managerSettings(model: string | undefined): Result<ThreadSettings> {
  return watchSettings(model === undefined ? "anthropic/claude-opus-5-5" : model);
}

export type ManagerPatch = { view: "classic" | "mono"; hintSeen?: boolean };
export function parseManagerPatch(input: unknown): Result<ManagerPatch> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => key !== "view" && key !== "hintSeen")
    || !("view" in input) || (input.view !== "classic" && input.view !== "mono")
    || ("hintSeen" in input && typeof input.hintSeen !== "boolean")) {
    return { ok: false, error: { code: "invalid_request", message: "Manager preference requires view classic or mono and optional boolean hintSeen" } };
  }
  return { ok: true, value: input as ManagerPatch };
}

type ManagerRow = { view: "classic" | "mono"; thread_id: string | null; hint_seen: number; initialized: number };

export class Manager {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private db: Database, private threads: Pick<ThreadApi, "spawn" | "wakeSchedule">,
    private placement: () => Result<Pick<SpawnThread, "cwd" | "metadata">>, private settings: ThreadSettings,
    private changed: () => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS manager_view (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      view TEXT NOT NULL CHECK(view IN ('classic','mono')),
      thread_id TEXT, hint_seen INTEGER NOT NULL CHECK(hint_seen IN (0,1)),
      initialized INTEGER NOT NULL CHECK(initialized IN (0,1)),
      CHECK(initialized=0 OR thread_id IS NOT NULL), CHECK(view='classic' OR initialized=1));
      INSERT OR IGNORE INTO manager_view VALUES(1,'classic',NULL,0,0);`);
  }

  snapshot(): ManagerView {
    const row = this.db.query("SELECT * FROM manager_view WHERE singleton=1").get() as ManagerRow;
    if (row.view === "mono") {
      if (row.thread_id === null) throw new Error("Manager view invariant: mono requires a manager identity");
      return { view: "mono", managerThreadId: row.thread_id, hintSeen: row.hint_seen === 1 };
    }
    return { view: "classic", managerThreadId: row.thread_id, hintSeen: row.hint_seen === 1 };
  }

  update(patch: ManagerPatch): Promise<Result<ManagerView>> {
    const operation = this.queue.then(() => this.apply(patch));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async apply(patch: ManagerPatch): Promise<Result<ManagerView>> {
    if (patch.view === "mono") {
      const ready = await this.ensureThread();
      if (!ready.ok) return ready;
    }
    this.db.query("UPDATE manager_view SET view=?,hint_seen=CASE WHEN ?=1 THEN 1 ELSE hint_seen END WHERE singleton=1")
      .run(patch.view, patch.hintSeen === true ? 1 : 0);
    this.changed();
    return { ok: true, value: this.snapshot() };
  }

  private async ensureThread(): Promise<Result<Thread | null>> {
    const row = this.db.query("SELECT * FROM manager_view WHERE singleton=1").get() as ManagerRow;
    if (row.initialized === 1) return { ok: true, value: null };
    const placement = this.placement();
    if (!placement.ok) return placement;
    const id = row.thread_id ?? crypto.randomUUID();
    if (row.thread_id === null) this.db.query("UPDATE manager_view SET thread_id=? WHERE singleton=1").run(id);
    const created = await this.threads.spawn({ id, requestId: `manager-create:${id}`, title: "Kenan", cwd: placement.value.cwd,
      settings: this.settings, metadata: { ...placement.value.metadata, manager: true, foreground: true } });
    if (!created.ok) return created;
    const thread = created.value;
    if (thread.id !== id) this.db.query("UPDATE manager_view SET thread_id=? WHERE singleton=1").run(thread.id);
    const wake = await this.threads.wakeSchedule({ action: "set", threadId: thread.id, requestId: `manager-heartbeat:${thread.id}`,
      reason: "Managing Kenan heartbeat: consider the person's current needs and held questions; speak only when there is something useful to say.", cadenceMs: MANAGER_HEARTBEAT_MS });
    if (!wake.ok) return wake;
    this.db.query("UPDATE manager_view SET initialized=1 WHERE singleton=1").run();
    this.changed();
    return { ok: true, value: thread };
  }
}
