import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadApi, Thread, ThreadInspection, ThreadMessage, ThreadSettlement, PiEvent, Result, BrokerUsage, PersonUsageWindow } from "pi-orchestrator/api";
import type { CoreProjection, CoreEvent } from "../../../packages/orchestrator/src/core/contracts";
import type { ManagerReplies, ManagerRepliesInput } from "../../../packages/orchestrator/src/core/manager-replies";

type Change = { threadId: string; event?: PiEvent; live?: Record<string, unknown> };
type Fetch = typeof fetch;
export type ThreadClientFactory = (url: string, fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => ThreadApi;
const failure = (message: string): Result<never> => ({ ok: false, error: { code: "unavailable", message } });

export type CoreClientConfig = { url: string; scopeId: string; principalId: string; gatewayId: string; socketPath: string; coreUid: number; callbackSocket: string };
export type CoreGatewayFetch = (peer: { socketPath: string; peerUid: number }, input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function coreConfiguration(env: NodeJS.ProcessEnv = process.env): Result<CoreClientConfig> {
  if (!env.PI_CORE_URL || !env.PI_CORE_GATEWAY_ID || !env.PI_CORE_SCOPE_ID || !env.PI_CORE_PRINCIPAL_ID || !env.PI_CORE_CALLBACK_SOCKET || env.PI_CORE_CALLBACK_UID === undefined) return failure("Remote requires an explicit host-owned core URL, gateway, scope, principal and kernel-peer callback binding; it cannot host an agent engine");
  try {
    const url = new URL(env.PI_CORE_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return failure("PI_CORE_URL must be an HTTP service URL without credentials, query or fragment");
    if (!/^[a-zA-Z0-9_.:-]+$/.test(env.PI_CORE_GATEWAY_ID) || !/^[a-zA-Z0-9_.:-]+$/.test(env.PI_CORE_SCOPE_ID)) return failure("Core scope and gateway must name their registered host bindings");
    const coreUid = Number(env.PI_CORE_CALLBACK_UID);
    if (!/^(0|[1-9][0-9]*)$/.test(env.PI_CORE_CALLBACK_UID) || !Number.isSafeInteger(coreUid)) return failure("PI_CORE_CALLBACK_UID must explicitly name the core Unix UID");
    if (env.PI_CORE_CALLBACK_SOCKET !== `/run/pi-stack/gateways/remote-${env.PI_CORE_SCOPE_ID}/callback.sock`) return failure("Core callback socket must be the prepared scope-owned gateway path");
    return { ok: true, value: { url: url.toString().replace(/\/$/, ""), scopeId: env.PI_CORE_SCOPE_ID, principalId: env.PI_CORE_PRINCIPAL_ID, gatewayId: env.PI_CORE_GATEWAY_ID, socketPath: `/run/pi-stack/gateways/${env.PI_CORE_GATEWAY_ID}.sock`, coreUid, callbackSocket: env.PI_CORE_CALLBACK_SOCKET } };
  } catch (error) { return failure(`Core configuration unavailable: ${String(error)}`); }
}

export class CoreClient {
  readonly api: ThreadApi;
  private projection: CoreProjection | null = null;
  private cursor = 0;
  private readonly selected = new Set<string>();
  private readonly listeners = new Set<(change: Change) => void>();
  private readonly abort = new AbortController();
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private refresh: Promise<Result<void>> | null = null;
  private readonly base: string;
  private readonly serviceUrl: string;
  private readonly transport: Fetch;
  private readonly caller = new AsyncLocalStorage<{ token: string | null }>();

  constructor(config: CoreClientConfig, threadClient: ThreadClientFactory, fetcher: CoreGatewayFetch, private feedback: (message: string | null) => void = () => {}) {
    if (!/^[a-zA-Z0-9_.:-]+$/.test(config.gatewayId) || config.socketPath !== `/run/pi-stack/gateways/${config.gatewayId}.sock` || !Number.isSafeInteger(config.coreUid) || config.coreUid < 0) throw new Error("Core client requires its explicit registered Unix gateway socket");
    this.serviceUrl = config.url;
    this.base = `${config.url}/v1/scopes/${encodeURIComponent(config.scopeId)}`;
    this.transport = ((input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      // Actor claims never become core authority. The selected Unix socket is
      // verified by SO_PEERCRED and fixes principal, scopes and route ceiling.
      headers.delete("authorization");
      headers.delete("x-pi-kenan-admin");
      const token = this.caller.getStore()?.token;
      if (token) headers.set("x-pi-thread-token", token);
      return fetcher({ socketPath: config.socketPath, peerUid: config.coreUid }, input, { ...init, headers });
    }) as Fetch;
    const client = threadClient(`${this.base}/thread-owner`, this.transport);
    this.api = Object.fromEntries(Object.entries(client).map(([name, call]) => [name, async (...args: unknown[]) => {
      const result = await (call as (...args: unknown[]) => Promise<Result<unknown>>)(...args);
      if (result.ok && ["spawn", "control", "inspect", "managerThread"].includes(name)) {
        const value = result.value as Thread | ThreadInspection | null;
        if (value && "thread" in value) {
          this.remember(value.thread);
          if (this.projection) {
            this.projection.pending[value.thread.id] = value.pending;
            if (value.inputs) this.projection.inputs[value.thread.id] = value.inputs;
          }
        } else if (value) this.remember(value as Thread);
      }
      if (result.ok && ["list", "archived"].includes(name)) {
        const value = result.value as { threads?: Thread[] };
        for (const thread of value.threads ?? []) this.remember(thread);
      }
      return result;
    }])) as unknown as ThreadApi;
  }

  get fetch(): Fetch { return this.transport; }

  withCaller<T>(request: Request, operation: () => T): T {
    return this.caller.run({ token: request.headers.get("x-pi-thread-token") }, operation);
  }

  private remember(thread: Thread) {
    if (thread.metadata?.archived) this.selected.add(thread.id);
    if (!this.projection) return;
    const index = this.projection.threads.findIndex(row => row.id === thread.id);
    if (index < 0) this.projection.threads.push(thread); else this.projection.threads[index] = thread;
  }
  get(id: string): Thread | undefined { return this.projection?.threads.find(thread => thread.id === id); }
  snapshot(options: { archived?: boolean } = {}): Thread[] {
    return (this.projection?.threads ?? []).filter(thread => options.archived === undefined || Boolean(thread.metadata?.archived) === options.archived);
  }
  archivedCount(): number { return this.projection?.archivedTotal ?? 0; }
  pending(id: string): ThreadMessage[] { return this.projection?.pending[id] ?? []; }
  inputStates(id: string) { return this.projection?.inputs[id]; }
  latestSettlement(id: string): ThreadSettlement | undefined { return this.projection?.settlements[id]; }
  live(id: string): Record<string, unknown> { return this.projection?.live[id] ?? { text: "", thinking: "", tools: [] }; }
  managerThreadId(): string | null { return this.projection?.managerThreadId ?? null; }
  subscribe(listener: (change: Change) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async managerReplies(input: ManagerRepliesInput): Promise<Result<ManagerReplies>> {
    try {
      const response = await this.transport(`${this.base}/thread-owner/managerReplies`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) });
      const result = await response.json() as Result<ManagerReplies>;
      if (!response.ok || typeof result?.ok !== "boolean") return failure(`Core manager replies returned HTTP ${response.status}`);
      if (!result.ok) return result;
      const value = result.value;
      if (value.managerThreadId !== this.managerThreadId() || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || !Array.isArray(value.replies) || value.replies.some(reply => typeof reply.id !== "string" || !reply.id || typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > 2000 || reply.id.length > 256 || !["complete", "failed", "cancelled"].includes(reply.outcome) || !Number.isFinite(reply.time))) return failure("Core returned an invalid manager reply projection");
      return result;
    } catch (cause) { return failure(`Core manager replies unavailable: ${String(cause)}`); }
  }

  async peopleUsage(period: "day" | "week"): Promise<Result<PersonUsageWindow>> {
    try {
      const response = await this.transport(`${this.serviceUrl}/v1/providers/people-usage?period=${period}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) { await response.body?.cancel(); return failure(`Core aggregate usage returned HTTP ${response.status}`); }
      const value = await response.json() as PersonUsageWindow;
      if (typeof value?.since !== "string" || typeof value.until !== "string" || !Array.isArray(value.rows) || !Array.isArray(value.subscriptions) || value.rows.some(row => !(row.principal === null || typeof row.principal === "string") || !Number.isFinite(row.tokens) || !Number.isFinite(row.spend) || !Number.isFinite(row.value) || !row.sources?.fleet)) return failure("Core returned invalid aggregate usage");
      return { ok: true, value };
    } catch (cause) { return failure(`Core aggregate usage unavailable: ${String(cause)}`); }
  }

  async usage(): Promise<Result<BrokerUsage>> {
    try {
      const response = await this.transport(`${this.serviceUrl}/v1/model-broker/v1/usage`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) { await response.body?.cancel(); return failure(`Core model usage returned HTTP ${response.status}`); }
      const value = await response.json() as BrokerUsage;
      if (!value?.plans?.plans || typeof value.plans.updatedAt !== "string" || !value.personal?.periods?.day || !value.personal.periods.week || !(value.allowance === null || typeof value.allowance?.weeklyUsd === "number")) return failure("Core returned invalid model usage");
      return { ok: true, value };
    } catch (error) { return failure(`Core model usage unavailable: ${String(error)}`); }
  }

  async forward(request: Request, prefix: string): Promise<Response> {
    const path = new URL(request.url).pathname.slice(prefix.length);
    const headers = new Headers(request.headers);
    headers.delete("host");
    try {
      return await this.transport(`${this.base}/thread-owner${path}`, { method: request.method, headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }), signal: request.signal });
    } catch (error) { return Response.json(failure(`Core request outcome unconfirmed: ${String(error)}`), { status: 503 }); }
  }

  async update(id: string, patch: { metadata?: Record<string, unknown>; title?: string }): Promise<Result<Thread>> {
    try {
      const response = await this.transport(`${this.base}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: id, patch }), signal: AbortSignal.timeout(30_000) });
      const result = await response.json() as Result<Thread>;
      if (typeof result?.ok !== "boolean") return failure(`Core update returned invalid HTTP ${response.status} response; outcome unconfirmed`);
      if (!result.ok) return result;
      if (!response.ok) return failure(`Core update returned HTTP ${response.status}; outcome unconfirmed`);
      this.remember(result.value);
      return result;
    } catch (error) { return failure(`Core update outcome unconfirmed: ${String(error)}`); }
  }

  refreshProjection(): Promise<Result<void>> {
    if (this.refresh) return this.refresh;
    this.refresh = (async (): Promise<Result<void>> => {
      try {
        const ids = [...this.selected].join(",");
        const response = await this.transport(`${this.base}/projection${ids ? `?ids=${encodeURIComponent(ids)}` : ""}`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) });
        const result = await response.json() as Result<CoreProjection>;
        if (!response.ok || !result.ok) return result.ok ? failure(`Core projection returned HTTP ${response.status}`) : result;
        const value = result.value;
        if (!Number.isSafeInteger(value.cursor) || value.cursor < 0 || !Array.isArray(value.threads) || !Number.isSafeInteger(value.archivedTotal) || !value.pending || !value.inputs || !value.settlements || !value.live || typeof value.live !== "object" || Array.isArray(value.live) || !(value.managerThreadId === null || typeof value.managerThreadId === "string")) return failure("Core returned an invalid projection");
        // A concurrent stream may have advanced while this HTTP response was in flight.
        // Never roll a newer visual state back to an older snapshot.
        if (value.cursor < this.cursor) return { ok: true, value: undefined };
        const changedIds = new Set([...(this.projection?.threads ?? []).map(thread => thread.id), ...value.threads.map(thread => thread.id)]);
        this.projection = value;
        this.cursor = value.cursor;
        for (const threadId of changedIds) for (const listener of this.listeners) listener({ threadId, live: this.live(threadId) });
        this.feedback(null);
        return { ok: true, value: undefined };
      } catch (error) { return failure(`Core projection unavailable: ${String(error)}`); }
    })().finally(() => { this.refresh = null; });
    return this.refresh;
  }

  start(): void { void this.consume(); }
  close(): void { this.abort.abort(); if (this.reconnect) clearTimeout(this.reconnect); this.listeners.clear(); }
  private async consume(): Promise<void> {
    try {
      const response = await this.transport(`${this.base}/events?after=${this.cursor}`, { signal: this.abort.signal });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Core events returned HTTP ${response.status}`); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!this.abort.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Core event stream closed");
          pending += decoder.decode(chunk.value, { stream: true });
          if (pending.length > 8 * 1024 * 1024) throw new Error("Core event exceeds the 8 MiB transport limit");
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            const result = JSON.parse(line) as Result<CoreEvent>;
            if (!result.ok) throw new Error(result.error.message);
            const event = result.value;
            if (!Number.isSafeInteger(event?.cursor) || event.cursor < 0 || !event.change || !["thread", "event", "resync"].includes(event.change.type)
              || event.change.type === "event" && (!event.change.event || typeof event.change.event.type !== "string")) throw new Error("Invalid core event");
            if (event.change.type !== "resync" && event.cursor <= this.cursor) continue;
            if (event.change.type !== "event") {
              const refreshed = await this.refreshProjection();
              if (!refreshed.ok) throw new Error(refreshed.error.message);
              if (this.cursor < event.cursor) throw new Error("Core projection precedes its notification cursor");
              continue;
            }
            if (!event.change.threadId) throw new Error("Core event has no thread identity");
            this.cursor = event.cursor;
            for (const listener of this.listeners) listener({ threadId: event.change.threadId, event: event.change.event });
          }
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.feedback(String(error));
      this.reconnect = setTimeout(() => { this.reconnect = null; void this.consume(); }, 1_000);
    }
  }
}
