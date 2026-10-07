import type { Database } from "bun:sqlite";
import { openIndexedContext } from "./indexed-context";
import type { SourceResult } from "./source-transcripts";
import { streamedJson } from "./json-http";

export interface RawContextPage {
  source: { revision: string };
  total: number;
  records: Array<{ index: number; entryId: string; message: unknown }>;
}
export type ReadRawContext = (after: number | undefined, limit: number, revision?: string) => Promise<SourceResult<RawContextPage>>;

/** Full context export is a stream, not a prerequisite or a second transcript cache. */
export async function contextResponse(db: Database, sessionId: string, session: unknown, request: Request,
  readNative: ReadRawContext, headers: Record<string, string>): Promise<Response> {
  const unavailable = db.query("SELECT reason FROM captured_context_unavailable WHERE session_id=?").get(sessionId) as { reason: string } | null;
  if (unavailable) return Response.json({ error: unavailable.reason, code: "captured_context_unavailable" }, { status: 422, headers });
  const opened = openIndexedContext(db, sessionId);
  if (!opened.ok) return Response.json({ error: opened.error.detail, code: opened.error.code }, { status: 422, headers });
  const context = opened.value;
  const first = context ? null : await readNative(undefined, 32);
  if (first && !first.ok) return Response.json({ error: first.error.message, code: first.error.code }, { status: 422, headers });
  const hash = context?.revision ?? (first?.ok ? first.value.source.revision : "empty");
  const etag = `"${hash}"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...headers, etag } });
  const encoder = new TextEncoder();
  const prefix = JSON.stringify({ capturedAt: context?.capturedAt ?? 0 }).slice(0, -1) + ',"context":';
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield encoder.encode(prefix);
    if (context) {
      const opened = context.openByteStream();
      if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.detail}`);
      const owned = opened.value;
      try {
        while (true) {
          const read = owned.next();
          if (!read.ok) throw new Error(`${read.error.code}: ${read.error.detail}`);
          if (read.value === null) break;
          yield read.value;
        }
      } finally {
        const closed = owned.close();
        if (!closed.ok) throw new Error(`${closed.error.code}: ${closed.error.detail}`);
      }
    } else {
      yield encoder.encode('{"source":"native-history","systemPrompt":"","tools":[],"messages":[');
      let page = first!.ok ? first!.value : null;
      let comma = false;
      while (page) {
        for (const record of page.records) {
          yield encoder.encode(`${comma ? "," : ""}${JSON.stringify(record.message)}`);
          comma = true;
        }
        const last = page.records.at(-1)?.index;
        if (last === undefined || last + 1 >= page.total) break;
        const read = await readNative(last, 32, hash);
        if (!read.ok) throw new Error(`${read.error.code}: ${read.error.message}`);
        page = read.value;
      }
      yield encoder.encode("]}");
    }
    yield encoder.encode(`,"hash":${JSON.stringify(hash)},"session":${JSON.stringify(session)}}`);
  }
  const iterator = chunks();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (cause) { controller.error(cause); await iterator.return(undefined); }
    },
    async cancel() { await iterator.return(undefined); },
  });
  return streamedJson(new Response(stream, { headers: { ...headers, "content-type": "application/json", "cache-control": "no-cache", etag } }));
}
