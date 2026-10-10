import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite } from "../sqlite.js";
import { authorize, type PermissionAction, type Principal, type Resource } from "../permissions.js";
import { ThreadService, type ThreadServiceEvent } from "../threads/service.js";
import { ThreadDirectory } from "../threads/directory.js";
import { threadCapability, callerResolver, type ThreadCaller } from "../threads/caller.js";
import { threadHttp } from "../threads/http.js";
import type { AttachPiSession, OpenPiSession, PiEvent, PiSession, Result, Thread, ThreadApi } from "../threads/contracts.js";
import type { CoreConfig, CoreEvent, CoreProjection, CoreScope } from "./contracts.js";
import type { CoreResult } from "./config.js";
import { acquireScopeOwnership, type ScopeOwnership } from "./ownership.js";

export type CoreRuntime = {
  openSession: OpenPiSession;
  attachSession: AttachPiSession;
  recoverSession(threadId: string, output: (event: PiEvent) => void, exit: (code: number | null) => void): Promise<PiSession | null>;
  detach(): void;
  path(logicalPath: string): string;
};
export type CoreRuntimeFactory = (scope: CoreScope) => Promise<CoreResult<CoreRuntime>>;
type ScopeOwner = { scope: CoreScope; threads: ThreadService; runtime: CoreRuntime; ownership: ScopeOwnership; unsubscribe(): void; capability: ReturnType<typeof threadCapability> };
type Identity = { principal: Principal; scopeIds: readonly string[]; caller: ThreadCaller };
const failure = (code: "invalid_request" | "unavailable" | "not_found" | "conflict", message: string): Result<never> => ({ ok: false, error: { code, message } });
const jsonError = (status: number, message: string) => Response.json(failure(status === 404 ? "not_found" : status === 503 ? "unavailable" : "invalid_request", message), { status });
const reads = new Set(["list", "archived", "read", "inspect", "questions", "pendingQuestions", "questionEvents", "questionState", "questionOrigin", "managerThread", "managerNotificationPolicy", "managerWorkSummary", "attentionEvents", "settlements", "await"]);
function operationAction(operation: string): PermissionAction {
  if (reads.has(operation)) return "read";
  if (operation === "spawn") return "dispatch";
  if (operation === "control" || operation === "command") return "control";
  return "write";
}

export class CoreService {
  private readonly owners = new Map<string, ScopeOwner>();
  private readonly listeners = new Map<string, Set<(event: CoreEvent) => void>>();
  private readonly db: ReturnType<typeof openSqlite>;
  private readonly cursors = new Map<string, { current: number; ceiling: number }>();
  private state: "serving" | "draining" | "closed" = "serving";
  constructor(readonly config: CoreConfig, private readonly runtimeFactory: CoreRuntimeFactory) {
    mkdirSync(dirname(config.statePath), { recursive: true, mode: 0o700 });
    this.db = openSqlite(config.statePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS core_scope_cursor(scope_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL)");
  }
  owner(scopeId: string): CoreResult<{ threads: ThreadService; runtime: CoreRuntime }> {
    const owner = this.owners.get(scopeId);
    return owner ? { ok: true, value: owner } : { ok: false, error: { code: "unavailable", message: `Scope ${scopeId} has not transferred controller custody` } };
  }
  async start(): Promise<CoreResult<void>> {
    for (const scope of this.config.scopes) {
      if (scope.availability.kind === "unavailable") continue;
      const result = await this.adopt(scope);
      if (!result.ok) { await this.close(); return result; }
    }
    for (const owner of this.owners.values()) {
      const scopes = [...this.owners.values()].filter(candidate => candidate.scope.principalId === owner.scope.principalId);
      const directory = new ThreadDirectory({ id: owner.scope.manager.kind === "existing" ? "person" : owner.scope.id, api: owner.threads }, scopes.filter(candidate => candidate !== owner).map(candidate => ({ id: candidate.scope.manager.kind === "existing" ? "person" : candidate.scope.id, api: candidate.threads })));
      owner.threads.setDirectory(directory);
      if (owner.scope.manager.kind === "existing") owner.threads.setManagerWatchdog(async () => {
        const summary = await directory.managerWorkSummary();
        return summary.ok ? { ok: true, value: { ...summary.value, managerThreadId: owner.scope.manager.kind === "existing" ? owner.scope.manager.threadId : null } } : summary;
      }, message => { if (message) console.error(`Core manager ${owner.scope.id}: ${message}`); });
    }
    return { ok: true, value: undefined };
  }
  async activate(): Promise<CoreResult<void>> {
    for (const owner of this.owners.values()) {
      const started = await owner.threads.start();
      if (!started.ok) { await this.close(); return { ok: false, error: { code: "unavailable", message: `${owner.scope.id}: ${started.error.message}` } }; }
    }
    return { ok: true, value: undefined };
  }
  private async adopt(scope: CoreScope): Promise<CoreResult<void>> {
    const built = await this.runtimeFactory(scope);
    if (!built.ok) return built;
    const runtime = built.value;
    const ownership = acquireScopeOwnership(scope, path => runtime.path(path));
    if (!ownership.ok) { runtime.detach(); return ownership; }
    let threads: ThreadService | undefined;
    try {
      const keyPath = runtime.path(scope.storage.capabilityKeyPath);
      if (!existsSync(keyPath)) throw new Error("Existing capability key is missing; adoption cannot mint a replacement");
      const capability = threadCapability(keyPath);
      threads = new ThreadService({
        databasePath: runtime.path(scope.storage.databasePath), sessionsDir: runtime.path(scope.storage.sessionsDir), capability,
        openSession: (options, output, exit) => runtime.openSession({ ...options, args: scope.environment.PI_THREAD_CONTEXT_EXTENSION ? [...options.args, "--extension", scope.environment.PI_THREAD_CONTEXT_EXTENSION] : options.args }, output, exit),
        attachSession: runtime.attachSession, recoverSession: runtime.recoverSession,
        environment: thread => ({ ...scope.environment, PI_THREAD_API_URL: `${this.url}/v1/scopes/${encodeURIComponent(scope.id)}/thread-owner`, PI_THREAD_ID: thread.id, PI_REMOTE_SESSION_ID: thread.id, PI_SESSION_ID: thread.id, PI_SESSION_FILE: thread.sessionFile, PI_THREAD_DATABASE: scope.storage.databasePath,
          ...(typeof thread.metadata?.meetingId === "string" ? { PI_REMOTE_MEETING_ID: thread.metadata.meetingId } : {}),
          ...(typeof thread.metadata?.bashTimeoutSeconds === "number" ? { PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS: String(thread.metadata.bashTimeoutSeconds) } : {}),
          ...(thread.metadata?.room ? { PI_REMOTE_ROOM_ID: thread.id } : {}),
        }),
        ...(scope.environment.PI_REMOTE_SERVER_URL ? { prepareMessage: async (thread, message) => {
          const tokenPath = scope.environment.PI_CORE_TOKEN_FILE;
          if (!tokenPath) return failure("unavailable", "Message preparation requires the declared core credential file");
          try {
            const token = readFileSync(runtime.path(tokenPath), "utf8").trim();
            if (!token) return failure("unavailable", "Message preparation credential is empty");
            const response = await fetch(`${scope.environment.PI_REMOTE_SERVER_URL}/v1/core/prepare-message`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ thread, message }), signal: AbortSignal.timeout(30_000) });
            const result = await response.json() as Result<{ text: string; images?: unknown[] }>;
            if (!response.ok || typeof result?.ok !== "boolean") return failure("unavailable", `Message preparation returned HTTP ${response.status}`);
            return result;
          } catch (cause) { return failure("unavailable", `Message preparation unavailable: ${cause instanceof Error ? cause.message : String(cause)}`); }
        } } : {}),
        managerNotificationPolicy: () => ({ ok: true, value: scope.manager.kind === "existing" ? { view: "mono", managerThreadId: scope.manager.threadId } : { view: "classic" } }),
      });
      if (scope.manager.kind === "existing") {
        const manager = threads.get(scope.manager.threadId);
        if (!manager || manager.metadata?.manager !== true) throw new Error("Declared manager does not match the existing canonical thread");
      }
      const unsubscribe = threads.subscribe(event => this.changed(scope.id, event));
      this.owners.set(scope.id, { scope, threads, runtime, ownership: ownership.value, unsubscribe, capability });
      this.publish(scope.id, { type: "resync" });
      return { ok: true, value: undefined };
    } catch (cause) {
      if (threads) await threads.detach();
      runtime.detach();
      ownership.value.close();
      return { ok: false, error: { code: "unavailable", message: `Scope ${scope.id} adoption failed: ${cause instanceof Error ? cause.message : String(cause)}` } };
    }
  }
  get url(): string { return `http://${this.config.host === "::1" ? "[::1]" : this.config.host}:${this.config.port}`; }
  private cursor(scopeId: string): number {
    const active = this.cursors.get(scopeId);
    if (active) return active.current;
    return Number((this.db.prepare("SELECT coalesce((SELECT cursor FROM core_scope_cursor WHERE scope_id=?),0) AS cursor").get(scopeId) as { cursor: number }).cursor);
  }
  private changed(scopeId: string, event: ThreadServiceEvent): void {
    if ("event" in event) this.publish(scopeId, { type: "event", threadId: event.threadId, event: event.event });
    else this.publish(scopeId, { type: "thread", threadId: event.threadId });
  }
  private publish(scopeId: string, change: CoreEvent["change"]): void {
    let state = this.cursors.get(scopeId);
    if (!state || state.current === state.ceiling) {
      // Reserve a restart-safe cursor range without fsync on every streamed token.
      const previous = this.cursor(scopeId);
      if (!Number.isSafeInteger(previous + 65_536)) throw new Error("Core event cursor exhausted");
      state = { current: previous, ceiling: previous + 65_536 };
      this.db.prepare("INSERT INTO core_scope_cursor(scope_id,cursor) VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET cursor=excluded.cursor").run(scopeId, state.ceiling);
      this.cursors.set(scopeId, state);
    }
    const cursor = ++state.current;
    for (const listener of this.listeners.get(scopeId) ?? []) listener({ cursor, change });
  }
  private identity(request: Request, scopeId?: string): Result<Identity> {
    const bearer = request.headers.get("authorization");
    const token = request.headers.get("x-pi-thread-token");
    const owner = scopeId ? this.owners.get(scopeId) : undefined;
    let credential: CoreConfig["credentials"][number] | undefined;
    if (bearer !== null) {
      if (!bearer.startsWith("Bearer ") || bearer.length <= 7) return failure("invalid_request", "Invalid core credential");
      const hash = createHash("sha256").update(bearer.slice(7)).digest("hex");
      credential = this.config.credentials.find(candidate => candidate.sha256 === hash);
      if (!credential) return failure("invalid_request", "Unknown core credential");
      if (scopeId && !credential.scopeIds.includes(scopeId)) return failure("invalid_request", "Credential does not bind this scope");
    }
    if (token !== null) {
      if (!owner) return failure("invalid_request", "Thread capabilities require an adopted scope");
      const sources = [...this.owners.values()].flatMap(candidate => {
        const threadId = candidate.capability.verify(token);
        return threadId && candidate.threads.get(threadId) ? [{ candidate, threadId }] : [];
      });
      if (sources.length !== 1) return failure("invalid_request", "Thread capability has no unique adopted owner");
      const source = sources[0]!;
      if (credential && credential.principalId !== source.candidate.scope.principalId) return failure("invalid_request", "Credential and thread capability name different principals");
      const principal = this.config.principals.find(principal => principal.id === source.candidate.scope.principalId)!;
      return { ok: true, value: { principal, scopeIds: this.config.scopes.filter(scope => authorize(this.config.policy, { principal, resource: scope.resource, action: "read", now: Date.now() }).ok).map(scope => scope.id), caller: { kind: "thread", threadId: source.threadId } } };
    }
    if (!credential) return failure("invalid_request", "An authenticated core credential is required");
    const principal = this.config.principals.find(principal => principal.id === credential.principalId)!;
    return { ok: true, value: { principal, scopeIds: credential.scopeIds, caller: credential.purpose === "person" ? { kind: "person", via: "upstream" } : { kind: "service", pid: process.pid } } };
  }
  authenticate(request: Request): Result<Principal> {
    const identity = this.identity(request);
    return identity.ok ? { ok: true, value: identity.value.principal } : identity;
  }
  authorizeScope(request: Request, scopeId: string, resource: Resource, actions: readonly PermissionAction[]): CoreResult<void> {
    const identity = this.identity(request, scopeId);
    if (!identity.ok) return { ok: false, error: { code: "unavailable", message: identity.error.message } };
    if (!identity.value.scopeIds.includes(scopeId)) return { ok: false, error: { code: "unavailable", message: "Credential does not bind requested scope" } };
    for (const action of actions) {
      const grant = authorize(this.config.policy, { principal: identity.value.principal, resource, action, now: Date.now() });
      if (!grant.ok) return { ok: false, error: { code: "unavailable", message: grant.error.message } };
    }
    return { ok: true, value: undefined };
  }
  projection(scopeId: string, ids: readonly string[]): Result<CoreProjection> {
    const owner = this.owners.get(scopeId);
    if (!owner) return failure("unavailable", "Scope is not adopted");
    const threads = new Map(owner.threads.snapshot({ archived: false }).map(thread => [thread.id, thread]));
    for (const id of ids) { const thread = owner.threads.get(id); if (thread) threads.set(id, thread); }
    const pending: CoreProjection["pending"] = {}, inputs: CoreProjection["inputs"] = {}, settlements: CoreProjection["settlements"] = {}, live: CoreProjection["live"] = {};
    for (const thread of threads.values()) {
      pending[thread.id] = owner.threads.pending(thread.id).map(message => ({ ...message, insertedAt: message.insertedAt ?? undefined, landedAt: message.landedAt ?? undefined }));
      inputs[thread.id] = owner.threads.inputStates(thread.id);
      const current = owner.threads.live(thread.id);
      if (current) live[thread.id] = structuredClone(current);
      const settlement = owner.threads.latestSettlement(thread.id);
      if (settlement) settlements[thread.id] = settlement;
    }
    return { ok: true, value: { cursor: this.cursor(scopeId), threads: [...threads.values()], archivedTotal: owner.threads.archivedCount(), pending, inputs, settlements, live, managerThreadId: owner.scope.manager.kind === "existing" ? owner.scope.manager.threadId : null } };
  }
  async request(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: this.state === "serving", service: "pi-stack-core", scopes: this.owners.size });
    const match = /^\/v1\/scopes\/([^/]+)\/(projection|events|update|thread-owner(?:\/.*)?)$/.exec(url.pathname);
    if (!match) return undefined;
    let scopeId: string;
    try { scopeId = decodeURIComponent(match[1]!); } catch { return jsonError(400, "Invalid scope identifier"); }
    const scope = this.config.scopes.find(scope => scope.id === scopeId);
    if (!scope) return jsonError(404, "Unknown scope");
    if (this.state !== "serving") return jsonError(503, "Core controller is draining");
    const identity = this.identity(request, scopeId);
    if (!identity.ok) return jsonError(401, identity.error.message);
    const route = match[2]!;
    const operation = route.startsWith("thread-owner/") ? route.slice("thread-owner/".length) : route;
    const permission = authorize(this.config.policy, { principal: identity.value.principal, resource: scope.resource, action: route === "projection" || route === "events" ? "read" : operationAction(operation), now: Date.now() });
    if (!permission.ok) return jsonError(403, permission.error.message);
    const owner = this.owners.get(scopeId);
    if (!owner) return jsonError(503, "Scope custody is unavailable; no replacement store was created");
    if (route === "projection") {
      if (request.method !== "GET") return jsonError(405, "Use GET");
      return Response.json(this.projection(scopeId, (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)));
    }
    if (route === "events") {
      if (request.method !== "GET") return jsonError(405, "Use GET");
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) return jsonError(400, "Event cursor must be a nonnegative integer");
      const listeners = this.listeners.get(scopeId) ?? new Set<(event: CoreEvent) => void>();
      this.listeners.set(scopeId, listeners);
      let remove: () => void = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start: controller => {
          const send = (event: CoreEvent) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ ok: true, value: event })}\n`));
          const listener = (event: CoreEvent) => {
            if ((controller.desiredSize ?? 0) <= 0) { remove(); controller.close(); return; }
            try { send(event); } catch { remove(); }
          };
          remove = () => { listeners.delete(listener); request.signal.removeEventListener("abort", abort); };
          const abort = () => { remove(); try { controller.close(); } catch {} };
          listeners.add(listener);
          request.signal.addEventListener("abort", abort, { once: true });
          send({ cursor: this.cursor(scopeId), change: { type: "resync" } });
          if (request.signal.aborted) abort();
        },
        cancel: () => remove(),
      }, { highWaterMark: 128 });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
    }
    if (route === "update") {
      if (request.method !== "POST") return jsonError(405, "Use POST");
      let input: any;
      try { input = await request.json(); } catch { return jsonError(400, "Expected JSON update"); }
      if (!input || typeof input.threadId !== "string" || !input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)
        || Object.keys(input.patch).some(key => key !== "metadata" && key !== "title")
        || input.patch.title !== undefined && typeof input.patch.title !== "string"
        || input.patch.metadata !== undefined && (!input.patch.metadata || typeof input.patch.metadata !== "object" || Array.isArray(input.patch.metadata))) return jsonError(400, "Update requires threadId and metadata/title patch");
      if (identity.value.caller.kind === "thread") return jsonError(403, "Agents use their authenticated thread control API");
      return Response.json(owner.threads.update(input.threadId, input.patch));
    }
    const resolver = callerResolver({ capability: owner.capability });
    const peers = [...this.owners.values()].filter(candidate => identity.value.scopeIds.includes(candidate.scope.id)
      && authorize(this.config.policy, { principal: identity.value.principal, resource: candidate.scope.resource, action: operationAction(operation), now: Date.now() }).ok);
    const api: ThreadApi = peers.length > 1 ? new ThreadDirectory({ id: scopeId, api: owner.threads }, peers.filter(candidate => candidate !== owner).map(candidate => ({ id: candidate.scope.id, api: candidate.threads }))) : owner.threads;
    return threadHttp(api, request, `/v1/scopes/${encodeURIComponent(scopeId)}/thread-owner`, (operation, input) => resolver.admit(operation, input, identity.value.caller));
  }
  async close(): Promise<CoreResult<void>> {
    if (this.state === "closed") return { ok: true, value: undefined };
    this.state = "draining";
    for (const owner of this.owners.values()) owner.threads.suspend();
    const results = await Promise.all([...this.owners.values()].map(async owner => {
      if ("register" in owner.runtime) owner.runtime.detach();
      const detached = await owner.threads.detach();
      if (!detached.ok) return { ok: false as const, error: { code: "unavailable" as const, message: `${owner.scope.id}: ${detached.error.message}` } };
      owner.unsubscribe(); owner.runtime.detach(); owner.ownership.close();
      this.owners.delete(owner.scope.id);
      return { ok: true as const, value: undefined };
    }));
    const failed = results.find(result => !result.ok);
    if (failed) return failed;
    this.owners.clear(); this.db.close(); this.state = "closed";
    return { ok: true, value: undefined };
  }
}
