import type { SourceResult } from "./source-transcripts";
import { streamedJson } from "./json-http";

export interface RawContextPage {
  source: { revision: string; [key: string]: unknown };
  total: number;
  records: Array<{ index: number; entryId: string; message: unknown; entry?: unknown }>;
}
export type ReadRawContext = (after: number | undefined, limit: number, revision?: string) => Promise<SourceResult<RawContextPage>>;

/** Export native entries with exact identities, bodies and non-message events in bounded pages. */
export async function contextResponse(session: unknown, request: Request,
  readNative: ReadRawContext, headers: Record<string, string>): Promise<Response> {
  const first = await readNative(undefined, 32);
  if (!first.ok) return Response.json({ error: first.error.message, code: first.error.code }, { status: 422, headers });
  if (first.value.records.some(record => !record.entry))
    return Response.json({ code: "invalid_source", error: "Native export entry is missing" }, { status: 422, headers });
  const revision = first.value.source.revision;
  const etag = `"${revision}"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...headers, etag } });
  const encoder = new TextEncoder();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield encoder.encode(`{"source":${JSON.stringify(first.ok && first.value.source)},"entries":[`);
    let page = first.ok ? first.value : null;
    let comma = false;
    while (page) {
      for (const record of page.records) {
        if (!record.entry) throw new Error(`invalid_source: Native entry ${record.entryId} is missing`);
        yield encoder.encode(`${comma ? "," : ""}${JSON.stringify(record.entry)}`);
        comma = true;
      }
      const last = page.records.at(-1)?.index;
      if (last === undefined || last + 1 >= page.total) break;
      const read = await readNative(last, 32, revision);
      if (!read.ok) throw new Error(`${read.error.code}: ${read.error.message}`);
      page = read.value;
    }
    yield encoder.encode(`],"hash":${JSON.stringify(revision)},"session":${JSON.stringify(session)}}`);
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
