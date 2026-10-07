import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ResourceCache } from "../shared/resource-cache";
import { openIndexedContext, type ContextMessageDescriptor, type IndexedContext } from "./indexed-context";
import type { SourceRecord, SourceResult, SourceWindow } from "./source-transcripts";
import { ensureContextSourceSchema } from "./database";

export interface ReceiptDescriptor { questionId: string; timestamp: number; entryId: string }
interface Entry { seq: number; count: number; index: number; resultIndices: number[]; restoredThinking: boolean; synthetic?: ReceiptDescriptor }
interface Layout { revision: string; generation: string; total: number; entries: Entry[] }
const good = <T>(value: T): SourceResult<T> => ({ ok: true, value });
const bad = (code: string, message: string): SourceResult<never> => ({ ok: false, error: { code, message } });

export class CapturedTranscriptSource {
  private layouts = new ResourceCache<Layout>({ entries: 32, bytes: 64 * 1024 * 1024 });
  constructor(private db: Database, private receipts: (sessionId: string) => ReceiptDescriptor[],
    private readReceipt: (sessionId: string, entryId: string) => SourceResult<any>) {
    ensureContextSourceSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS captured_transcript_generations (
      session_id TEXT PRIMARY KEY,generation TEXT NOT NULL,record_count INTEGER NOT NULL,key_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captured_context_usage (session_id TEXT PRIMARY KEY,captured_at INTEGER NOT NULL,document TEXT NOT NULL);`);
  }

  private layout(sessionId: string, context: IndexedContext): SourceResult<Layout> {
    const receipts = this.receipts(sessionId);
    if (receipts.length > 50000) return bad("oversized", "Question receipt metadata exceeds its bounded index");
    const facts = this.db.query("SELECT finalizes_message,octet_length(thinking) AS thinking FROM message_facts WHERE session_id=? AND thinking IS NOT NULL LIMIT 50001")
      .all(sessionId) as Array<{ finalizes_message: string; thinking: number }>;
    if (facts.length > 50000) return bad("oversized", "Captured thinking metadata exceeds its bounded index");
    const metadataHash = createHash("sha256");
    let metadataBytes = 0;
    for (const record of [...receipts, ...facts]) {
      const encoded = JSON.stringify(record);
      metadataBytes += Buffer.byteLength(encoded);
      if (metadataBytes > 8 * 1024 * 1024) return bad("oversized", "Captured overlays exceed the 8 MiB metadata budget");
      metadataHash.update(encoded).update("\0");
    }
    const revision = `${context.revision}:${metadataHash.digest("hex")}`;
    const cached = this.layouts.get(sessionId);
    if (cached?.revision === revision) return good(cached);
    const thinking = new Map(facts.map(fact => [fact.finalizes_message, fact.thinking > 0]));
    const entries: Entry[] = [];
    const resultIndices = new Map<string, number>();
    const calls = new Set<string>();
    const suppressed = new Set<number>();
    for (const descriptor of context.messages) {
      for (const block of descriptor.blocks) if (block.type === "toolCall" && block.id) calls.add(block.id);
      if (descriptor.role === "toolResult" && descriptor.toolCallId && calls.has(descriptor.toolCallId)) {
        resultIndices.set(descriptor.toolCallId, descriptor.index);
        suppressed.add(descriptor.index);
      }
    }
    const receiptIds = new Set(receipts.map(receipt => receipt.questionId));
    const orderedReceipts = [...receipts].sort((a, b) => a.timestamp - b.timestamp);
    const merged: Array<{ descriptor?: ContextMessageDescriptor; synthetic?: ReceiptDescriptor }> = [];
    let receiptIndex = 0;
    for (const descriptor of context.messages) {
      if (suppressed.has(descriptor.index) || descriptor.rootConsent === true && descriptor.questionId && receiptIds.has(descriptor.questionId)) continue;
      while (receiptIndex < orderedReceipts.length && orderedReceipts[receiptIndex].timestamp < (descriptor.timestamp ?? 0))
        merged.push({ synthetic: orderedReceipts[receiptIndex++] });
      merged.push({ descriptor });
    }
    while (receiptIndex < orderedReceipts.length) merged.push({ synthetic: orderedReceipts[receiptIndex++] });
    let seq = context.header.tools.length + 1;
    const keys: string[] = ["system", ...context.header.tools.map(tool => `tool:${String(tool.name)}`)];
    for (const { descriptor, synthetic } of merged) {
      const restoredThinking = Boolean(descriptor?.role === "assistant" && descriptor.contentKind === "array"
        && descriptor.finalizationKey && thinking.get(descriptor.finalizationKey)
        && (!descriptor.blocks.some(block => block.type === "thinking") || descriptor.blocks.find(block => block.type === "thinking")?.thinkingEmpty));
      const count = descriptor ? descriptor.displayItemCount + Number(restoredThinking) : 1;
      if (!count) continue;
      entries.push({ seq, count, index: descriptor?.index ?? -1, restoredThinking, resultIndices: descriptor ? descriptor.blocks
        .filter(block => block.type === "toolCall" && block.id && resultIndices.has(block.id)).map(block => resultIndices.get(block.id!)!) : [], ...(synthetic ? { synthetic } : {}) });
      keys.push(descriptor ? JSON.stringify([descriptor.role, descriptor.timestamp ?? descriptor.index, descriptor.blocks.map(block => [block.type, block.id]), count])
        : `question:${synthetic!.questionId}`);
      seq += count;
    }
    const previous = this.db.query("SELECT generation,record_count,key_hash FROM captured_transcript_generations WHERE session_id=?")
      .get(sessionId) as { generation: string; record_count: number; key_hash: string } | null;
    const hash = (limit: number) => {
      const result = createHash("sha256");
      for (let i = 0; i < limit; i++) result.update(keys[i]).update("\0");
      return result.digest("hex");
    };
    const generation = previous && keys.length >= previous.record_count && hash(previous.record_count) === previous.key_hash
      ? previous.generation : crypto.randomUUID();
    this.db.query("INSERT OR REPLACE INTO captured_transcript_generations VALUES(?,?,?,?)")
      .run(sessionId, generation, keys.length, hash(keys.length));
    const layout = { revision, generation, total: seq, entries };
    const estimate = entries.reduce((bytes, entry) => bytes + 192 + entry.resultIndices.length * 16
      + (entry.synthetic ? (entry.synthetic.entryId.length + entry.synthetic.questionId.length) * 2 : 0), revision.length * 2);
    if (estimate > 64 * 1024 * 1024) return bad("oversized", "Captured item layout exceeds the 64 MiB metadata budget");
    this.layouts.set(sessionId, layout, estimate);
    this.db.query("INSERT OR REPLACE INTO captured_context_usage VALUES(?,?,?)")
      .run(sessionId, context.capturedAt, JSON.stringify({ contextUsage: context.header.contextUsage, contextModel: context.header.contextModel }));
    return good(layout);
  }

  read(sessionId: string, before: number | undefined, limit: number): SourceResult<SourceWindow | null> {
    const unavailable = this.db.query("SELECT reason FROM captured_context_unavailable WHERE session_id=?").get(sessionId) as { reason: string } | null;
    if (unavailable) return bad("captured_context_unavailable", unavailable.reason);
    const opened = openIndexedContext(this.db, sessionId);
    if (!opened.ok) return bad(opened.error.code, opened.error.detail);
    const context = opened.value;
    if (!context) return good(null);
    const result = this.layout(sessionId, context);
    if (!result.ok) return result;
    const layout = result.value;
    const end = before === undefined ? layout.total : Math.min(before, layout.total);
    const from = Math.max(0, end - limit);
    const records: SourceRecord[] = [];
    if (from === 0 && end > 0) records.push({ seq: 0, count: 1,
      entryId: "system", message: null, results: [], header: { systemPrompt: context.header.systemPrompt, tools: [] } });
    for (let index = Math.max(0, from - 1); index < Math.min(context.header.tools.length, end - 1); index++)
      records.push({ seq: index + 1, count: 1, entryId: `tool:${index}`, message: null, results: [],
        headerItem: "tool", header: { systemPrompt: "", tools: [context.header.tools[index]] } });
    let bytes = records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record.header)), 0);
    let low = 0, high = layout.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const entry = layout.entries[middle];
      if (entry.seq + entry.count <= from) low = middle + 1; else high = middle;
    }
    for (let position = low; position < layout.entries.length; position++) {
      const entry = layout.entries[position];
      if (entry.seq >= end) break;
      const descriptor = entry.synthetic ? null : context.messages[entry.index];
      bytes += descriptor?.bytes ?? 0;
      if (bytes > 8 * 1024 * 1024) return bad("oversized", "Requested context records exceed the 8 MiB transport limit; request a smaller page");
      const source = entry.synthetic ? this.readReceipt(sessionId, entry.synthetic.entryId) : context.readMessage(entry.index);
      if (!source.ok) return bad(source.error.code, "detail" in source.error ? source.error.detail : source.error.message);
      if (entry.synthetic) bytes += Buffer.byteLength(JSON.stringify(source.value));
      const requestedCalls = new Set<string>();
      if (descriptor) {
        const firstThinking = descriptor.blocks.find(block => block.type === "thinking");
        let ordinal = entry.restoredThinking && !firstThinking ? 1 : 0;
        for (const block of descriptor.blocks) {
          const displayed = block.type !== "thinking" || block.thinkingNonempty || entry.restoredThinking && block === firstThinking;
          if (!displayed) continue;
          if (block.type === "toolCall" && block.id && entry.seq + ordinal >= from && entry.seq + ordinal < end) requestedCalls.add(block.id);
          ordinal++;
        }
      }
      const results: any[] = [];
      for (const index of entry.resultIndices) {
        const result = context.messages[index];
        if (!result.toolCallId || !requestedCalls.has(result.toolCallId)) continue;
        bytes += result.bytes;
        if (bytes > 8 * 1024 * 1024) return bad("oversized", "Requested context records exceed the 8 MiB transport limit; request a smaller page");
        const read = context.readMessage(index);
        if (!read.ok) return bad(read.error.code, read.error.detail);
        results.push(read.value);
      }
      if (bytes > 8 * 1024 * 1024) return bad("oversized", "Requested context records exceed the 8 MiB transport limit; request a smaller page");
      records.push({ seq: entry.seq, count: entry.count, entryId: entry.synthetic?.entryId ?? `context:${entry.index}`, message: source.value, results });
    }
    return good({ source: { revision: layout.revision, generation: layout.generation, context: "captured-model-context" }, total: layout.total, records });
  }
}
