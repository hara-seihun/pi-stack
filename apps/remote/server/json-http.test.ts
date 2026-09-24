import { expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { jsonHttp } from "./json-http";

const url = "http://localhost/v1/messaging/conversations/one/messages";
const body = { messages: Array.from({ length: 80 }, (_, i) => ({ id: i, text: "A conversation message ".repeat(10) })) };

test("compresses JSON with negotiated encoding and revalidates mutable GETs", async () => {
  const response = () => Response.json(body, { headers: { "cache-control": "no-store" } });
  const br = await jsonHttp(new Request(url, { headers: { "accept-encoding": "br, gzip" } }), response());
  expect(br?.headers.get("content-encoding")).toBe("br");
  expect(br?.headers.get("cache-control")).toBe("private, no-cache");
  expect(JSON.parse(brotliDecompressSync(Buffer.from(await br!.arrayBuffer())).toString())).toEqual(body);
  const etag = br!.headers.get("etag")!;
  const gzip = await jsonHttp(new Request(url, { headers: { "accept-encoding": "br;q=0, gzip" } }), response());
  expect(gzip?.headers.get("content-encoding")).toBe("gzip");
  expect(JSON.parse(gunzipSync(Buffer.from(await gzip!.arrayBuffer())).toString())).toEqual(body);
  const cached = await jsonHttp(new Request(url, { headers: { "if-none-match": etag } }), response());
  expect(cached?.status).toBe(304);
  expect(cached?.headers.get("etag")).toBe(etag);
  expect(cached?.headers.get("vary")).toContain("Accept-Encoding");
});

test("previews have a bounded max-age; streams and pre-encoded responses remain untouched", async () => {
  const preview = await jsonHttp(new Request("http://localhost/v1/messaging/messages/one/link-previews"), Response.json({ previews: [] }));
  expect(preview?.headers.get("cache-control")).toBe("private, max-age=300");
  const stream = new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } });
  expect(await jsonHttp(new Request(url), stream)).toBe(stream);
  const encoded = new Response("compressed", { headers: { "content-type": "application/json", "content-encoding": "gzip" } });
  expect(await jsonHttp(new Request(url), encoded)).toBe(encoded);
});
