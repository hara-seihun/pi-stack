import type { Database } from "bun:sqlite";
import { applyContextSplice, restoreContextSplices, type ContextSplice } from "./sync";

export interface StoredContext { capturedAt: number; document: string; hash: string }

export function readContext(db: Database, sessionId: string): StoredContext | null {
  const base = db.query("SELECT captured_at,context FROM session_contexts WHERE session_id=?").get(sessionId) as { captured_at: number; context: string } | null;
  if (!base) return null;
  const rows = db.query("SELECT * FROM session_context_patches WHERE session_id=? ORDER BY seq").all(sessionId) as any[];
  const restored = restoreContextSplices(base.context, rows.map((row) => ({
    baseHash: row.base_hash, targetHash: row.target_hash,
    prefixBytes: row.prefix_bytes, deleteBytes: row.delete_bytes, insertBase64: row.insert_base64,
  })));
  if (!restored.ok) throw new Error(`Stored context is corrupt for ${sessionId}: ${restored.error}`);
  return { capturedAt: rows.reduce((time, row) => Math.max(time, row.captured_at), base.captured_at), document: restored.document, hash: restored.hash };
}

export function appendContextPatch(db: Database, sessionId: string, current: StoredContext, capturedAt: number, splice: ContextSplice):
  { ok: true; value: StoredContext } | { ok: false; error: string } {
  try {
    const document = applyContextSplice(current.document, splice);
    db.transaction(() => {
      const pending = db.query("SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(insert_base64)),0) AS bytes FROM session_context_patches WHERE session_id=?")
        .get(sessionId) as { count: number; bytes: number };
      // A cold read must not replay an entire turn's growing image document.
      const maximumBytes = Math.min(1024 * 1024, Buffer.byteLength(document) / 4);
      if (pending.count + 1 >= 32 || pending.bytes + splice.insertBase64.length >= maximumBytes) {
        db.query("UPDATE session_contexts SET captured_at=?,context=? WHERE session_id=?").run(capturedAt, document, sessionId);
        db.query("DELETE FROM session_context_patches WHERE session_id=?").run(sessionId);
      } else {
        db.query(`INSERT INTO session_context_patches(session_id,captured_at,base_hash,target_hash,prefix_bytes,delete_bytes,insert_base64)
          VALUES(?,?,?,?,?,?,?)`).run(sessionId, capturedAt, splice.baseHash, splice.targetHash, splice.prefixBytes, splice.deleteBytes, splice.insertBase64);
      }
    })();
    return { ok: true, value: { capturedAt, document, hash: splice.targetHash } };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
