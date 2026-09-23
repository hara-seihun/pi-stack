import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../src/store.js";
import type { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { installProviderOperations, runProviderOperation, type ProviderOperation } from "../src/extension/provider-operation.js";
import * as codexUsage from "../src/meters-codex.js";

const usage = { input: 9, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  const store = Store.open(":memory:"); stores.push(store);
  for (const id of ["openai-codex-2", "openai-codex-3"]) store.upsertAccount({ id, provider: "openai-codex" });
  let generation = 0;
  const auth = {
    resolve: vi.fn(async (account: string) => ({ apiKey: `${account}:token-${generation}` })),
    credential: vi.fn(async (account: string) => ({ type: "oauth", access: `${account}:token-${generation}`, accountId: "account", expires: Date.now() + 3_600_000 })),
    refreshRejected: vi.fn(async () => { generation++; }),
    has: () => true,
  };
  const request: ProviderOperation = {
    model: { api: "openai-codex-responses", provider: "openai-codex-2", id: "gpt-6-luna" } as ProviderOperation["model"],
    signal: new AbortController().signal, sessionId: "fixture-session", purpose: "compaction", handled: true, resolve() {},
    run: vi.fn(async () => ({ ok: true as const, value: "checkpoint", usage })),
  };
  vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "0");
  vi.stubEnv("PI_ORCHESTRATOR_RUN_ID", "");
  return { store, auth, request, run: () => runProviderOperation(request, store, auth as unknown as SharedOAuthAuth, request.signal) };
}

test("nested operation refreshes the exact refused credential once and records successful usage", async () => {
  const f = fixture();
  f.request.run = vi.fn(async (_model, options) => options?.apiKey?.endsWith("token-0") ? { ok: false as const, error: "401 token expired" } : { ok: true as const, value: "checkpoint", usage });
  const result = await f.run();
  expect(result.ok).toBe(true);
  expect(f.auth.refreshRejected).toHaveBeenCalledTimes(1);
  expect(f.auth.refreshRejected.mock.calls[0]).toEqual(["openai-codex-2", "openai-codex-2:token-0", f.request.signal]);
  expect(f.request.run).toHaveBeenCalledTimes(2);
  expect(f.store.activeLeases()).toHaveLength(0);
  expect(f.store.db.prepare("SELECT SUM(tokens) n FROM usage_hour").get()).toEqual({ n: 12 });
});

test.each(["repaired", "still-rejected", "usage-healthy"])("compaction uses corroborated 404 repair once: %s", async kind => {
  const f = fixture();
  f.request.model.baseUrl = "https://chatgpt.com/backend-api";
  const probe = vi.spyOn(codexUsage, "fetchCodexUsage").mockImplementation(async () => {
    if (kind === "usage-healthy") return [];
    throw new codexUsage.CodexUnauthorizedError(404);
  });
  f.request.run = vi.fn(async (_model, options) => kind === "repaired" && options?.apiKey?.endsWith("token-1")
    ? { ok: true as const, value: "checkpoint", usage }
    : { ok: false as const, error: "Not Found" });
  const result = await f.run();
  expect(result.ok).toBe(kind === "repaired");
  expect(probe).toHaveBeenCalledOnce();
  expect(probe.mock.calls[0][0]).toBe("openai-codex-2:token-0");
  expect(f.auth.refreshRejected).toHaveBeenCalledTimes(kind === "usage-healthy" ? 0 : 1);
  expect(f.request.run).toHaveBeenCalledTimes(kind === "usage-healthy" ? 1 : 2);
  expect(f.store.activeLeases()).toHaveLength(0);
});

test("interactive rate limits choose another alias without changing the model", async () => {
  const f = fixture();
  f.request.run = vi.fn(async model => {
    expect(model.id).toBe("gpt-6-luna");
    expect(f.store.activeLeases(model.provider)).toHaveLength(1);
    return model.provider === "openai-codex-2" ? { ok: false as const, error: "429 rate limit" } : { ok: true as const, value: "checkpoint", usage };
  });
  expect((await f.run()).ok).toBe(true);
  expect(f.request.run).toHaveBeenCalledTimes(2);
  expect(f.store.account("openai-codex-2")!.cooldownUntil).toBeGreaterThan(Date.now());
  expect(f.store.db.prepare("SELECT DISTINCT account_id FROM usage_hour").all()).toEqual([{ account_id: "openai-codex-3" }]);
  expect(f.store.activeLeases()).toHaveLength(0);
});

test("fleet operation stays inside its assigned account and does not end the parent lease", async () => {
  const f = fixture();
  vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "1");
  vi.stubEnv("PI_ORCHESTRATOR_RUN_ID", "fixture-run");
  f.store.createLease("run:fixture-run", "openai-codex-2", "fleet");
  f.request.run = vi.fn(async () => {
    expect(f.store.activeLeases()).toHaveLength(1);
    return { ok: false as const, error: "429 rate limit" };
  });
  expect((await f.run()).ok).toBe(false);
  expect(f.request.run).toHaveBeenCalledTimes(1);
  expect(f.store.activeLeases().map(lease => lease.id)).toEqual(["run:fixture-run"]);
});

test("broker leaves deadline ownership with the caller and drains leases on shutdown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let receive!: (request: ProviderOperation) => void;
  let shutdown!: () => Promise<void>;
  const unsubscribe = vi.fn();
  const pi = {
    events: { on(_name: string, handler: typeof receive) { receive = handler; return unsubscribe; } },
    on(_name: string, handler: typeof shutdown) { shutdown = handler; },
  };
  installProviderOperations(pi as any, f.store, new Map([["openai-codex", f.auth as unknown as SharedOAuthAuth]]));
  f.request.handled = false;
  f.request.resolve = vi.fn();
  f.request.run = vi.fn(async (_model, options) => await new Promise<Awaited<ReturnType<ProviderOperation["run"]>>>(resolve => {
    options!.signal.addEventListener("abort", () => resolve({ ok: false, error: "Request was aborted", usage }), { once: true });
  }));
  receive(f.request);
  await vi.advanceTimersByTimeAsync(180_001);
  expect(f.request.resolve).not.toHaveBeenCalled();
  expect(f.store.activeLeases()).toHaveLength(1);
  await shutdown();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(f.request.resolve).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "Provider operation stopped by session shutdown", usage });
  expect(f.store.activeLeases()).toHaveLength(0);
  expect(f.store.db.prepare("SELECT SUM(tokens) n FROM usage_hour").get()).toEqual({ n: 12 });
});

test("abort and thrown callbacks always release operation leases", async () => {
  const f = fixture();
  f.request.run = vi.fn(async () => { throw new Error("transport failed"); });
  expect(await f.run()).toEqual({ ok: false, error: "transport failed" });
  expect(f.store.activeLeases()).toHaveLength(0);
  const controller = new AbortController(); controller.abort(); f.request.signal = controller.signal;
  expect(await f.run()).toEqual({ ok: false, error: "Provider operation aborted" });
  expect(f.request.run).toHaveBeenCalledTimes(1);
});
