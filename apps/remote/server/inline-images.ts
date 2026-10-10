import type { Database } from "bun:sqlite";
import type { InlineImage, InlineImageSnapshot } from "./inline-image-contract";

export type InlineImagesClientResult<T> = { ok: true; value: T } | { ok: false; error: { code: "storage" | "unavailable" | "rejected" | "conflict"; message: string } };
export type InlineImagesCoreConfig = { url: string; scopeId: string };
type Pending = { thread_id: string; message_key: string; text: string };
const failure = (code: "storage" | "unavailable" | "rejected" | "conflict", message: string): Extract<InlineImagesClientResult<never>, { ok: false }> => ({ ok: false, error: { code, message } });

export class InlineImages {
  private snapshots = new Map<string, InlineImageSnapshot>();
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<InlineImagesClientResult<void>> | null = null;
  private abort = new AbortController();
  private base: string;
  constructor(private db: Database, private config: InlineImagesCoreConfig, private changed: () => void,
    private feedback: (message: string | null) => void, private transport: typeof fetch) {
    this.base = `${config.url}/v1/scopes/${encodeURIComponent(config.scopeId)}/images`;
    db.exec("CREATE TABLE IF NOT EXISTS core_image_outbox(thread_id TEXT NOT NULL REFERENCES thread_views(id) ON DELETE CASCADE,message_key TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','rejected')),error TEXT,PRIMARY KEY(thread_id,message_key));");
    const seedTables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('inline_image_versions','inline_images')").all();
    const versions = seedTables.length === 2 ? db.query("SELECT session_id,version FROM inline_image_versions").all() as { session_id: string; version: number }[] : [];
    for (const row of versions) {
      const images = (db.query("SELECT value FROM inline_images WHERE session_id=? ORDER BY rowid").all(row.session_id) as { value: string }[]).map(row => JSON.parse(row.value) as InlineImage);
      this.snapshots.set(row.session_id, { version: row.version, images });
    }
  }
  version(threadId: string): number { return this.snapshots.get(threadId)?.version ?? 0; }
  snapshot(threadId: string): InlineImageSnapshot { return this.snapshots.get(threadId) ?? { version: 0, images: [] }; }

  accept(threadId: string, messageKey: string, text: string): InlineImagesClientResult<void> {
    if (!text.includes("<pi-remote-image")) return { ok: true, value: undefined };
    try {
      const previous = this.db.query("SELECT text FROM core_image_outbox WHERE thread_id=? AND message_key=?").get(threadId, messageKey) as { text: string } | null;
      if (previous && previous.text !== text) {
        const result = failure("conflict", "Image message identity belongs to different text"); this.feedback(result.error.message); return result;
      }
      this.db.query("INSERT OR IGNORE INTO core_image_outbox VALUES(?,?,?,'pending',NULL)").run(threadId, messageKey, text);
      if (!this.stopped) void this.flush().then(result => { if (!result.ok) this.feedback(result.error.message); });
      return { ok: true, value: undefined };
    } catch (cause) {
      const result = failure("storage", `Image message could not enter durable core transport custody: ${String(cause)}`);
      this.feedback(result.error.message); return result;
    }
  }

  private async request<T>(suffix: string, body: unknown): Promise<InlineImagesClientResult<T>> {
    try {
      const response = await this.transport(`${this.base}/${suffix}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) return failure(response.status === 409 ? "conflict" : response.status >= 500 ? "unavailable" : "rejected", String(result?.error?.message ?? `Core image service returned HTTP ${response.status}`));
      return { ok: true, value: result.value as T };
    } catch (cause) { return failure("unavailable", `Core image outcome unconfirmed; the same durable message will be recovered: ${String(cause)}`); }
  }
  private remember(threadId: string, snapshot: InlineImageSnapshot): InlineImagesClientResult<void> {
    if (!snapshot || !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 || !Array.isArray(snapshot.images)) return failure("unavailable", "Core returned an invalid image snapshot");
    if (snapshot.version === 0 || snapshot.version >= this.version(threadId)) this.snapshots.set(threadId, snapshot);
    return { ok: true, value: undefined };
  }
  flush(): Promise<InlineImagesClientResult<void>> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve(failure("unavailable", "Core image projection is stopped"));
    this.pending = (async (): Promise<InlineImagesClientResult<void>> => {
      try {
        const rows = this.db.query("SELECT thread_id,message_key,text FROM core_image_outbox WHERE state='pending' ORDER BY rowid").all() as Pending[];
        for (const row of rows) {
          if (this.stopped) return failure("unavailable", "Core image projection stopped during delivery");
          const accepted = await this.request<InlineImageSnapshot>("accept", { threadId: row.thread_id, messageKey: row.message_key, text: row.text });
          if (!accepted.ok) {
            this.db.query("UPDATE core_image_outbox SET state=?,error=? WHERE thread_id=? AND message_key=?").run(accepted.error.code === "unavailable" ? "pending" : "rejected", accepted.error.message, row.thread_id, row.message_key);
            return accepted;
          }
          const remembered = this.remember(row.thread_id, accepted.value);
          if (!remembered.ok) return remembered;
          this.db.query("DELETE FROM core_image_outbox WHERE thread_id=? AND message_key=?").run(row.thread_id, row.message_key);
          this.changed();
        }
        const synced = await this.request<{ snapshots: Record<string, InlineImageSnapshot>; errors: string[] }>("sync", { have: Object.fromEntries([...this.snapshots].map(([id, snapshot]) => [id, snapshot.version])) });
        if (!synced.ok) return synced;
        if (!synced.value || !synced.value.snapshots || typeof synced.value.snapshots !== "object" || Array.isArray(synced.value.snapshots)
          || !Array.isArray(synced.value.errors) || synced.value.errors.some(error => typeof error !== "string")) return failure("unavailable", "Core returned invalid image reconciliation");
        for (const [id, snapshot] of Object.entries(synced.value.snapshots)) { const result = this.remember(id, snapshot); if (!result.ok) return result; }
        if (Object.keys(synced.value.snapshots).length) this.changed();
        const rejected = this.db.query("SELECT error FROM core_image_outbox WHERE state='rejected' LIMIT 1").get() as { error: string } | null;
        const message = rejected?.error ?? (synced.value.errors.length ? synced.value.errors.join("; ") : null);
        this.feedback(message);
        return message ? failure("rejected", message) : { ok: true, value: undefined };
      } catch (cause) { return failure("storage", `Core image outbox reconciliation failed: ${String(cause)}`); }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  async start(): Promise<InlineImagesClientResult<void>> {
    this.stopped = false;
    this.abort = new AbortController();
    const result = await this.flush();
    if (!result.ok) this.feedback(result.error.message);
    this.schedule();
    return result;
  }
  private schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const result = await this.flush();
      if (!result.ok && !this.stopped) this.feedback(result.error.message);
      this.schedule();
    }, 2_000);
    this.timer.unref();
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.abort.abort(); }
  async close(): Promise<void> { this.stop(); await this.pending; }
}
