import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { CODEX_CAPABILITY_TTL_MS, codexTierExclusions, readCodexCapabilities, readCodexTierObservation, refreshCodexCapabilities, requireCodexTier } from "../src/auth/codex-capabilities.js";

const fixtures: { root: string; store: Store }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, store } of fixtures.splice(0)) { if (!store.closed) store.close(); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-capabilities-")), path = join(root, "auth.json");
  const store = Store.open(":memory:");
  const credential = (accountId: string, access = accountId) => ({ type: "oauth" as const, access, refresh: `refresh-${accountId}`, expires: Date.now() + 3_600_000, accountId });
  writeFileSync(path, JSON.stringify({ entitled: credential("entitled"), ordinary: credential("ordinary"), denied: credential("denied"), disabled: credential("disabled") }));
  for (const id of ["entitled", "ordinary", "denied", "disabled", "missing"]) store.upsertAccount({ id, provider: "openai-codex", enabled: id !== "disabled" });
  store.upsertAccount({ id: "anthropic", provider: "anthropic" });
  const auth = new SharedOAuthAuth({ path, providerId: "openai-codex", refresh: async c => c, toAuth: async c => ({ apiKey: c.access }) });
  fixtures.push({ root, store });
  return { store, auth, credential };
}

const catalog = (entitled: boolean, slug = "gpt-6-astra") => Response.json({ models: [{ slug, service_tiers: [{ id: "priority", description: "Not retained" }, ...(entitled ? [{ id: "ultrafast" }] : [])] }] });
const asFetch = (fn: ReturnType<typeof vi.fn>) => fn as unknown as typeof fetch;
const denyOthers = () => new Set(["ordinary", "denied", "disabled", "missing"]);

test.each([undefined, "standard", "default", "priority"])("%s preserves exclusions and existing tier policy without metadata requests", async tier => {
  const { store, auth } = fixture(), excluded = new Set(["denied"]), request = vi.fn();
  expect(await codexTierExclusions(store, auth, "gpt-6-astra", tier, excluded, undefined, asFetch(request))).toBe(excluded);
  expect(await requireCodexTier(store, undefined, "unregistered", "gpt-6-astra", tier)).toEqual({ ok: true, value: { accountId: "unregistered", model: "gpt-6-astra", tier } });
  expect(request).not.toHaveBeenCalled();
});

test("only enabled credential-bearing nonexcluded Codex accounts are read; caller exclusions never widen", async () => {
  const { store, auth } = fixture(), excluded = new Set(["denied"]);
  const request = vi.fn(async (_url: string, init: RequestInit) => catalog(new Headers(init.headers).get("ChatGPT-Account-Id") === "entitled"));
  const result = await codexTierExclusions(store, auth, "gpt-6-astra", "ultrafast", excluded, undefined, asFetch(request));
  expect(result).not.toBe(excluded);
  expect([...excluded]).toEqual(["denied"]);
  expect([...result].sort()).toEqual(["denied", "disabled", "missing", "ordinary"]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.159.0");
  for (const [, init] of request.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(readCodexTierObservation(store, "entitled", "gpt-6-astra", "ultrafast")?.supported).toBe(true);
  expect(readCodexTierObservation(store, "ordinary", "gpt-6-astra", "ultrafast")?.supported).toBe(false);
  expect(readCodexTierObservation(store, "entitled", "gpt-6.1-sol", "ultrafast")?.supported).toBe(false);
  expect(readCodexCapabilities(store, "missing")[0]).toMatchObject({ status: "unknown", fresh: false, ultrafast: null });
  expect(store.control("codex-capabilities:entitled")).not.toContain("Not retained");
});

test("requests single-flight per account, expire after 60s, and invalidate immediately on credential rotation", async () => {
  const { store, auth, credential } = fixture(), request = vi.fn(async (_url: string, _init: RequestInit) => catalog(true));
  const run = () => requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request));
  expect((await Promise.all([run(), run(), run()])).every(result => result.ok)).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  await run(); expect(request).toHaveBeenCalledOnce();
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + CODEX_CAPABILITY_TTL_MS + 1);
  expect(readCodexTierObservation(store, "entitled", "gpt-6-astra", "ultrafast")?.fresh).toBe(false);
  request.mockImplementation(async () => catalog(false));
  expect((await run()).ok).toBe(false); expect(request).toHaveBeenCalledTimes(2);
  await auth.set("entitled", credential("replacement-identity", "new-access"));
  request.mockImplementation(async () => catalog(true));
  expect((await run()).ok).toBe(true); expect(request).toHaveBeenCalledTimes(3);
  expect(new Headers(request.mock.calls[2][1].headers).get("authorization")).toBe("Bearer new-access");
  expect(new Headers(request.mock.calls[2][1].headers).get("ChatGPT-Account-Id")).toBe("replacement-identity");
});

test.each(["http", "network", "malformed"])("%s errors fail closed and persist no response bodies or secret exception text", async kind => {
  const { store, auth } = fixture();
  const request = vi.fn(async () => {
    if (kind === "http") return new Response("secret-response", { status: 403 });
    if (kind === "network") throw new Error("Bearer secret-access-token");
    return Response.json({ models: [{ slug: "gpt-6-astra", service_tiers: "secret-malformed" }] });
  });
  const excluded = await codexTierExclusions(store, auth, "gpt-6-astra", "ultrafast", denyOthers(), undefined, asFetch(request));
  expect(excluded.has("entitled")).toBe(true);
  expect(readCodexTierObservation(store, "entitled", "gpt-6-astra", "ultrafast")).toMatchObject({ supported: undefined, fresh: true, error: kind === "http" ? "http-403" : kind === "network" ? "request-failed" : "invalid-response" });
  expect(store.control("codex-capabilities:entitled")).not.toContain("secret");
});

test("persisted positive evidence is not authorization on process cold start; explicit refresh bypasses memory TTL", async () => {
  const { store, auth } = fixture();
  store.setControl("codex-capabilities:entitled", JSON.stringify({ at: Date.now(), status: "observed", models: { "gpt-6-astra": ["ultrafast"] } }));
  const request = vi.fn(async () => catalog(false));
  expect((await requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request))).ok).toBe(false);
  request.mockImplementation(async () => catalog(true));
  const refreshed = await refreshCodexCapabilities(store, auth, "entitled", undefined, asFetch(request));
  expect(refreshed).toMatchObject([{ accountId: "entitled", status: "observed", ultrafast: { "gpt-6-astra": true } }]);
  expect(request).toHaveBeenCalledTimes(2);
  expect((await requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request))).ok).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});

test("one cancelled waiter cannot cancel another waiter's per-account request", async () => {
  const { store, auth } = fixture(), cancel = new AbortController();
  let release: (response: Response) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const request = vi.fn(() => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
  const a = requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", cancel.signal, asFetch(request));
  await ready;
  const b = requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request));
  cancel.abort();
  expect(await a).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
  release(catalog(true));
  expect((await b).ok).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});

test.each([true, false])("a metadata 401 repairs once through shared OAuth and fences a second rejection, accepted=%s", async accepted => {
  const { store, auth, credential } = fixture();
  const repaired = { ...credential("entitled"), access: "repaired-access" };
  const refresh = vi.spyOn(auth, "refreshRejected").mockImplementation(async () => { await auth.set("entitled", repaired); return repaired; });
  const request = vi.fn(async (_url: string, init: RequestInit) => new Headers(init.headers).get("authorization") === "Bearer repaired-access" && accepted ? catalog(true) : new Response("secret-error", { status: 401 }));
  const result = await requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request));
  expect(result.ok).toBe(accepted);
  expect(refresh).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(2);
  expect(auth.rejection("entitled")?.state).toBe(accepted ? undefined : "login-required");
  if (accepted) {
    expect((await requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request))).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  }
  expect(store.control("codex-capabilities:entitled")).not.toContain("secret");
});

test("shared discovery finishing after owner closure returns an error instead of writing into closed SQLite", async () => {
  const { store, auth } = fixture(), cancel = new AbortController();
  let release: (response: Response) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const request = vi.fn(() => { started(); return new Promise<Response>(resolve => { release = resolve; }); });
  const cancelled = requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", cancel.signal, asFetch(request));
  await ready;
  const surviving = requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request));
  cancel.abort(); await cancelled;
  store.close();
  release(catalog(true));
  expect(await surviving).toMatchObject({ ok: false, error: expect.stringContaining("store-closed") });
});

test("identity derives safely from Codex JWT when absent in credential; malformed identity fails closed", async () => {
  const { store, auth, credential } = fixture();
  const jwt = `head.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account" } })).toString("base64url")}.signature`;
  const { accountId: _, ...value } = credential("entitled", jwt);
  await auth.set("entitled", value);
  const request = vi.fn(async (_url: string, init: RequestInit) => { expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("jwt-account"); return catalog(true); });
  expect((await requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request))).ok).toBe(true);
  await auth.set("entitled", { ...value, access: "malformed" });
  expect(await requireCodexTier(store, auth, "entitled", "gpt-6-astra", "ultrafast", undefined, asFetch(request))).toMatchObject({ ok: false, error: expect.stringContaining("missing-account-id") });
  expect(request).toHaveBeenCalledOnce();
});
