import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TOKEN_HEADER, type RootAdmission, type MemoryResult } from "kenan-memory/contract";
import { rootAdminAdmission, rootReplyResponse } from "./visibility.js";
import type { RootExecutor } from "./root-runtime.js";
import { infrastructureReason, reportInfrastructure, type InfrastructureReporter } from "kenan-memory/diagnostics";

export interface RootReleaseState { quiescing: boolean; consentActive: boolean }
export interface RootServiceOptions {
  enabled(): boolean;
  memoryUrl: string;
  memoryRootToken: string;
  adminCapability: string;
  sessionsDir: string;
  executor: RootExecutor;
  maxConcurrent?: number;
  transport?: typeof fetch;
  report?: InfrastructureReporter;
  releaseCommit?: string;
  releaseState?: RootReleaseState;
}
export function rootService(options: RootServiceOptions): (request: Request) => Promise<Response> {
  const transport = options.transport ?? fetch;
  const report = options.report ?? reportInfrastructure;
  const releaseState = options.releaseState ?? { quiescing: false, consentActive: false };
  let active = 0;
  const rpc = async <T>(path: string, body: unknown): Promise<MemoryResult<T>> => {
    const started = performance.now();
    const stage = path === "/v1/root/admit" ? "admit" : "finalize";
    try {
      const response = await transport(new URL(path, options.memoryUrl), { method: "POST", headers: { "content-type": "application/json", [MEMORY_TOKEN_HEADER]: options.memoryRootToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const result = await response.json();
      const ok = result?.ok === true && response.ok;
      report({ component: "root-service", stage, outcome: ok ? "ok" : "failed", ...(!ok ? { reason: response.ok ? "invalid-response" as const : "http-error" as const } : {}), status: response.status, durationMs: Math.round(performance.now() - started) });
      return ok ? result : { ok: false, error: response.status === 403 ? "unauthenticated" : "unavailable", message: "Root admission or disclosure accounting could not complete" };
    } catch (error) {
      report({ component: "root-service", stage, outcome: "failed", reason: infrastructureReason(error), durationMs: Math.round(performance.now() - started) });
      return { ok: false, error: "unavailable", message: "Root admission or disclosure accounting could not complete" };
    }
  };
  return async request => {
    if (!options.enabled()) return Response.json({ error: "Root Kenan is disabled" }, { status: 503 });
    const path = new URL(request.url).pathname;
    if (path.startsWith("/v1/admin/")) {
      const admission = rootAdminAdmission(request, options.adminCapability);
      if (!admission.ok) return admission.response;
      if (admission.route.kind === "release") {
        if (request.method === "DELETE") {
          releaseState.quiescing = false;
          return Response.json({ ok: true, quiescing: false });
        }
        if (active || releaseState.consentActive) return Response.json({ ok: false, error: "busy" }, { status: 409 });
        releaseState.quiescing = true;
        return Response.json({ ok: true, quiescing: true });
      }
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
    if (path === "/v1/health" && request.method === "GET") return Response.json({ ok: true, service: "kenan-root", releaseCommit: options.releaseCommit ?? null, releaseProtocol: 1 });
    if (path !== "/v1/ask" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const callerToken = request.headers.get(MEMORY_TOKEN_HEADER);
    if (!callerToken) return Response.json({ error: "An authenticated thread is required" }, { status: 403 });
    if (Number(request.headers.get("content-length")) > 32_768) return new Response("Request too large", { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > 32_768) return new Response("Request too large", { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ error: "Expected one request string" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as any).request !== "string" || !(body as any).request.trim()) return Response.json({ error: "Expected one request string; root context cannot be supplied" }, { status: 400 });
    if (releaseState.quiescing) return Response.json({ error: "Root Kenan is preparing a release; try again" }, { status: 503 });
    if (active >= (options.maxConcurrent ?? 4)) return Response.json({ error: "Root Kenan is busy; try again" }, { status: 503 });
    active++;
    const started = performance.now();
    try {
      const root = await rpc<RootAdmission>("/v1/root/admit", { callerToken, request: (body as any).request });
      if (!root.ok) return Response.json({ error: root.message }, { status: root.error === "unauthenticated" ? 403 : 503 });
      const result = await options.executor(root.value, (body as any).request);
      if (!result.ok) return Response.json({ error: result.message }, { status: 503 });
      const finalized = await rpc("/v1/root/finalize-reply", { rootSessionId: root.value.rootSessionId, reply: result.value.reply, recipients: root.value.recipients, subjects: result.value.subjects });
      if (!finalized.ok) return Response.json({ error: "Kenan's reply was not delivered because its disclosure record could not commit" }, { status: 503 });
      return rootReplyResponse(result.value.reply);
    } catch (error) {
      report({ component: "root-service", stage: "request", outcome: "failed", reason: infrastructureReason(error), durationMs: Math.round(performance.now() - started) });
      return Response.json({ error: "Root Kenan could not complete the request" }, { status: 503 });
    } finally { active--; }
  };
}
