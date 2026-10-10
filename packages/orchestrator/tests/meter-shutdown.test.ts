import { afterEach, expect, it, vi } from "vitest";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { AnthropicMeterSampler } from "../src/meters-anthropic.js";
import { CodexMeterSampler } from "../src/meters-codex.js";
import { codexResetAttempt } from "../src/codex-resets.js";
import { Store } from "../src/store.js";

const providers = ["anthropic", "openai-codex"] as const;
type Provider = typeof providers[number];
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function usage(provider: Provider, usedPercent = 17) {
  return Response.json(provider === "anthropic"
    ? { limits: [{ kind: "weekly_all", percent: usedPercent }] }
    : { rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_at: 1900000000 } } });
}
const credits = () => Response.json({ available_count: 1, credits: [{ id: "credit", status: "available", expires_at: "2029-12-01" }] });
const isCredits = (url: unknown) => String(url).includes("reset-credits");

function fixture(provider: Provider, expired = false) {
  const root = mkdtempSync(join(tmpdir(), "meter-shutdown-")), path = join(root, "auth.json");
  const store = Store.open(":memory:"), now = Date.now();
  const credential = { type: "oauth" as const, access: "access", refresh: "refresh", expires: now + (expired ? -1 : 3600000), accountId: "account" };
  writeFileSync(path, JSON.stringify({ a: credential, b: credential }));
  for (const id of ["a", "b"]) store.upsertAccount({ id, provider, concurrency: 4 });
  const refresh = vi.fn(async (_credential: OAuthCredential, _signal: AbortSignal) => ({ ...credential, access: "fresh", refresh: "rotated", expires: now + 3600000 }));
  const auth = new SharedOAuthAuth({ path, providerId: provider, refresh, toAuth: async () => ({ apiKey: "unused" }) });
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => isCredits(url) ? credits() : usage(provider));
  const sampler = () => provider === "anthropic"
    ? new AnthropicMeterSampler(store, { auth, fetch })
    : new CodexMeterSampler(store, { auth, fetch, autoReset: true, meters: [{ id: "codex-7d", windowHours: 168 }] });
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, path, now, credential, refresh, auth, fetch, sampler };
}

it.each(providers)("does no work when %s sampling starts cancelled", async provider => {
  const f = fixture(provider);
  const read = vi.spyOn(f.auth, "hasCredential");
  expect(await f.sampler().sample(f.now, AbortSignal.abort())).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  if (provider === "openai-codex") {
    expect(await (f.sampler() as CodexMeterSampler).sampleAccount("a", f.now, AbortSignal.abort()))
      .toEqual([expect.objectContaining({ accountId: "a", outcome: "cancelled" })]);
    expect(read).not.toHaveBeenCalled();
  }
});

it.each(providers.flatMap(provider => ["credential", "repair", "usage"].map(stage => ({ provider, stage }))))(
  "retires $provider $stage observation while preserving started token rotation", async ({ provider, stage }) => {
    const f = fixture(provider, stage === "credential"), started = deferred<AbortSignal>(), stop = new AbortController();
    const rotated = deferred<typeof f.credential>();
    if (stage !== "usage") f.refresh.mockImplementation(async (_credential, signal) => {
      started.resolve(signal);
      return rotated.promise;
    });
    if (stage === "repair") f.fetch.mockImplementation(async () => new Response("", { status: 401 }));
    if (stage === "usage") f.fetch.mockImplementation(async (_url, init) => {
      started.resolve(init!.signal!);
      return untilAborted(init!.signal!);
    });
    const sampler = f.sampler(), result = sampler.sample(f.now, stop.signal);
    const ownedSignal = await started.promise;
    stop.abort(new Error("shutdown"));
    expect(ownedSignal.aborted).toBe(stage === "usage");
    rotated.resolve({ ...f.credential, access: "fresh", refresh: "rotated", expires: f.now + 3600000 });
    expect(await result).toEqual([expect.objectContaining({ accountId: "a", outcome: "cancelled" })]);
    expect(ownedSignal.aborted).toBe(stage === "usage");
    expect(f.fetch).toHaveBeenCalledTimes(stage === "credential" ? 0 : 1);
    expect(f.store.latestMeters("a")).toEqual([]);
    expect(f.store.latestMeters("b")).toEqual([]);
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    f.fetch.mockImplementation(async url => isCredits(url) ? credits() : usage(provider));
    f.refresh.mockImplementation(async () => ({ ...f.credential, access: "fresh", refresh: "rotated", expires: f.now + 3600000 }));
    const resumed = await sampler.sample(f.now);
    expect(resumed.find(report => report.accountId === "a")?.outcome).not.toBe("not-due");
  },
);

it.each(providers)("cancels a %s shared-auth lock wait without stealing its lock", async provider => {
  const f = fixture(provider), stop = new AbortController();
  mkdirSync(`${f.path}.lock`);
  const result = f.sampler().sample(f.now, stop.signal);
  stop.abort();
  expect(await result).toEqual([expect.objectContaining({ accountId: "a", outcome: "cancelled" })]);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(existsSync(`${f.path}.lock`)).toBe(true);
});

it.each(providers)("retains ownership of late %s refresh completion without another read", async provider => {
  const f = fixture(provider, true), started = deferred<void>(), refreshed = deferred<typeof f.credential>(), stop = new AbortController();
  f.refresh.mockImplementation(async () => { started.resolve(); return refreshed.promise; });
  let settled = false;
  const result = f.sampler().sample(f.now, stop.signal).then(value => { settled = true; return value; });
  await started.promise;
  stop.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  const fresh = { ...f.credential, access: "fresh", refresh: "rotated", expires: f.now + 3600000 };
  refreshed.resolve(fresh);
  expect(await result).toEqual([expect.objectContaining({ accountId: "a", outcome: "cancelled" })]);
  expect(JSON.parse(readFileSync(f.path, "utf8")).a).toEqual(fresh);
  expect(existsSync(`${f.path}.lock`)).toBe(false);
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each(providers)("does not write a late %s response after lifecycle cancellation", async provider => {
  const f = fixture(provider), started = deferred<void>(), response = deferred<Response>(), stop = new AbortController();
  f.fetch.mockImplementation(async () => { started.resolve(); return response.promise; });
  const result = f.sampler().sample(f.now, stop.signal);
  await started.promise;
  stop.abort();
  response.resolve(usage(provider));
  expect(await result).toEqual([expect.objectContaining({ accountId: "a", outcome: "cancelled" })]);
  expect(f.store.latestMeters("a")).toEqual([]);
  expect(f.store.resetCredits("a")).toBeUndefined();
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it.each(["abort", "late"])("stops at Codex credits %s without recording credits or claiming a reset", async mode => {
  const f = fixture("openai-codex"), started = deferred<AbortSignal>(), response = deferred<Response>(), stop = new AbortController();
  f.fetch.mockImplementation(async (url, init) => {
    if (!isCredits(url)) return usage("openai-codex", 100);
    started.resolve(init!.signal!);
    return mode === "abort" ? untilAborted(init!.signal!) : response.promise;
  });
  const result = f.sampler().sample(f.now, stop.signal);
  const signal = await started.promise;
  stop.abort();
  response.resolve(credits());
  expect(await result).toEqual([expect.objectContaining({ accountId: "a", outcome: "cancelled" })]);
  expect(signal.aborted).toBe(true);
  expect(f.store.resetCredits("a")).toBeUndefined();
  expect(codexResetAttempt(f.store, "a")).toBeUndefined();
  expect(f.store.latestMeters("a")).toEqual([]);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it.each(["accepted", "ambiguous"])("settles a claimed %s Codex reset through shutdown without retry", async outcome => {
  const f = fixture("openai-codex"), started = deferred<AbortSignal>(), response = deferred<Response>(), stop = new AbortController();
  f.fetch.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { started.resolve(init.signal!); return response.promise; }
    return isCredits(url) ? credits() : usage("openai-codex", 100);
  });
  let settled = false;
  const result = f.sampler().sample(f.now, stop.signal).then(value => { settled = true; return value; });
  const postSignal = await started.promise;
  const claim = codexResetAttempt(f.store, "a");
  expect(claim?.status).toBe("pending");
  stop.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(postSignal.aborted).toBe(false);
  if (outcome === "accepted") response.resolve(Response.json({ code: "reset" }));
  else response.reject(new Error("connection lost after send"));
  expect(await result).toContainEqual(expect.objectContaining({ accountId: "a", outcome: "cancelled" }));
  expect(codexResetAttempt(f.store, "a")).toMatchObject({ requestId: claim!.requestId, status: outcome === "accepted" ? "accepted" : "failed" });
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(f.store.latestMeters("a")).toEqual([]);
  f.store.setAccountEnabled("b", false);
  await f.sampler().sample(f.now + 1000);
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
