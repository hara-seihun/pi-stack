import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createOAuthEncoder } from "./codex-anthropic-oauth.js";
import { AnthropicAdapterError, translateAnthropicRequest } from "./codex-anthropic-request.js";
import { streamAnthropicResponse } from "./codex-anthropic-stream.js";

export interface CodexAnthropicAdapterOptions {
  sessionId: string;
  cwd?: string;
  credentials(request: { refresh: boolean; signal: AbortSignal }): Promise<{ accessToken: string }>;
  fetch?: typeof globalThis.fetch;
}
export interface CodexAnthropicAdapter {
  baseUrl: string;
  close(): Promise<void>;
}
const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
const MAX_REQUEST_BYTES = 128 * 1024 * 1024;

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
async function readRequest(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new AnthropicAdapterError("Compressed Responses requests are not supported", 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new AnthropicAdapterError("Responses request exceeds 128 MiB", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AnthropicAdapterError("Responses request is not valid JSON", 400, "invalid_request_error"); }
}
async function upstreamError(response: Response, signal: AbortSignal): Promise<AnthropicAdapterError> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const limit = 64 * 1024;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (size < limit) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        const chunk = value.subarray(0, limit - size);
        chunks.push(chunk);
        size += chunk.length;
      }
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }
  const text = Buffer.concat(chunks).toString("utf8") + (size === limit ? " [provider error body truncated at 64 KiB]" : "");
  let message = text;
  let code = "upstream_error";
  try {
    const body = JSON.parse(text);
    message = body.error?.message ?? text;
    code = body.error?.type ?? code;
  } catch { /* Non-JSON provider error bodies are still useful to the caller. */ }
  return new AnthropicAdapterError(`Anthropic HTTP ${response.status}: ${message}`, response.status, code);
}

export async function startCodexAnthropicAdapter(options: CodexAnthropicAdapterOptions): Promise<CodexAnthropicAdapter> {
  const encoder = await createOAuthEncoder();
  const upstreamFetch = options.fetch ?? globalThis.fetch;
  const active = new Set<AbortController>();
  const requests = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController();
    const { signal } = controller;
    active.add(controller);
    const disconnect = () => controller.abort(new Error("Codex Responses client disconnected"));
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const tokens = new Set<string>();
    let sequence = 0;
    const clean = (message: string) => {
      for (const token of tokens) message = message.split(token).join("[redacted]");
      return message;
    };
    const emit = async (type: string, fields: Record<string, unknown>) => {
      signal.throwIfAborted();
      const event = { ...fields, type, sequence_number: sequence++ };
      if (!response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)) await once(response, "drain", { signal });
    };
    try {
      if (closing) throw new AnthropicAdapterError("Anthropic adapter is closing", 503, "adapter_closed");
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method !== "POST" || path !== "/responses") throw new AnthropicAdapterError(`Unsupported Anthropic adapter endpoint: ${request.method} ${path}`, 404);
      const translated = translateAnthropicRequest(await readRequest(request));
      signal.throwIfAborted();
      const encoded = await encoder.encode(translated.payload, options.sessionId, signal);
      const send = async (refresh: boolean) => {
        const credential = await abortable(options.credentials({ refresh, signal }), signal);
        signal.throwIfAborted();
        if (!credential.accessToken) throw new AnthropicAdapterError("Anthropic account returned no access token", 401, "authentication_error");
        tokens.add(credential.accessToken);
        return upstreamFetch(MESSAGES_URL, { method: "POST", body: encoded.body,
          headers: { ...encoded.headers, authorization: `Bearer ${credential.accessToken}` }, signal });
      };
      let upstream = await send(false);
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        upstream = await send(true);
      }
      for (const header of ["request-id", "retry-after"]) {
        const value = upstream.headers.get(header);
        if (value) response.setHeader(header, value);
      }
      if (!upstream.ok) throw await upstreamError(upstream, signal);
      if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
        await upstream.body?.cancel();
        throw new AnthropicAdapterError("Anthropic did not return an SSE stream", 502, "upstream_protocol_error");
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      await streamAnthropicResponse(upstream, translated, emit, signal);
      response.end();
    } catch (error) {
      if (signal.aborted || response.destroyed) return;
      const failure = error instanceof AnthropicAdapterError ? error : new AnthropicAdapterError(error instanceof Error ? error.message : String(error), 502, "adapter_error");
      const detail = { message: clean(failure.message), type: failure.code, code: failure.code, param: null };
      if (!response.headersSent) {
        response.writeHead(failure.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: detail }));
      } else {
        try { await emit("error", detail); response.end(); }
        catch { response.destroy(); }
      }
    } finally {
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      controller.abort(new Error("Responses request finished"));
      active.delete(controller);
    }
  };
  const server = createServer((request, response) => {
    const task = serve(request, response);
    requests.add(task);
    void task.finally(() => requests.delete(task));
  });
  server.on("upgrade", (_request, socket) => { socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  server.requestTimeout = 0;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    server.close();
    await encoder.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    await encoder.close();
    throw new Error("Anthropic adapter did not bind a loopback TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close() {
      return closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const controller of active) controller.abort(new Error("Anthropic adapter closed"));
        server.closeAllConnections();
        await Promise.all([stopped, encoder.close(), ...requests]);
      })();
    },
  };
}
