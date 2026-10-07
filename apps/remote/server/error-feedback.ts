import type { Database } from "bun:sqlite";

export interface ErrorFeedback { id: string; message: string }

export function observeError(db: Database, source: string, message: string | null | undefined, occurrence = ""): ErrorFeedback | null {
  if (!message) {
    db.query("DELETE FROM error_feedback WHERE source=?").run(source);
    return null;
  }
  const current = db.query("SELECT * FROM error_feedback WHERE source=?").get(source) as (ErrorFeedback & { occurrence: string; dismissed_at: number | null }) | null;
  if (current?.message === message && current.occurrence === occurrence) return current.dismissed_at === null ? { id: current.id, message } : null;
  const id = crypto.randomUUID();
  db.query(`INSERT INTO error_feedback(source,id,message,occurrence) VALUES(?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET id=excluded.id,message=excluded.message,occurrence=excluded.occurrence,dismissed_at=NULL`)
    .run(source, id, message, occurrence);
  return { id, message };
}

export type Failure = {
  message: string;
  impact: string;
} & ({ recovery: "automatic"; attentionAfterMs?: number; action?: string }
  | { recovery: "required"; action: string });

export function observeFailure(db: Database, source: string, failure: Failure | null, occurrence = "", now = Date.now()): ErrorFeedback | null {
  if (!failure) {
    db.query("UPDATE error_diagnostics SET resolved_at=? WHERE source=? AND resolved_at IS NULL").run(now, source);
    return observeError(db, source, null);
  }
  const current = db.query("SELECT first_seen,resolved_at FROM error_diagnostics WHERE source=?").get(source) as {
    first_seen: number; resolved_at: number | null;
  } | null;
  const firstSeen = current?.resolved_at === null ? current.first_seen : now;
  db.query(`INSERT INTO error_diagnostics(source,message,occurrence,recovery,first_seen,last_seen,resolved_at) VALUES(?,?,?,?,?,?,NULL)
    ON CONFLICT(source) DO UPDATE SET message=excluded.message,occurrence=excluded.occurrence,recovery=excluded.recovery,
      first_seen=excluded.first_seen,last_seen=excluded.last_seen,resolved_at=NULL`)
    .run(source, failure.message, occurrence, failure.recovery, firstSeen, now);
  const needsAttention = failure.recovery === "required"
    || failure.attentionAfterMs !== undefined && now - firstSeen >= failure.attentionAfterMs;
  const message = needsAttention ? [failure.impact, failure.action].filter(Boolean).join(" ") : null;
  return observeError(db, source, message, String(firstSeen));
}

export function dismissError(db: Database, id: string): boolean {
  return db.query("UPDATE error_feedback SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL").run(Date.now(), id).changes > 0;
}
