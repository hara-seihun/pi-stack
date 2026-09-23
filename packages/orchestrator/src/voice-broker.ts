import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrokerTransport } from "./model-broker.js";

const MAX_BODY = 256 * 1024;

export async function forwardVoiceRequest(
  principal: string,
  req: IncomingMessage,
  res: ServerResponse,
  shutdown: AbortSignal,
  transport: BrokerTransport,
): Promise<void> {
  const path = (req.url ?? "").slice("/v1/voice".length);
  const status = req.method === "GET" && path === "/status";
  const create = req.method === "POST" && path === "/sessions";
  const update = (req.method === "PATCH" || req.method === "DELETE") && /^\/sessions\/[A-Za-z0-9_-]+$/.test(path);
  const reply = (code: number, error: string) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ error }));
  };
  if (!status && !create && !update) return reply(404, "Unknown Voice operation");
  const cancel = new AbortController();
  const disconnected = () => { if (!res.writableFinished) cancel.abort(); };
  res.on("close", disconnected);
  try {
    let body: Record<string, unknown> | undefined;
    if (!status) {
      if (!String(req.headers["content-type"]).startsWith("application/json")) return reply(415, "Expected application/json");
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) return reply(413, "Voice request exceeds 256 KiB");
        chunks.push(Buffer.from(chunk));
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reply(400, "Invalid Voice JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.threadId !== "string") return reply(400, "Pi thread is required");
      body.owner = `broker:${principal}`;
    }
    const upstream = process.env.PI_STACK_VOICE_URL ?? "http://127.0.0.1:8796";
    const response = await transport(new URL(path, upstream).href, {
      method: req.method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([shutdown, cancel.signal, AbortSignal.timeout(35_000)]),
      redirect: "error",
    });
    const bytes = await response.arrayBuffer();
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(Buffer.from(bytes));
  } catch {
    if (!res.destroyed) reply(503, "The PiStack Voice API service is unavailable");
  } finally {
    res.off("close", disconnected);
  }
}
