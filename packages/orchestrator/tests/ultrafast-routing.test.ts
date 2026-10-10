import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import { nativeProviders } from "../src/models.js";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { Fleet } from "../src/fleet.js";
import routing, { resolveSessionModel } from "../src/extension/routing.js";
import { providerOAuth, sharedOAuthProvider } from "../src/auth/shared-oauth.js";
import { withCodexTierGuard } from "../src/auth/codex-tier-provider.js";
import type { PiSessionOptions, Thread } from "../src/threads/contracts.js";
import { ThreadService } from "../src/threads/service.js";
import { modelBrokerUrl } from "../src/model-broker-contract.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const codex = nativeProviders.find(provider => provider.id === "openai-codex")!;
const astra = codex.getModels().find(model => model.id === "gpt-6-astra")!;
const sol = codex.getModels().find(model => model.id === "gpt-6.1-sol")!;
const unsupported = "openai-codex-1", entitled = "openai-codex-2";
const thread: Thread = {
  id: "ultrafast-thread", parentId: null, title: "work", cwd: "/tmp", sessionFile: "/tmp/ultrafast-thread.jsonl",
  settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "ultrafast" }, admission: "force",
  lifecycle: { kind: "idle" }, state: "running", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1,
};

function fixture(model = astra) {
  const root = mkdtempSync(join(tmpdir(), "ultrafast-routing-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ledger = join(root, "ledger.sqlite3"), authPath = join(root, "auth.json");
  const store = Store.open(ledger);
  cleanups.push(() => store.close());
  const tokens = new Map<string, string>();
  const grants = new Set([entitled]);
  for (const id of [unsupported, entitled]) {
    store.upsertAccount({ id, provider: "openai-codex", concurrency: 2 });
    tokens.set(id, `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`);
  }
  writeFileSync(authPath, JSON.stringify(Object.fromEntries([...tokens].map(([id, access]) => [id,
    { type: "oauth", access, refresh: `refresh-${id}`, accountId: id, expires: Date.now() + 3_600_000 }]))));
  const catalogs = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(url)).pathname).toBe("/backend-api/codex/models");
    expect(init?.method).toBe("GET");
    const id = new Headers(init?.headers).get("chatgpt-account-id")!;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${tokens.get(id)}`);
    return Response.json({ models: [{ slug: model.id, service_tiers: [{ id: "priority" }, ...(grants.has(id) ? [{ id: "ultrafast" }] : [])] }] });
  });
  vi.stubGlobal("fetch", catalogs);
  const env = { PI_ORCHESTRATOR_LEDGER: ledger, PI_ORCHESTRATOR_AUTH: authPath,
    PI_ORCHESTRATOR_CONFIG: join(root, "missing-config.json"), PI_THREAD_SPEED: "ultrafast", PI_ORCHESTRATOR_ASSIGNED: "0" };
  const models = [model, ...[unsupported, entitled].map(provider => ({ ...model, provider }))];
  const settings = { ...thread.settings, model: `openai-codex/${model.id}` };
  const auth = providerOAuth(codex, authPath);
  return { store, auth, authPath, tokens, grants, catalogs, env, models, settings };
}

function fleetFor(f: ReturnType<typeof fixture>) {
  return new Fleet(f.store, { ...loadConfig(f.env.PI_ORCHESTRATOR_CONFIG), authPath: f.authPath });
}

function routingHarness(f: ReturnType<typeof fixture>, account: string) {
  for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value);
  vi.stubEnv("PI_MODEL_BROKER_URL", undefined);
  vi.stubEnv("PI_SUBAGENT_MODEL", undefined);
  vi.stubEnv("PI_ORCHESTRATOR_RUN_ID", undefined);
  vi.stubEnv("PI_ORCHESTRATOR_ACCOUNT_ID", undefined);
  const events = new Map<string, ((event: any, ctx: any) => any)[]>();
  const ctx = { model: { ...astra, provider: account }, ui: { notify: vi.fn() },
    modelRegistry: { refresh: vi.fn(async () => {}) }, sessionManager: { getSessionId: () => "ultrafast-test", getBranch: () => [] } };
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerProvider(_provider: Provider) {}, registerTool() {}, events: { on: () => () => {} },
    getActiveTools: () => [], setActiveTools() {}, appendEntry() {}, getThinkingLevel: () => "high", setThinkingLevel() {},
    setModel: vi.fn(async (model: typeof ctx.model) => { ctx.model = model; return true; }),
  };
  routing(pi as never);
  const emit = async (name: string, event: unknown = {}) => {
    const replies = [];
    for (const handler of events.get(name) ?? []) replies.push(await handler(event, ctx));
    return replies;
  };
  cleanups.push(async () => { await emit("session_shutdown"); });
  return { ctx, pi, emit };
}

test("a tier-only configured route leaves default and priority local while routing Ultrafast", () => {
  const f = fixture();
  const endpoint = "http://127.0.0.1:2462";
  writeFileSync(f.env.PI_ORCHESTRATOR_CONFIG, JSON.stringify({ ultrafastModelBrokerUrl: endpoint }));
  const env = { PI_ORCHESTRATOR_CONFIG: f.env.PI_ORCHESTRATOR_CONFIG };
  expect(modelBrokerUrl(env)).toBeUndefined();
  expect(modelBrokerUrl({ ...env, PI_THREAD_SPEED: "standard" })).toBeUndefined();
  expect(modelBrokerUrl({ ...env, PI_THREAD_SPEED: "priority" })).toBeUndefined();
  expect(modelBrokerUrl({ ...env, PI_THREAD_SPEED: "ultrafast" })).toBe(endpoint);
  expect(modelBrokerUrl({ ...env, PI_THREAD_SPEED: "ultrafast", PI_CODEX_ULTRAFAST_BROKER_URL: "http://127.0.0.1:2463" })).toBe("http://127.0.0.1:2463");
});

test("fleet routes only Ultrafast to tier-only broker custody without local accounts and releases on settlement", async () => {
  const store = Store.open(":memory:");
  cleanups.push(() => store.close());
  const endpoint = "http://127.0.0.1:2462";
  const fleet = new Fleet(store, { ...loadConfig("/missing", undefined, {}), ultrafastModelBrokerUrl: endpoint });
  const admitted = await fleet.admit(thread, thread.settings, false, "broker-ultra");
  expect(admitted).toMatchObject({ ok: true, value: { env: { PI_MODEL_BROKER_URL: endpoint } } });
  expect(store.accounts()).toEqual([]);
  expect(store.activeLeases()).toEqual([]);
  expect(store.control("broker-execution:broker-ultra")).toBe(thread.id);
  expect(await fleet.admit({ ...thread, id: "standard" }, { ...thread.settings, speed: "standard" }, false, "local-standard"))
    .toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(store.control("broker-execution:local-standard")).toBeUndefined();
  fleet.event(thread.id, { type: "thread_settled", executionId: "broker-ultra", outcome: "complete" });
  expect(store.control("broker-execution:broker-ultra")).toBeUndefined();
  if (admitted.ok) await admitted.value.release();
});

test.each(["cerebras/gpt-oss-120b", "openai-codex/gpt-6-luna", "private/gpt-6.1-sol"])("fleet refuses %s Ultrafast before acquiring broker custody", async model => {
  const store = Store.open(":memory:");
  cleanups.push(() => store.close());
  const fleet = new Fleet(store, { ...loadConfig("/missing", undefined, {}), ultrafastModelBrokerUrl: "http://127.0.0.1:2462" });
  const settings = { ...thread.settings, model };
  expect(await fleet.admit({ ...thread, settings }, settings, false, "invalid-ultra"))
    .toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(store.control("broker-execution:invalid-ultra")).toBeUndefined();
  expect(store.activeLeases()).toEqual([]);
});

test("tier-only routes reject nonloopback addresses from configuration and environment", () => {
  const f = fixture();
  writeFileSync(f.env.PI_ORCHESTRATOR_CONFIG, JSON.stringify({ ultrafastModelBrokerUrl: "http://192.0.2.1:2462" }));
  expect(() => modelBrokerUrl({ PI_ORCHESTRATOR_CONFIG: f.env.PI_ORCHESTRATOR_CONFIG, PI_THREAD_SPEED: "ultrafast" }))
    .toThrow("ultrafastModelBrokerUrl must be http://127.0.0.1:PORT");
  expect(() => loadConfig("/missing", undefined, { PI_CODEX_ULTRAFAST_BROKER_URL: "https://example.com" }))
    .toThrow("ultrafastModelBrokerUrl must be http://127.0.0.1:PORT");
});

test("ThreadService resolves the tier-only endpoint before the runner environment boundary", async () => {
  const f = fixture();
  const root = dirname(f.env.PI_ORCHESTRATOR_CONFIG), endpoint = "http://127.0.0.1:2462";
  const sessions: PiSessionOptions[] = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    environment: () => ({ PI_ORCHESTRATOR_CONFIG: f.env.PI_ORCHESTRATOR_CONFIG, PI_CODEX_ULTRAFAST_BROKER_URL: endpoint }),
    openSession: async (options, output) => {
      sessions.push(options);
      return { isStreaming: false, pendingMessageCount: 0,
        command: async command => { output({ type: "response", id: command.id, command: command.type, success: true,
          data: command.type === "get_state" ? { isStreaming: false, pendingMessageCount: 0, sessionFile: options.sessionFile, acceptedWorkIds: [], completedWorkIds: [] } : {} }); },
        close: async () => {},
      };
    },
  });
  cleanups.push(async () => { await service.close(); });
  await service.start();
  for (const speed of ["standard", "ultrafast"] as const) {
    expect((await service.spawn({ requestId: speed, id: speed, cwd: root, message: "hello", settings: { model: "astra", speed } })).ok).toBe(true);
  }
  await vi.waitFor(() => expect(sessions).toHaveLength(2), { timeout: 1_000, interval: 5 });
  expect(sessions.find(session => session.threadId === "standard")!.env.PI_MODEL_BROKER_URL).toBeUndefined();
  expect(sessions.find(session => session.threadId === "ultrafast")!.env.PI_MODEL_BROKER_URL).toBe(endpoint);
  expect(sessions.find(session => session.threadId === "ultrafast")!.env.PI_THREAD_SPEED).toBe("ultrafast");
});

test.each([astra, sol])("direct canonical $id Ultrafast selection chooses the sole entitled account", async model => {
  const f = fixture(model);
  const result = await resolveSessionModel(f.models, "openai-codex", model.id, f.env);
  expect(result).toEqual({ ok: true, model: f.models.find(model => model.provider === entitled) });
  expect(f.catalogs).toHaveBeenCalledTimes(2);
});

test.each([astra, sol].flatMap(model => ["explicit", "assigned"].map(pin => ({ model, pin }))))("an unentitled $pin $model.id account pin is refused rather than silently moved", async ({ model, pin }) => {
  const f = fixture(model);
  const result = await resolveSessionModel(f.models, pin === "explicit" ? unsupported : "openai-codex", model.id,
    { ...f.env, ...(pin === "assigned" ? { PI_ORCHESTRATOR_ASSIGNED: "1", PI_ORCHESTRATOR_ACCOUNT_ID: unsupported } : {}) });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("advertising ultrafast") });
});

test.each([astra, sol])("direct $id Ultrafast refuses a pool with no advertising account", async model => {
  const f = fixture(model);
  f.grants.clear();
  expect(await resolveSessionModel(f.models, "openai-codex", model.id, f.env))
    .toMatchObject({ ok: false, error: expect.stringContaining("advertising ultrafast") });
});

test.each([astra, sol])("fleet $id admission excludes an unsupported account even when it has more remaining quota", async model => {
  const f = fixture(model);
  f.store.recordMeter(unsupported, "codex-7d", 0, Date.now() + 60_000);
  f.store.recordMeter(entitled, "codex-7d", 90, Date.now() + 60_000);
  const admitted = await fleetFor(f).admit({ ...thread, settings: f.settings }, f.settings, false, "work");
  expect(admitted).toMatchObject({ ok: true, value: { env: { PI_ORCHESTRATOR_ACCOUNT_ID: entitled } } });
  expect(f.store.activeLeases().map(lease => lease.account_id)).toEqual([entitled]);
  if (admitted.ok) await admitted.value.release();
  expect(f.store.activeLeases()).toEqual([]);
});

test.each(["quota", "reservation"])("fleet Ultrafast entitlement does not bypass %s or fall back to an unsupported account", async exclusion => {
  const f = fixture();
  if (exclusion === "quota") f.store.recordMeter(entitled, "codex-7d", 100, Date.now() + 60_000);
  else f.store.setControl(`account-reservation:${entitled}`, JSON.stringify({ metadata: { queue: "private" }, reason: "reserved queue" }));
  const result = await fleetFor(f).admit(thread, thread.settings, false, "refused");
  expect(result).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("requested service tier unavailable") } });
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(exclusion === "quota" ? "provider quota exhausted" : "reserved capacity") } });
  expect(f.store.activeLeases()).toEqual([]);
});

test.each([astra, sol])("fleet $id recovery refuses a recorded account that no longer advertises Ultrafast", async model => {
  const f = fixture(model);
  f.store.createLease("thread:recovery", unsupported, "fleet", thread.id);
  const result = await fleetFor(f).admit({ ...thread, settings: f.settings }, f.settings, true, "recovery");
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("does not currently advertise ultrafast") } });
});

test.each([astra, sol].flatMap(model => (["stream", "streamSimple"] as const).map(method => ({ requested: model, method }))))("the final $method $requested.id payload hook cannot dispatch Ultrafast on an unentitled account", async ({ requested, method }) => {
  const f = fixture(requested);
  const provider = withCodexTierGuard(sharedOAuthProvider(codex, unsupported, undefined, f.auth), f.store, f.auth, unsupported);
  const model = provider.getModels().find(model => model.id === requested.id)!;
  const inference = vi.fn(async () => new Response("should not dispatch"));
  const hook = vi.fn((payload: unknown) => ({ ...(payload as object), service_tier: "ultrafast" }));
  const result = await provider[method](model, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }),
    { apiKey: f.tokens.get(unsupported), transport: "sse", maxRetries: 0, onPayload: hook, fetch: inference as unknown as typeof fetch }).result();
  expect(hook).toHaveBeenCalledOnce();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("does not advertise");
  expect(f.catalogs).toHaveBeenCalledOnce();
  expect(inference).not.toHaveBeenCalled();
});

test.each([astra, sol])("the final $id wire guard preserves Ultrafast for an entitled account", async requested => {
  const f = fixture(requested);
  const provider = withCodexTierGuard(sharedOAuthProvider(codex, entitled, undefined, f.auth), f.store, f.auth, entitled);
  const model = provider.getModels().find(model => model.id === requested.id)!;
  const inference = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const bytes = new Headers(init?.headers).get("content-encoding") === "zstd"
      ? zstdDecompressSync(init!.body as Uint8Array).toString("utf8") : String(init?.body);
    expect(JSON.parse(bytes)).toMatchObject({ model: requested.id, service_tier: "ultrafast" });
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "response", status: "completed", output: [], usage: {} } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  });
  const result = await provider.stream(model, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }),
    { apiKey: f.tokens.get(entitled), transport: "sse", maxRetries: 0, onPayload: payload => ({ ...(payload as object), service_tier: "ultrafast" }), fetch: inference as unknown as typeof fetch }).result();
  expect(result.errorMessage).toBeUndefined();
  expect(inference).toHaveBeenCalledOnce();
});

test("startup refuses an unavailable requested tier rather than retaining another model", async () => {
  const f = fixture();
  f.grants.clear();
  const h = routingHarness(f, "openai-codex");
  await expect(h.emit("session_start")).rejects.toThrow("No eligible pooled account");
  expect(h.ctx.model.id).toBe(astra.id);
  expect(h.pi.setModel).not.toHaveBeenCalled();
});

test.each(["session_start", "before_agent_start"])("%s refuses Cerebras Ultrafast before account selection", async event => {
  const f = fixture();
  const h = routingHarness(f, "cerebras");
  h.ctx.model.id = "gpt-oss-120b";
  await expect(h.emit(event)).rejects.toThrow("Ultrafast speed requires OpenAI Codex Astra or Sol");
  expect(f.catalogs).not.toHaveBeenCalled();
  expect(h.pi.setModel).not.toHaveBeenCalled();
});

test("explicit Cerebras standard startup remains on the requested provider", async () => {
  const f = fixture();
  const h = routingHarness(f, "cerebras");
  vi.stubEnv("PI_THREAD_SPEED", "standard");
  h.ctx.model.id = "gpt-oss-120b";
  await h.emit("session_start");
  expect(h.ctx.model.provider).toBe("cerebras");
  expect(f.catalogs).not.toHaveBeenCalled();
  expect(h.pi.setModel).not.toHaveBeenCalled();
});

test("direct rate-limit failover does not move Ultrafast onto an unentitled sibling", async () => {
  const f = fixture();
  const h = routingHarness(f, entitled);
  await h.emit("agent_end", { messages: [{ role: "assistant", provider: entitled, model: astra.id, stopReason: "error", errorMessage: "429 Too Many Requests" }] });
  expect(h.ctx.model.provider).toBe(entitled);
  expect(h.pi.setModel).not.toHaveBeenCalled();
  expect(await h.emit("agent_before_settle")).not.toContainEqual(expect.objectContaining({ continue: true }));
});
