import type { Database } from "bun:sqlite";
import type { ThreadApi } from "pi-orchestrator/api";
import { CapturedTranscriptSource } from "./captured-transcript-source";
import { openIndexedContext } from "./indexed-context";
import { displayContextMessage, type ContextImage } from "./context-display";
import { withToolProgress, type ToolProgress } from "./tool-progress";
import { isResponseMetrics } from "./response-metrics";
import { messageFinalizationKey } from "./sync";
import type { SourceResult, SourceWindow } from "./source-transcripts";

export class ThreadTranscriptSource {
  constructor(private db: Database, private captured: CapturedTranscriptSource, private inspect: ThreadApi["inspect"],
    private progress: (sessionId: string) => Map<string, ToolProgress> | undefined,
    private reactions: (identity: string) => unknown[]) {}

  read = async (sessionId: string, before: number | undefined, limit: number): Promise<SourceResult<SourceWindow>> => {
    const progress = this.progress(sessionId);
    if (progress && progress.size > 64) return { ok: false, error: { code: "oversized", message: "Live tool metadata exceeds the 64-call window budget" } };
    const captured = this.captured.read(sessionId, before, limit);
    if (!captured.ok) return captured;
    let window: SourceWindow;
    const known = new Set<string>();
    if (captured.value) {
      window = captured.value;
      if (progress?.size) {
        const indexed = openIndexedContext(this.db, sessionId);
        if (!indexed.ok) return { ok: false, error: { code: indexed.error.code, message: indexed.error.detail } };
        if (!indexed.value) return { ok: false, error: { code: "stale_source", message: "The captured source disappeared" } };
        for (const descriptor of indexed.value.messages) {
          if (descriptor.role === "toolResult" && descriptor.toolCallId) progress.delete(descriptor.toolCallId);
          for (const block of descriptor.blocks) if (block.type === "toolCall" && block.id && progress.has(block.id)) known.add(block.id);
        }
      }
    } else {
      const inspected = await this.inspect(sessionId, { contextWindow: { ...(before === undefined ? {} : { before }), limit,
        ...(progress?.size ? { toolCallIds: [...progress.keys()] } : {}) } });
      if (!inspected.ok) return inspected;
      const source = inspected.value.contextWindow;
      if (!source) return { ok: false, error: { code: "invalid_source", message: "The thread owner did not return a source window" } };
      for (const id of source.knownToolCallIds) known.add(id);
      window = { ...source, records: source.records.map(record => record.seq === 0 && record.entryId === "system"
        ? { ...record, header: { systemPrompt: "", tools: [] } } : record) };
    }
    if (progress?.size) {
      for (const record of window.records) {
        for (const result of record.results) if (result.role === "toolResult") progress.delete(result.toolCallId);
        if (record.message?.role === "toolResult") progress.delete(record.message.toolCallId);
        const ids = new Set((Array.isArray(record.message?.content) ? record.message.content : []).filter((block: any) => block.type === "toolCall").map((block: any) => block.id));
        if (record.message?.role === "assistant") record.message = { ...record.message, __remoteSourceKey: messageFinalizationKey(record.message) };
        const overlaid = withToolProgress([record.message, ...record.results], [...progress.values()].filter(tool => ids.has(tool.id)));
        record.message = overlaid[0];
        record.results = overlaid.slice(1);
      }
      for (const tool of progress.values()) {
        if (known.has(tool.id)) continue;
        const seq = window.total++;
        const end = before === undefined ? window.total : before;
        if (seq >= end || seq < Math.max(0, end - limit)) continue;
        const overlaid = withToolProgress([], [tool]);
        if (Buffer.byteLength(JSON.stringify(overlaid)) > 4 * 1024 * 1024)
          return { ok: false, error: { code: "oversized", message: "A live tool record exceeds the 4 MiB budget" } };
        window.records.push({ seq, count: 1, entryId: `live:${tool.id}`, message: overlaid[0], results: overlaid.slice(1) });
      }
    }
    return { ok: true, value: window };
  };

  project = (sessionId: string, message: any, image: (image: ContextImage) => string): any => {
    const finalization = message?.role === "assistant" ? message.__remoteSourceKey ?? messageFinalizationKey(message) : "";
    const sizes = finalization ? this.db.query("SELECT octet_length(thinking) AS bytes FROM message_facts WHERE session_id=? AND finalizes_message=?")
      .get(sessionId, finalization) as { bytes: number } | null : null;
    if (sizes && sizes.bytes > 4 * 1024 * 1024) throw new Error("oversized: Streamed thinking exceeds the 4 MiB record budget");
    const facts = finalization ? this.db.query("SELECT thinking,metrics FROM message_facts WHERE session_id=? AND finalizes_message=?")
      .get(sessionId, finalization) as { thinking: string | null; metrics: string | null } | null : null;
    const metrics = facts?.metrics ? JSON.parse(facts.metrics) : undefined;
    if (metrics !== undefined && !isResponseMetrics(metrics)) throw new Error("invalid_record: Invalid response metrics");
    const projected: any = displayContextMessage(message, facts?.thinking ?? undefined, image, metrics);
    return projected?.identity ? { ...projected, reactions: this.reactions(projected.identity.id) } : projected;
  };
}
