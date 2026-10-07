import type { Database } from "bun:sqlite";
import type { TranscriptItemHead } from "./protocol";
import { deriveTranscriptItems, INLINE_BODY_LIMIT, PREVIEW_CHARACTERS, type DerivedItem, type ResolveAgentName } from "./transcript-items";
import type { ContextImage } from "./context-display";
import { sha256 } from "./sync";

export type SourceError = { code: string; message: string };
export type SourceResult<T> = { ok: true; value: T } | { ok: false; error: SourceError };
export interface SourceRecord {
  seq: number;
  count: number;
  entryId: string;
  message: any;
  results: any[];
  header?: { systemPrompt: string; tools: any[] };
  headerItem?: "tool";
}
export interface SourceWindow {
  source: { revision: string; generation: string; context: string };
  total: number;
  records: SourceRecord[];
}
export type ReadSourceWindow = (sessionId: string, before: number | undefined, limit: number) => Promise<SourceResult<SourceWindow>>;
export type ProjectSourceMessage = (sessionId: string, message: any, image: (image: ContextImage) => string) => any;
export interface SourcePage {
  sessionId: string;
  generation: string;
  total: number;
  items: TranscriptItemHead[];
}
const good = <T>(value: T): SourceResult<T> => ({ ok: true, value });
const bad = (code: string, message: string): SourceResult<never> => ({ ok: false, error: { code, message } });

/** Only source locators persist. A page, body, or image reads its own native records. */
export class SourceTranscripts {
  constructor(private db: Database, private read: ReadSourceWindow, private project: ProjectSourceMessage,
    private imageUrl: (sessionId: string, hash: string) => string, private resolveAgentName?: ResolveAgentName) {
    db.exec(`DROP TABLE IF EXISTS transcript_items; DROP TABLE IF EXISTS transcript_generations;
      CREATE TABLE IF NOT EXISTS transcript_locators (
        session_id TEXT NOT NULL, item_id TEXT NOT NULL, generation TEXT NOT NULL, seq INTEGER NOT NULL,
        PRIMARY KEY(session_id,item_id));
      CREATE TABLE IF NOT EXISTS transcript_image_locators (
        session_id TEXT NOT NULL, image_hash TEXT NOT NULL, generation TEXT NOT NULL, seq INTEGER NOT NULL,
        PRIMARY KEY(session_id,image_hash));`);
  }

  private derive(sessionId: string, window: SourceWindow, record: SourceRecord, from: number, end: number): DerivedItem[] {
    const images = new Map<string, string>();
    const image = (value: ContextImage) => {
      const hash = sha256(`${value.mimeType}\0${value.data}`);
      const url = this.imageUrl(sessionId, hash);
      images.set(hash, JSON.stringify(url).slice(1, -1));
      return url;
    };
    const context = record.header ?? { systemPrompt: "", tools: [] };
    const items = deriveTranscriptItems({ ...context, messages: record.header ? [] : [record.message, ...record.results]
      .map(message => this.project(sessionId, message, image)) }, this.resolveAgentName);
    const selected = record.header && record.headerItem !== "tool" ? items : items.slice(1);
    if (selected.length !== record.count) throw new Error(`Source item count mismatch for ${record.entryId}: ${record.count} != ${selected.length}`);
    for (const [index, item] of selected.entries()) {
      item.head.seq = record.seq + index;
      // User and assistant heads used to transport whole message text, defeating lazy bodies.
      if ((item.head.kind === "user" || item.head.kind === "assistant" || item.head.kind === "notice") && item.head.text.length > INLINE_BODY_LIMIT) {
        item.head.text = `${item.head.text.slice(0, PREVIEW_CHARACTERS)}…`;
        item.head.textTruncated = true;
      }
      if (item.head.seq < from || item.head.seq >= end) continue;
      this.db.query(`INSERT OR REPLACE INTO transcript_locators VALUES(?,?,?,?)`)
        .run(sessionId, item.head.id, window.source.generation, item.head.seq);
      for (const [hash, encodedUrl] of images) if (item.body.includes(encodedUrl)) {
        this.db.query(`INSERT OR REPLACE INTO transcript_image_locators VALUES(?,?,?,?)`)
          .run(sessionId, hash, window.source.generation, item.head.seq);
      }
    }
    return selected;
  }

  async page(sessionId: string, before: number | undefined, limit: number, generation?: string): Promise<SourceResult<SourcePage>> {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 600)
      return bad("invalid_request", "Invalid transcript window");
    const loaded = await this.read(sessionId, before, limit);
    if (!loaded.ok) return loaded;
    const window = loaded.value;
    if (generation && generation !== window.source.generation) return bad("stale_source", "The transcript generation has been replaced");
    try {
      const end = before === undefined ? window.total : Math.min(before, window.total);
      const from = Math.max(0, end - limit);
      const items: TranscriptItemHead[] = [];
      for (const record of window.records) {
        for (const item of this.derive(sessionId, window, record, from, end)) {
          if (item.head.seq < from || item.head.seq >= end) continue;
          const head = item.head;
          items.push(before === undefined && head.seq === window.total - 1 && head.size <= INLINE_BODY_LIMIT
            ? { ...head, body: JSON.parse(item.body) } as TranscriptItemHead : head);
        }
      }
      this.db.query("DELETE FROM transcript_locators WHERE session_id=? AND generation!=?").run(sessionId, window.source.generation);
      this.db.query("DELETE FROM transcript_image_locators WHERE session_id=? AND generation!=?").run(sessionId, window.source.generation);
      return good({ sessionId, generation: window.source.generation, total: window.total, items });
    } catch (cause) { return bad("invalid_record", cause instanceof Error ? cause.message : String(cause)); }
  }

  async body(sessionId: string, itemId: string): Promise<SourceResult<string | undefined>> {
    const locator = this.db.query("SELECT generation,seq FROM transcript_locators WHERE session_id=? AND item_id=?")
      .get(sessionId, itemId) as { generation: string; seq: number } | null;
    if (!locator) return good(undefined);
    const loaded = await this.read(sessionId, locator.seq + 1, 1);
    if (!loaded.ok) return loaded;
    if (loaded.value.source.generation !== locator.generation) return bad("stale_source", "The transcript generation has been replaced");
    try {
      for (const record of loaded.value.records) {
        const item = this.derive(sessionId, loaded.value, record, locator.seq, locator.seq + 1).find(item => item.head.id === itemId);
        if (item) return good(item.body);
      }
      return good(undefined);
    } catch (cause) { return bad("invalid_record", cause instanceof Error ? cause.message : String(cause)); }
  }

  async image(sessionId: string, hash: string): Promise<SourceResult<ContextImage | undefined>> {
    const locator = this.db.query("SELECT generation,seq FROM transcript_image_locators WHERE session_id=? AND image_hash=?")
      .get(sessionId, hash) as { generation: string; seq: number } | null;
    if (!locator) return good(undefined);
    const loaded = await this.read(sessionId, locator.seq + 1, 1);
    if (!loaded.ok) return loaded;
    if (loaded.value.source.generation !== locator.generation) return bad("stale_source", "The transcript generation has been replaced");
    for (const record of loaded.value.records) for (const message of [record.message, ...record.results]) {
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
        && sha256(`${block.mimeType}\0${block.data}`) === hash) return good({ data: block.data, mimeType: block.mimeType });
    }
    return good(undefined);
  }

  forget(sessionId: string): void {
    this.db.query("DELETE FROM transcript_locators WHERE session_id=?").run(sessionId);
    this.db.query("DELETE FROM transcript_image_locators WHERE session_id=?").run(sessionId);
  }
}
