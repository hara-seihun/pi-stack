import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KENAN_REQUEST_HEADER, KENAN_REQUEST_ID_PATTERN, kenanRequestNotice, MEMORY_TOKEN_HEADER, type RootAdmission, type MemoryResult } from "kenan-memory/contract";
import { rootAdminAdmission, rootReplyResponse } from "./visibility.js";
import type { RootExecutor } from "./root-runtime.js";
import { RootRequestStore, requestHash, type RootRequest } from "./requests.js";
import type { ConsentBridge } from "./consent-contract.js";
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
  requestStore?: RootRequestStore;
  bridge?: Pick<ConsentBridge, "reply">;
}
export function rootService(options: RootServiceOptions): ((request: Request) => Promise<Response>) & { drain(): Promise<{ errors: number }> } {
  const transport = options.transport ?? fetch;
  const report = options.report ?? reportInfrastructure;
  const releaseState = options.releaseState ?? { quiescing: false, consentActive: false };
  const requests = options.requestStore ?? new RootRequestStore(":memory:");
  const accepting = new Map<string, Promise<void>>();
  const finalizing = new Map<string, Promise<void>>();
  const delivering = new Map<string, Promise<void>>();
  let active = 0;
  const rpc = async <T>(path: string, body: unknown): Promise<MemoryResult<T>> => {
    const started = performance.now();
    const stage = path === "/v1/root/admit" ? "admit" : path === "/v1/root/authorize-request" ? "authorize" : path === "/v1/root/log-request-status" ? "request-status" : "finalize";
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
  const finalize = (record: RootRequest): Promise<void> => {
    record = requests.get(record.id) ?? record;
    if (record.state !== "finalizing") return Promise.resolve();
    const pending = finalizing.get(record.id);
    if (pending) return pending;
    requests.save({ ...record, attemptedAt: Date.now() });
    active++;
    const operation = (async () => {
      try {
        const result = await rpc("/v1/root/finalize-reply", { rootSessionId: record.admission.rootSessionId, reply: record.chosen.reply, recipients: record.admission.recipients, subjects: record.chosen.subjects });
        if (result.ok) requests.save({ ...record, state: "completed" });
      } finally { active--; finalizing.delete(record.id); }
    })();
    finalizing.set(record.id, operation);
    return operation;
  };
  const deliver = (id: string): Promise<void> => {
    const pending = delivering.get(id);
    if (pending) return pending;
    const record = requests.get(id);
    if (!record || !["completed", "failed", "interrupted"].includes(record.state) || record.delivery !== "pending" || !options.bridge) return Promise.resolve();
    requests.save({ ...record, attemptedAt: Date.now() });
    active++;
    const operation = (async () => {
      try {
        let reply: string;
        let logged: MemoryResult<unknown>;
        if (record.state === "completed") {
          reply = record.chosen.reply;
          logged = await rpc("/v1/root/finalize-reply", { rootSessionId: record.admission.rootSessionId, reply, recipients: record.admission.recipients, subjects: record.chosen.subjects });
        } else if (record.state === "failed" || record.state === "interrupted") {
          reply = kenanRequestNotice(id, record.state);
          logged = await rpc("/v1/root/log-request-status", { rootSessionId: record.admission.rootSessionId, requestId: id, status: record.state });
        } else return;
        if (!logged.ok) return;
        const result = await options.bridge!.reply({ consentId: id, person: record.admission.person, threadId: record.admission.threadId, reply });
        if (result.ok && result.value.accepted) requests.save({ ...record, delivery: "delivered" });
      } finally { active--; delivering.delete(id); }
    })();
    delivering.set(id, operation);
    return operation;
  };
  const drain = async () => {
    if (!options.enabled() || releaseState.quiescing) return { errors: 0 };
    const results = await Promise.all(requests.pending(options.maxConcurrent ?? 4).map(async record => {
      try { await finalize(record); await deliver(record.id); }
      catch (error) { report({ component: "root-service", stage: "request", outcome: "failed", reason: infrastructureReason(error), durationMs: 0 }); }
      const current = requests.get(record.id)!;
      return current.state === "finalizing" || current.delivery === "pending";
    }));
    return { errors: results.filter(Boolean).length };
  };
  const execute = async (record: RootRequest, admission: RootAdmission, text: string) => {
    const started = performance.now();
    try {
      const result = await options.executor(admission, text);
      if (!result.ok) { requests.save({ ...record, state: "failed" }); await deliver(record.id); return; }
      const chosen: RootRequest = { ...record, state: "finalizing", chosen: result.value };
      requests.save(chosen);
      await finalize(chosen);
      await deliver(record.id);
    } catch (error) {
      report({ component: "root-service", stage: "request", outcome: "failed", reason: infrastructureReason(error), durationMs: Math.round(performance.now() - started) });
      const current = requests.get(record.id);
      if (current?.state === "executing") {
        requests.save({ ...current, state: "failed" });
        await deliver(record.id);
      }
    } finally { active--; }
  };
  const status = (record: RootRequest): Response => record.state === "completed"
    ? rootReplyResponse(record.chosen.reply)
    : Response.json({ requestId: record.id, status: ["executing", "finalizing"].includes(record.state) ? "pending" : record.state }, { status: record.state === "executing" || record.state === "finalizing" ? 202 : 200, headers: { "cache-control": "no-store" } });
  const authorize = (callerToken: string, record: RootRequest) => rpc("/v1/root/authorize-request", { callerToken, rootSessionId: record.admission.rootSessionId });
  const handle = async (request: Request): Promise<Response> => {
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
    const lookup = /^\/v1\/ask\/([^/]+)$/.exec(path);
    if (!(path === "/v1/ask" && request.method === "POST") && !(lookup && request.method === "GET")) return new Response("Not found", { status: 404 });
    const callerToken = request.headers.get(MEMORY_TOKEN_HEADER);
    if (!callerToken) return Response.json({ error: "An authenticated thread is required" }, { status: 403 });
    if (lookup) {
      if (!new RegExp(KENAN_REQUEST_ID_PATTERN).test(lookup[1]!)) return new Response("Not found", { status: 404 });
      while (accepting.has(lookup[1]!)) await accepting.get(lookup[1]!);
      let record = requests.get(lookup[1]!);
      if (!record) return new Response("Not found", { status: 404 });
      const authorized = await authorize(callerToken, record);
      if (!authorized.ok) return new Response("Not found", { status: authorized.error === "unauthenticated" ? 404 : 503 });
      if (record.state === "finalizing" && !releaseState.quiescing) await finalize(record);
      record = requests.get(record.id)!;
      return status(record);
    }
    const suppliedId = request.headers.get(KENAN_REQUEST_HEADER);
    if (suppliedId !== null && !new RegExp(KENAN_REQUEST_ID_PATTERN).test(suppliedId)) return Response.json({ error: "Invalid request ID" }, { status: 400 });
    if (Number(request.headers.get("content-length")) > 32_768) return new Response("Request too large", { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > 32_768) return new Response("Request too large", { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ error: "Expected one request string" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as any).request !== "string" || !(body as any).request.trim()) return Response.json({ error: "Expected one request string; root context cannot be supplied" }, { status: 400 });
    const id = suppliedId ?? randomUUID();
    while (accepting.has(id)) await accepting.get(id);
    const prior = requests.get(id);
    if (prior) {
      const authorized = await authorize(callerToken, prior);
      if (!authorized.ok) return new Response("Not found", { status: authorized.error === "unauthenticated" ? 404 : 503 });
      if (prior.requestHash !== requestHash((body as any).request)) return Response.json({ error: "Request ID already used" }, { status: 409 });
      return status(prior);
    }
    if (releaseState.quiescing) return Response.json({ error: "Root Kenan is preparing a release; try again" }, { status: 503 });
    if (active >= (options.maxConcurrent ?? 4)) return Response.json({ error: "Root Kenan is busy; try again" }, { status: 503 });
    active++;
    let release!: () => void;
    accepting.set(id, new Promise<void>(resolve => release = resolve));
    let executing = false;
    const started = performance.now();
    try {
      const root = await rpc<RootAdmission>("/v1/root/admit", { callerToken, request: (body as any).request });
      if (!root.ok) return Response.json({ error: root.message }, { status: root.error === "unauthenticated" ? 403 : 503 });
      const record = requests.accept(id, (body as any).request, root.value, !!suppliedId);
      executing = true;
      const operation = execute(record, root.value, (body as any).request);
      if (suppliedId) return status(record);
      // Headerless callers used a synchronous reply before durable receipts existed.
      await operation;
      const settled = requests.get(id)!;
      return settled.state === "completed" ? status(settled) : Response.json({ error: "Root Kenan could not complete the request", requestId: id }, { status: 503 });
    } catch (error) {
      report({ component: "root-service", stage: "request", outcome: "failed", reason: infrastructureReason(error), durationMs: Math.round(performance.now() - started) });
      return Response.json({ error: "Root Kenan could not accept the request" }, { status: 503 });
    } finally {
      if (!executing) active--;
      accepting.delete(id); release();
    }
  };
  return Object.assign(handle, { drain });
}
