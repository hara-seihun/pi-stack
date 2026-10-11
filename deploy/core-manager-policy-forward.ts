#!/usr/bin/env bun
import { MANAGER_POLICY_PATH } from "../apps/remote/server/canonical-manager-policy";
const tokenHeader = "x-pi-canonical-manager-policy";
const failure = (message: string, status: number) => Response.json({ ok: false, error: { code: "unavailable", message } }, { status });
async function bounded(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new Error("Metadata body required");
  const reader = body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) { const chunk = await reader.read(); if (signal.aborted) throw new Error("Metadata deadline expired"); if (chunk.done) break; size += chunk.value.length; if (size > 4096) throw new Error("Metadata exceeds bound"); chunks.push(chunk.value); }
    return new Uint8Array(Buffer.concat(chunks));
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel(); reader.releaseLock(); }
}
export async function forwardManagerPolicy(request: Request, transport: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== MANAGER_POLICY_PATH || url.search || url.hash) return failure("Only the exact enrolled policy read is forwarded", 403);
  const token = request.headers.get(tokenHeader);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return failure("Enrolled policy credential required", 403);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  try {
    const body = await bounded(request.body, signal);
    const response = await transport(`http://127.0.0.1:8788${MANAGER_POLICY_PATH}`, { method: "POST", redirect: "error", signal, headers: { "content-type": "application/json", [tokenHeader]: token }, body });
    const output = await bounded(response.body, signal);
    return new Response(output, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch { return failure("Policy-only loopback transport unavailable", 503); }
}
if (import.meta.main) {
  const [port, ...extra] = process.argv.slice(2);
  if (extra.length || !port || !/^[0-9]+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || Number(port) === 8788) throw new Error("Explicit unused loopback port required");
  Bun.serve({ hostname: "127.0.0.1", port: Number(port), idleTimeout: 10, fetch: request => forwardManagerPolicy(request) });
}
