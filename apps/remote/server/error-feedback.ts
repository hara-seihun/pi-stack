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

export function dismissError(db: Database, id: string): boolean {
  return db.query("UPDATE error_feedback SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL").run(Date.now(), id).changes > 0;
}
