import type { Store } from "./store.js";
import type { RunActivity } from "./domain.js";

type Progress = { progress?: boolean; activity?: RunActivity; text?: string; thinking?: string; tool?: string };
export class Heartbeats {
  private pending = new Map<string, Progress>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly store: Store) {}
  accept(id: string, input: Progress): boolean {
    if (!this.store.db.prepare("SELECT 1 FROM run WHERE id=?").get(id)) return false;
    this.pending.set(id, { ...input, progress: input.progress || this.pending.get(id)?.progress });
    this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 100);
    return true;
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.size) return;
    this.store.transaction(() => {
      for (const [id, input] of this.pending) {
        const row = this.store.db.prepare("SELECT state FROM run WHERE id=?").get(id) as { state: string } | undefined;
        if (!row || !["starting", "running"].includes(row.state)) continue;
        const now = Date.now();
        this.store.heartbeatLease(`run:${id}`, now);
        this.store.db.prepare("UPDATE run SET progress_at=CASE WHEN ? THEN ? ELSE progress_at END,updated_at=? WHERE id=?").run(input.progress ? 1 : 0, now, now, id);
        if (input.activity) this.store.setLive(id, { ...input, activity: input.activity }, now);
      }
    });
    this.pending.clear();
  }
}
