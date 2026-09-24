import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

function accepts(header: string, encoding: string): boolean {
  return header.split(",").some(part => {
    const [name, ...parameters] = part.trim().split(";");
    return name?.toLowerCase() === encoding && !parameters.some(value => /^q\s*=\s*0(?:\.0*)?\s*$/i.test(value.trim()));
  });
}

/** Finalize JSON at the HTTP boundary, after all handlers have built their responses. */
export async function jsonHttp(req: Request, response: Response | undefined): Promise<Response | undefined> {
  if (!response || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || response.headers.has("content-encoding")) return response;
  const headers = new Headers(response.headers);
  const get = req.method === "GET" && response.status === 200;
  if (get) {
    const body = Buffer.from(await response.arrayBuffer());
    const etag = `W/"${createHash("sha256").update(body).digest("hex")}"`;
    if (!headers.has("etag")) headers.set("etag", etag);
    headers.set("cache-control", new URL(req.url).pathname.endsWith("/link-previews") ? "private, max-age=300" : "private, no-cache");
    headers.set("vary", [headers.get("vary"), "Accept-Encoding"].filter(Boolean).join(", "));
    if (req.headers.get("if-none-match")?.split(",").some(tag => tag.trim() === headers.get("etag") || tag.trim() === "*")) {
      headers.delete("content-length");
      return new Response(null, { status: 304, headers });
    }
    return encoded(req, body, response.status, headers);
  }
  if (response.status < 200 || response.status === 204 || response.status === 304) return response;
  return encoded(req, Buffer.from(await response.arrayBuffer()), response.status, headers);
}

function encoded(req: Request, body: Buffer, status: number, headers: Headers): Response {
  headers.delete("content-length");
  headers.set("vary", [headers.get("vary"), "Accept-Encoding"].filter(Boolean).join(", "));
  const accepted = req.headers.get("accept-encoding") ?? "";
  if (body.length >= 1024 && accepts(accepted, "br")) {
    headers.set("content-encoding", "br");
    return new Response(brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), { status, headers });
  }
  if (body.length >= 1024 && accepts(accepted, "gzip")) {
    headers.set("content-encoding", "gzip");
    return new Response(gzipSync(body, { level: 4 }), { status, headers });
  }
  return new Response(new Uint8Array(body), { status, headers });
}
