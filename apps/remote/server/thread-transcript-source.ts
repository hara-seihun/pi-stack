import type { Database } from "bun:sqlite";
import type { ThreadApi } from "pi-orchestrator/api";
import { displayContextMessage, type ContextImage } from "./context-display";
import { withToolProgress, type ToolProgress } from "./tool-progress";
import { isResponseMetrics } from "./response-metrics";
import { messageFinalizationKey } from "./sync";
import type { SourceResult, SourceWindow } from "./source-transcripts";
import { readRoomInput } from "../shared/rooms";
import { messageReference } from "./message-protocol";

export class ThreadTranscriptSource {
  constructor(private db: Database, private inspect: ThreadApi["inspect"],
    private progress: (sessionId: string) => Map<string, ToolProgress> | undefined,
    private reactions: (identity: string) => unknown[]) {}

  read = async (sessionId: string, before: number | undefined, limit: number): Promise<SourceResult<SourceWindow>> => {
    const progress = this.progress(sessionId);
    if (progress && progress.size > 64) return { ok: false, error: { code: "oversized", message: "Live tool metadata exceeds the 64-call window budget" } };
    const inspected = await this.inspect(sessionId, { contextWindow: { ...(before === undefined ? {} : { before }), limit,
      ...(progress?.size ? { toolCallIds: [...progress.keys()] } : {}) } });
    if (!inspected.ok) return inspected;
    const source = inspected.value.contextWindow;
    if (!source) return { ok: false, error: { code: "invalid_source", message: "The thread owner did not return native history" } };
    const known = new Set(source.knownToolCallIds);
    for (const id of source.completedToolCallIds ?? []) progress?.delete(id);
    const window: SourceWindow = { ...source, records: source.records.map(record => record.seq === 0 && record.entryId === "system"
      ? { ...record, header: { systemPrompt: "", tools: [] } } : record) };
    for (const record of window.records) {
      const message = record.message;
      if (message?.role !== "user" || message.identity) continue;
      const text = typeof message.content === "string" ? message.content : (Array.isArray(message.content) ? message.content : [])
        .filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
      const input = readRoomInput(text);
      if (input) record.message = { ...message, identity: {
        id: messageReference({ transport: "pi", sessionId, messageId: record.entryId }),
        timestamp: message.timestamp, sender: { id: input.sender.user, name: input.sender.displayName },
      } };
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
        window.records.push({ seq, count: 1, entryId: `live:${tool.id}`, message: overlaid[0], results: overlaid.slice(1),
          ...(window.monoLiveVisibility !== undefined ? { monoVisibility: window.monoLiveVisibility } : {}) });
      }
    }
    return { ok: true, value: window };
  };

  project = (sessionId: string, message: any, image: (image: ContextImage) => string): any => {
    const finalization = message?.role === "assistant" ? message.__remoteSourceKey ?? messageFinalizationKey(message) : "";
    const facts = finalization ? this.db.query("SELECT metrics FROM message_facts WHERE session_id=? AND finalizes_message=?")
      .get(sessionId, finalization) as { metrics: string | null } | null : null;
    const metrics = facts?.metrics ? JSON.parse(facts.metrics) : undefined;
    if (metrics !== undefined && !isResponseMetrics(metrics)) throw new Error("invalid_record: Invalid response metrics");
    const projected: any = displayContextMessage(message, image, metrics);
    return projected?.identity ? { ...projected, reactions: this.reactions(projected.identity.id) } : projected;
  };
}
