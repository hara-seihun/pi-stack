import type { Database } from "bun:sqlite";
import type { CoreExecutionSnapshot } from "pi-orchestrator/api";

export type ExecutionOwner = Readonly<{ sessionId: string; generation: string; instance: string }>;
export type ObservationResult =
  | { ok: true; changed: boolean; completed: string[]; inserted: string[] }
  | { ok: false; error: "stale-owner" | "stale-observation" };

export class ExecutionController {
  constructor(private readonly db: Database, private readonly confirmInserted: (sessionId: string, workId: string) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS execution_observations (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      generation TEXT NOT NULL, instance TEXT NOT NULL, revision INTEGER NOT NULL,
      snapshot TEXT
    );`);
  }

  attach(owner: ExecutionOwner): void {
    this.db.query(`INSERT INTO execution_observations VALUES(?,?,?,-1,NULL)
      ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,
      instance=excluded.instance,revision=-1,snapshot=NULL`)
      .run(owner.sessionId, owner.generation, owner.instance);
  }

  observe(owner: ExecutionOwner, snapshot: CoreExecutionSnapshot): ObservationResult {
    return this.db.transaction((): ObservationResult => {
      const current = this.db.query("SELECT generation,instance,revision,snapshot FROM execution_observations WHERE session_id=?")
        .get(owner.sessionId) as { generation: string; instance: string; revision: number; snapshot: string | null } | null;
      if (!current || current.generation !== owner.generation || current.instance !== owner.instance) return { ok: false, error: "stale-owner" };
      if (snapshot.revision < current.revision) return { ok: false, error: "stale-observation" };
      const encoded = JSON.stringify(snapshot);
      if (snapshot.revision === current.revision) {
        if (encoded !== current.snapshot) throw new Error("Core published different execution snapshots at the same revision");
      }
      const completed: string[] = [], inserted: string[] = [];
      const time = new Date().toISOString();
      for (const operation of snapshot.operations) {
        const work = this.db.query(`SELECT w.state,w.inserted_at,d.state_dir FROM work_items w
          JOIN core_dispatches d ON d.work_id=w.id WHERE w.id=? AND w.session_id=?`)
          .get(operation.workId, owner.sessionId) as { state: string; inserted_at: string | null; state_dir: string } | null;
        if (!work || !["running", "dispatched"].includes(work.state)) continue;
        const selected = this.db.query("SELECT state_dir FROM session_cores WHERE session_id=?").get(owner.sessionId) as { state_dir: string };
        if (work.state_dir !== selected.state_dir) continue;
        if (["accepted", "running", "succeeded"].includes(operation.state) && !work.inserted_at) {
          this.confirmInserted(owner.sessionId, operation.workId);
          inserted.push(operation.workId);
        }
        if (["succeeded", "failed", "cancelled"].includes(operation.state)) {
          this.db.query("UPDATE work_items SET state=?,updated_at=?,last_error=? WHERE id=?")
            .run(operation.state === "cancelled" ? "cancelled" : "complete", time,
              operation.state === "succeeded" ? null : operation.error ?? `Core operation ${operation.state}`, operation.workId);
          completed.push(operation.workId);
        } else if (operation.state === "unknown") {
          this.db.query("UPDATE work_items SET last_error=?,updated_at=? WHERE id=?")
            .run(operation.error ?? "Core dispatch outcome is unknown; reconciliation required", time, operation.workId);
        }
      }
      const changed = snapshot.revision !== current.revision || completed.length > 0 || inserted.length > 0;
      if (changed) {
        this.db.query("UPDATE execution_observations SET revision=?,snapshot=? WHERE session_id=?")
          .run(snapshot.revision, encoded, owner.sessionId);
        this.db.query("UPDATE sessions SET revision=revision+1,updated_at=? WHERE id=?").run(time, owner.sessionId);
      }
      return { ok: true, changed, completed, inserted };
    })();
  }
}

export class SessionCommands {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();

  busy(id: string): boolean { return this.active.has(id); }

  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(id, barrier);
    await previous;
    this.active.add(id);
    try { return await action(); }
    finally {
      this.active.delete(id);
      release();
      if (this.tails.get(id) === barrier) this.tails.delete(id);
    }
  }
}
