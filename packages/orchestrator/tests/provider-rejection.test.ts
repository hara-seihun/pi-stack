import { expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedOAuthAuth, sharedOAuthProvider } from "../src/auth/shared-oauth.js";
import { normalizeContext, type Provider, type OAuthCredential } from "@earendil-works/pi-ai";
import { isCodexNotFoundError, repairProviderCredential } from "../src/auth/provider-rejection.js";
import { CodexMeterSampler, CodexUnauthorizedError, fetchCodexUsage } from "../src/meters-codex.js";
import { isRejectedTokenError } from "../src/provider-errors.js";
import { Store } from "../src/store.js";

const model = { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };

test("only official Codex bare Not Found errors are credential-check candidates", () => {
  expect(isCodexNotFoundError("Not Found", model)).toBe(true);
  expect(isCodexNotFoundError("HTTP 404: Not Found", { ...model, baseUrl: `${model.baseUrl}/codex/responses` })).toBe(true);
  for (const message of ["404 model missing", "previous_response_id not found", "Model Not Found", "404", "Not Found: unsupported model"]) {
    expect(isCodexNotFoundError(message, model)).toBe(false);
  }
  for (const baseUrl of ["", "https://example.com/backend-api", `${model.baseUrl}/codex/codex/responses`, `${model.baseUrl}?path=missing`]) {
    expect(isCodexNotFoundError("Not Found", { ...model, baseUrl })).toBe(false);
  }
  expect(isCodexNotFoundError("Not Found", { ...model, api: "anthropic-messages" })).toBe(false);
  expect(isRejectedTokenError("Not Found")).toBe(false);
  expect(isRejectedTokenError("HTTP 404")).toBe(false);
});

test("shared provider records the token actually passed to either inference stream", () => {
  const token = vi.fn();
  const stream = vi.fn(() => { expect(token).toHaveBeenLastCalledWith("in-flight-token"); return {} as any; });
  const family = { id: "openai-codex", name: "Codex", auth: {}, getModels: () => [], stream, streamSimple: stream } as unknown as Provider;
  const provider = sharedOAuthProvider(family, "openai-codex-11", undefined, {} as SharedOAuthAuth, token);
  expect(token).not.toHaveBeenCalled();
  for (const send of [provider.stream, provider.streamSimple]) send({} as any, normalizeContext({ messages: [] }), { apiKey: "in-flight-token" });
  expect(token).toHaveBeenCalledTimes(2);
});

test.each([200, 401, 404, 403, 500, "network"] as const)("corroborates inference with the fixed usage route, status %s", async status => {
  const root = mkdtempSync(join(tmpdir(), "provider-rejection-")), path = join(root, "auth.json");
  const credential = { type: "oauth" as const, access: "rejected", refresh: "live", expires: Date.now() + 3_600_000, accountId: "account" };
  writeFileSync(path, JSON.stringify({ "openai-codex-11": credential }));
  const refresh = vi.fn(async () => ({ ...credential, access: "fresh", refresh: "rotated" }));
  const auth = new SharedOAuthAuth({ path, providerId: "openai-codex", refresh, toAuth: async c => ({ apiKey: c.access }) });
  const fetch = vi.fn(async (url, init) => {
    expect(url).toBe("https://chatgpt.com/backend-api/codex/usage");
    expect(init.headers.Authorization).toBe("Bearer rejected");
    expect(init.headers["chatgpt-account-id"]).toBe("account");
    expect(init.redirect).toBe("error");
    if (status === "network") throw new Error("connection closed");
    return status === 200 ? Response.json({}) : new Response("provider refusal", { status, headers: { "x-request-id": "request-1" } });
  });
  const usage: typeof fetchCodexUsage = (token, id, _fetch, timeout, now, signal) => fetchCodexUsage(token, id, fetch, timeout, now, signal);
  try {
    const result = await repairProviderCredential(auth, "openai-codex-11", "Not Found", true, AbortSignal.timeout(1000), credential.access, usage);
    const rejected = status === 401 || status === 404;
    expect(result.outcome).toBe(rejected ? "repaired" : status === 200 ? "not-rejected" : "failed");
    expect(refresh).toHaveBeenCalledTimes(rejected ? 1 : 0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.detail).toContain("Not Found");
    if (status !== 200 && status !== "network") expect(result.detail).toContain(`HTTP ${status} request-id=request-1: provider refusal`);
    expect(JSON.parse(readFileSync(path, "utf8"))["openai-codex-11"].access).toBe(rejected ? "fresh" : "rejected");
  } finally { rmSync(root, { recursive: true }); }
});

test.each(["same-token", "replaced-token"])("concurrent repair uses shared compare-and-swap: %s", async kind => {
  const root = mkdtempSync(join(tmpdir(), "provider-rejection-race-")), path = join(root, "auth.json");
  const credential = { type: "oauth" as const, access: kind === "same-token" ? "rejected" : "fresh", refresh: "live", expires: Date.now() + 3_600_000, accountId: "account" };
  writeFileSync(path, JSON.stringify({ "openai-codex-11": credential }));
  const refresh = vi.fn(async () => ({ ...credential, access: "fresh", refresh: "rotated" }));
  const options = { path, providerId: "openai-codex", refresh, toAuth: async (c: OAuthCredential) => ({ apiKey: c.access }) };
  const usage = vi.fn(async () => { throw new CodexUnauthorizedError(404); });
  try {
    const repairs = await Promise.all([1, 2].map(() => repairProviderCredential(new SharedOAuthAuth(options), "openai-codex-11", "Not Found", true, AbortSignal.timeout(1000), "rejected", usage)));
    expect(repairs.map(r => r.outcome)).toEqual(["repaired", "repaired"]);
    expect(refresh).toHaveBeenCalledTimes(kind === "same-token" ? 1 : 0);
  } finally { rmSync(root, { recursive: true }); }
});

test.each([404, 500, "refresh-failed"] as const)("meter retains both rejection and repair diagnostics without another refresh: %s", async next => {
  const root = mkdtempSync(join(tmpdir(), "provider-rejection-meter-")), path = join(root, "auth.json");
  const store = Store.open(":memory:");
  const credential = { type: "oauth" as const, access: "rejected", refresh: "live", expires: Date.now() + 3_600_000, accountId: "account" };
  writeFileSync(path, JSON.stringify({ "openai-codex-11": credential }));
  store.upsertAccount({ id: "openai-codex-11", provider: "openai-codex" });
  const refresh = vi.fn(async () => {
    if (next === "refresh-failed") throw new Error("refresh denied");
    return { ...credential, access: "fresh", refresh: "rotated" };
  });
  const auth = new SharedOAuthAuth({ path, providerId: "openai-codex", refresh, toAuth: async c => ({ apiKey: c.access }) });
  let calls = 0;
  const fetch = vi.fn(async () => new Response(++calls === 1 ? "first refusal" : "second refusal", { status: calls === 1 ? 404 : next as number, headers: { "x-request-id": `request-${calls}` } }));
  const sampler = new CodexMeterSampler(store, { auth, fetch, meters: [{ id: "codex-7d", windowHours: 168 }] });
  try {
    const [report] = await sampler.sample();
    expect(report.outcome).toBe("request-failed");
    expect(report.detail).toContain("HTTP 404 request-id=request-1: first refusal; after shared OAuth repair:");
    expect(report.detail).toContain(next === "refresh-failed" ? "refresh denied" : `HTTP ${next} request-id=request-2: second refusal`);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(next === "refresh-failed" ? 1 : 2);
    expect((await sampler.sample())[0].outcome).toBe("not-due");
  } finally { store.close(); rmSync(root, { recursive: true }); }
});
