#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { unixGatewayFetch, type GatewayPeer } from "./gateway-fetch.js";

export type GatewayRequestReceipt =
  | { ok: true; value: { status: number; body: unknown } }
  | { ok: false; error: { code: "invalid-request" | "configuration" | "transport-unconfirmed"; message: string } };
type Transport = (peer: GatewayPeer, input: Request | URL | string, init?: RequestInit) => Promise<Response>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const failed = (code: "invalid-request" | "configuration" | "transport-unconfirmed", message: string): GatewayRequestReceipt => ({ ok: false, error: { code, message } });

export async function gatewayRequest(input: unknown, env: Record<string, string | undefined> = process.env, transport: Transport = unixGatewayFetch): Promise<GatewayRequestReceipt> {
  if (!object(input) || Object.keys(input).some(key => !["method", "route", "body", "headers"].includes(key))
      || !["GET", "POST", "PUT", "DELETE"].includes(String(input.method)) || typeof input.route !== "string"
      || !input.route.startsWith("/v1/") || /[\\\s#]/u.test(input.route)
      || input.method === "GET" && input.body !== undefined || input.body !== undefined && !object(input.body)) return failed("invalid-request", "Explicit method, core route and optional JSON object body required");
  const headers: Record<string, string> = {};
  if (input.headers !== undefined) {
    if (!object(input.headers) || Object.keys(input.headers).some(key => key !== "x-pi-thread-token") || Object.values(input.headers).some(value => typeof value !== "string" || !value || /[\r\n]/u.test(value))) return failed("invalid-request", "Only an explicit native thread sender header is accepted");
    Object.assign(headers, input.headers);
  }
  if (env.PI_THREAD_TOKEN) {
    if (headers["x-pi-thread-token"] !== undefined && headers["x-pi-thread-token"] !== env.PI_THREAD_TOKEN) return failed("invalid-request", "Caller sender token conflicts with its native thread binding");
    headers["x-pi-thread-token"] = env.PI_THREAD_TOKEN;
  }
  const base = env.PI_CORE_URL?.trim(), socketPath = env.PI_CORE_GATEWAY_SOCKET?.trim(), uid = env.PI_CORE_GATEWAY_UID?.trim();
  if (!base || !socketPath || !isAbsolute(socketPath) || resolve(socketPath) !== socketPath || socketPath.includes("\0")
      || !uid || !/^\d+$/u.test(uid) || !Number.isSafeInteger(Number(uid)) || env.PI_CORE_TOKEN_FILE) return failed("configuration", "Explicit registered Unix gateway, expected core UID and base URL required; no bearer fallback");
  let url: URL;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return failed("configuration", "Gateway base must be an absolute local HTTP origin");
    url = new URL(input.route, parsed);
    if (url.origin !== parsed.origin || !url.pathname.startsWith("/v1/") || url.hash || url.pathname !== input.route.split("?")[0]) return failed("invalid-request", "Core route must retain its exact path and origin");
  } catch { return failed("configuration", "Invalid configured gateway URL"); }
  if (input.body !== undefined) headers["content-type"] = "application/json";
  try {
    const response = await transport({ socketPath, peerUid: Number(uid) }, url, {
      method: input.method as string, headers, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal: AbortSignal.timeout(40_000),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 12 * 1024 * 1024) return failed("transport-unconfirmed", "Gateway response exceeds the receipt bound; inspect original request custody");
    let body: unknown;
    try { body = text === "" ? null : JSON.parse(text); }
    catch { return failed("transport-unconfirmed", "Gateway response is not JSON; inspect original request custody"); }
    return { ok: true, value: { status: response.status, body } };
  } catch { return failed("transport-unconfirmed", "Gateway peer or transport unavailable; inspect the same original request ID before replay"); }
}

export async function gatewayRequestStdin(stream: AsyncIterable<string | Buffer>, env: Record<string, string | undefined> = process.env): Promise<GatewayRequestReceipt> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return failed("invalid-request", "Gateway request exceeds 1 MiB");
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return await gatewayRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")), env);
  } catch { return failed("invalid-request", "Gateway stdin must be one JSON request"); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await gatewayRequestStdin(process.stdin)));
}
