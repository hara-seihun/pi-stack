import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export function webRequest(req: IncomingMessage, origin: string, signal: AbortSignal, body: "stream" | "unread"): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
  if (body === "stream" && method !== "GET" && method !== "HEAD") { init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>; init.duplex = "half"; }
  return new Request(new URL(req.url ?? "/", origin), init);
}
export async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  const close = () => { void reader.cancel("Client disconnected").catch(() => {}); };
  res.once("close", close);
  try {
    while (!res.destroyed) {
      const next = await reader.read();
      if (next.done) break;
      if (!res.write(next.value)) await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => { res.off("drain", done); res.off("close", done); res.off("error", failed); };
        res.once("drain", done); res.once("close", done); res.once("error", failed);
      });
    }
    if (!res.destroyed) res.end();
  } finally { res.off("close", close); reader.releaseLock(); }
}
