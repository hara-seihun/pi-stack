import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TOKEN_HEADER, type RootAdmission, type MemoryResult } from "kenan-memory/contract";
import { rootAdminAdmission, rootReplyResponse } from "./visibility.js";
import type { RootExecutor } from "./root-runtime.js";

export interface RootServiceOptions {
  enabled(): boolean;
  memoryUrl: string;
  memoryRootToken: string;
  adminCapability: string;
  sessionsDir: string;
  executor: RootExecutor;
  maxConcurrent?: number;
  transport?: typeof fetch;
}
export function rootService(options: RootServiceOptions): (request: Request) => Promise<Response> {
  const transport = options.transport ?? fetch;
  let active = 0;
  const rpc = async <T>(path: string, body: unknown): Promise<MemoryResult<T>> => {
    try {
      const response = await transport(new URL(path, options.memoryUrl), { method: "POST", headers: { "content-type": "application/json", [MEMORY_TOKEN_HEADER]: options.memoryRootToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const result = await response.json();
      return result?.ok === true && response.ok ? result : { ok: false, error: response.status === 403 ? "unauthenticated" : "unavailable", message: "Root admission or disclosure accounting could not complete" };
    } catch { return { ok: false, error: "unavailable", message: "Root admission or disclosure accounting could not complete" }; }
  };
  return async request => {
    if (!options.enabled()) return Response.json({ error: "Root Kenan is disabled" }, { status: 503 });
    const path = new URL(request.url).pathname;
    if (path.startsWith("/v1/admin/")) {
      const admission = rootAdminAdmission(request, options.adminCapability);
      if (!admission.ok) return admission.response;
      // No private-store inspection happens before the separate admin capability is checked.
      if (admission.route.kind === "list") {
        const sessions = existsSync(options.sessionsDir) ? readdirSync(options.sessionsDir).filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => {
          const directory = join(options.sessionsDir, id);
          if (lstatSync(directory).isSymbolicLink() || !existsSync(join(directory, "admission.json"))) return null;
          return { id, ...JSON.parse(readFileSync(join(directory, "admission.json"), "utf8")) };
        }).filter(Boolean) : [];
        return Response.json({ sessions }, { headers: { "cache-control": "no-store" } });
      }
      const directory = join(options.sessionsDir, admission.route.sessionId);
      if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return new Response("Not found", { status: 404 });
      const files = readdirSync(directory).filter(name => name.endsWith(".jsonl") && !lstatSync(join(directory, name)).isSymbolicLink());
      return Response.json({ sessionId: admission.route.sessionId, transcripts: files.map(name => ({ name, jsonl: readFileSync(join(directory, name), "utf8") })) }, { headers: { "cache-control": "no-store" } });
    }
    if (path === "/v1/health" && request.method === "GET") return Response.json({ ok: true, service: "kenan-root" });
    if (path !== "/v1/ask" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const callerToken = request.headers.get(MEMORY_TOKEN_HEADER);
    if (!callerToken) return Response.json({ error: "An authenticated thread is required" }, { status: 403 });
    if (Number(request.headers.get("content-length")) > 32_768) return new Response("Request too large", { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > 32_768) return new Response("Request too large", { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ error: "Expected one request string" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as any).request !== "string" || !(body as any).request.trim()) return Response.json({ error: "Expected one request string; root context cannot be supplied" }, { status: 400 });
    if (active >= (options.maxConcurrent ?? 4)) return Response.json({ error: "Root Kenan is busy; try again" }, { status: 503 });
    active++;
    try {
      const root = await rpc<RootAdmission>("/v1/root/admit", { callerToken, request: (body as any).request });
      if (!root.ok) return Response.json({ error: root.message }, { status: root.error === "unauthenticated" ? 403 : 503 });
      const result = await options.executor(root.value, (body as any).request);
      if (!result.ok) return Response.json({ error: result.message }, { status: 503 });
      const finalized = await rpc("/v1/root/finalize-reply", { rootSessionId: root.value.rootSessionId, reply: result.value.reply, recipients: root.value.recipients, subjects: result.value.subjects });
      if (!finalized.ok) return Response.json({ error: "Kenan's reply was not delivered because its disclosure record could not commit" }, { status: 503 });
      return rootReplyResponse(result.value.reply);
    } catch { return Response.json({ error: "Root Kenan could not complete the request" }, { status: 503 }); }
    finally { active--; }
  };
}
