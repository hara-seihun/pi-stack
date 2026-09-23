import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { AnthropicMeterSampler } from "../src/meters-anthropic.js";
import { CodexMeterSampler } from "../src/meters-codex.js";
import { Store } from "../src/store.js";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";

/** Codex sampling also reads the account's banked resets, on its own route. */
const isCredits = (url: unknown) => String(url).includes("rate-limit-reset-credits");
const creditsResponse = () => Response.json({ credits: [{ id: "credit-1", status: "available", expires_at: "2026-12-01T00:00:00.000Z" }], available_count: 1 });
const creditsReport = (accountId: string) => ({ accountId, outcome: "recorded", bankedResets: 1 });

it.each(["anthropic", "openai-codex"] as const)("refreshes idle %s credentials once under the session lock before sampling", async provider => {
  const root = mkdtempSync(join(tmpdir(), "meter-auth-")), path = join(root, "auth.json"), now = Date.now();
  const store = Store.open(":memory:");
  try {
    const expired = { type: "oauth" as const, access: "expired", refresh: "single-use", expires: now - 1, accountId: "account" };
    const fresh = { ...expired, access: "fresh", refresh: "rotated", expires: now + 3_600_000 };
    writeFileSync(path, JSON.stringify({ [provider]: expired }));
    store.upsertAccount({ id: provider, provider, concurrency: 4 });
    const refresh = vi.fn(async () => fresh);
    const options = { path, providerId: provider, refresh, toAuth: async () => ({ apiKey: "unused" }) };
    const auth = new SharedOAuthAuth(options), session = new SharedOAuthAuth(options);
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fresh");
      if (isCredits(url)) return creditsResponse();
      return Response.json(provider === "anthropic"
        ? { limits: [{ kind: "weekly_all", percent: 17, resets_at: new Date(now + 86_400_000).toISOString() }] }
        : { rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 604800, reset_at: (now + 86_400_000) / 1000 } } });
    });
    const sampler = provider === "anthropic"
      ? new AnthropicMeterSampler(store, { auth, fetch })
      : new CodexMeterSampler(store, { auth, fetch, meters: [{ id: "codex-7d", windowHours: 168 }] });
    const [reports, credential] = await Promise.all([sampler.sample(now), session.credential(provider, AbortSignal.timeout(1000))]);
    expect(credential.access).toBe("fresh");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reports).toEqual(provider === "anthropic"
      ? [{ accountId: provider, meterId: "anthropic-7d", outcome: "recorded", usedPercent: 17 }]
      : [creditsReport(provider), { accountId: provider, meterId: "codex-7d", outcome: "recorded", usedPercent: 17 }]);
    expect(JSON.parse(readFileSync(path, "utf8"))[provider]).toEqual(fresh);
    if (provider === "openai-codex") expect(store.resetCredits(provider)).toMatchObject({ available: 1, nextExpiresAt: Date.parse("2026-12-01T00:00:00.000Z") });
    await sampler.sample(now + 1000);
    expect(fetch).toHaveBeenCalledTimes(provider === "anthropic" ? 1 : 2);
  } finally {
    store.close(); rmSync(root, { recursive: true });
  }
});

it.each([["anthropic", 401], ["openai-codex", 401], ["openai-codex", 404]] as const)("replaces an unexpired %s token refused with HTTP %s and samples with the new one", async (provider, status) => {
  const root = mkdtempSync(join(tmpdir(), "meter-auth-rejected-")), path = join(root, "auth.json"), now = Date.now();
  const store = Store.open(":memory:");
  try {
    // The stored token has hours of life left by the clock; the provider
    // refuses it anyway because its auth session was rotated.
    const rejected = { type: "oauth" as const, access: "rejected", refresh: "live", expires: now + 3_600_000, accountId: "account" };
    const fresh = { ...rejected, access: "fresh", refresh: "rotated" };
    writeFileSync(path, JSON.stringify({ [provider]: rejected }));
    store.upsertAccount({ id: provider, provider, concurrency: 4 });
    const refresh = vi.fn(async () => fresh);
    const auth = new SharedOAuthAuth({ path, providerId: provider, refresh, toAuth: async () => ({ apiKey: "unused" }) });
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).Authorization;
      if (authorization === "Bearer rejected") return new Response("", { status });
      expect(authorization).toBe("Bearer fresh");
      if (isCredits(url)) return creditsResponse();
      return Response.json(provider === "anthropic"
        ? { limits: [{ kind: "weekly_all", percent: 42, resets_at: new Date(now + 86_400_000).toISOString() }] }
        : { rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: (now + 86_400_000) / 1000 } } });
    });
    const sampler = provider === "anthropic"
      ? new AnthropicMeterSampler(store, { auth, fetch })
      : new CodexMeterSampler(store, { auth, fetch, meters: [{ id: "codex-7d", windowHours: 168 }] });
    expect(await sampler.sample(now)).toEqual(provider === "anthropic"
      ? [{ accountId: provider, meterId: "anthropic-7d", outcome: "recorded", usedPercent: 42 }]
      : [creditsReport(provider), { accountId: provider, meterId: "codex-7d", outcome: "recorded", usedPercent: 42 }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, "utf8"))[provider]).toEqual(fresh);
  } finally {
    store.close(); rmSync(root, { recursive: true });
  }
});

it("reports a rejection that survives a fresh token instead of refreshing again", async () => {
  const root = mkdtempSync(join(tmpdir(), "meter-auth-revoked-")), path = join(root, "auth.json"), now = Date.now();
  const store = Store.open(":memory:");
  try {
    const rejected = { type: "oauth" as const, access: "rejected", refresh: "live", expires: now + 3_600_000 };
    writeFileSync(path, JSON.stringify({ anthropic: rejected }));
    store.upsertAccount({ id: "anthropic", provider: "anthropic", concurrency: 4 });
    const refresh = vi.fn(async () => ({ ...rejected, access: "also-rejected", refresh: "rotated" }));
    const auth = new SharedOAuthAuth({ path, providerId: "anthropic", refresh, toAuth: async () => ({ apiKey: "unused" }) });
    const fetch = vi.fn(async () => new Response("", { status: 401 }));
    const sampler = new AnthropicMeterSampler(store, { auth, fetch });
    const reports = await sampler.sample(now);
    expect(reports).toEqual([{ accountId: "anthropic", outcome: "request-failed", detail: "AnthropicUnauthorizedError: anthropic usage HTTP 401" }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    store.close(); rmSync(root, { recursive: true });
  }
});

it("takes the credential another process already replaced rather than spending a rotation", async () => {
  const root = mkdtempSync(join(tmpdir(), "meter-auth-raced-")), path = join(root, "auth.json"), now = Date.now();
  const rejected = { type: "oauth" as const, access: "rejected", refresh: "live", expires: now + 3_600_000 };
  const replaced = { ...rejected, access: "replaced-elsewhere", refresh: "rotated" };
  try {
    writeFileSync(path, JSON.stringify({ anthropic: replaced }));
    const refresh = vi.fn(async () => { throw new Error("must not refresh"); });
    const auth = new SharedOAuthAuth({ path, providerId: "anthropic", refresh, toAuth: async () => ({ apiKey: "unused" }) });
    const current = await auth.refreshRejected("anthropic", rejected.access, AbortSignal.timeout(1000));
    expect(current).toEqual(replaced);
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true });
  }
});

it("retains failed refresh credentials, reports the blocker, and spaces attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "meter-auth-failure-")), path = join(root, "auth.json"), now = Date.now();
  const store = Store.open(":memory:");
  try {
    const expired = { type: "oauth", access: "expired", refresh: "preserve", expires: now - 1 };
    writeFileSync(path, JSON.stringify({ anthropic: expired }));
    store.upsertAccount({ id: "anthropic", provider: "anthropic", concurrency: 4 });
    const refresh = vi.fn(async () => { throw new Error("refresh denied"); });
    const auth = new SharedOAuthAuth({ path, providerId: "anthropic", refresh, toAuth: async () => ({ apiKey: "unused" }) });
    const fetch = vi.fn();
    const sampler = new AnthropicMeterSampler(store, { auth, fetch });
    const daemon = new Daemon(store, { ...loadConfig("/missing"), authPath: path, taskManifest: undefined }, "/release") as any;
    daemon.anthropicMeters = sampler;
    daemon.codexMeters.sample = async () => [];
    await daemon.reconcile();
    expect(daemon.status().meterErrors).toEqual([{ accountId: "anthropic", outcome: "credential-failed", detail: "Error: refresh denied" }]);
    await daemon.reconcile();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, "utf8")).anthropic).toEqual(expired);
  } finally {
    store.close(); rmSync(root, { recursive: true });
  }
});

it.each(["anthropic", "openai-codex"] as const)("stops sampling a disabled %s account and clears its meter error", async provider => {
  const root = mkdtempSync(join(tmpdir(), "meter-auth-disabled-")), path = join(root, "auth.json"), now = Date.now();
  const store = Store.open(":memory:");
  try {
    // A lapsed subscription answers with a window this deployment does not
    // declare. Once the account is disabled it is unschedulable, so the
    // sampler must leave it alone instead of reporting that forever.
    const credential = { type: "oauth" as const, access: "live", refresh: "live", expires: now + 3_600_000, accountId: "account" };
    writeFileSync(path, JSON.stringify({ [provider]: credential }));
    store.upsertAccount({ id: provider, provider, concurrency: 4 });
    const auth = new SharedOAuthAuth({ path, providerId: provider, refresh: async () => credential, toAuth: async () => ({ apiKey: "unused" }) });
    const fetch = vi.fn(async (url: unknown) => isCredits(url) ? creditsResponse() : Response.json(provider === "anthropic"
      ? { limits: [] }
      : { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 2_592_000, reset_at: (now + 86_400_000) / 1000 } } }));
    const sampler = provider === "anthropic"
      ? new AnthropicMeterSampler(store, { auth, fetch })
      : new CodexMeterSampler(store, { auth, fetch, meters: [{ id: "codex-7d", windowHours: 168 }] });
    const first = await sampler.sample(now);
    expect(first.map(report => report.outcome)).toEqual(provider === "anthropic" ? ["unreadable-response"] : ["recorded", "unmapped-window"]);
    store.setAccountEnabled(provider, false);
    expect(await sampler.sample(now + 3_600_000)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(provider === "anthropic" ? 1 : 2);
  } finally {
    store.close(); rmSync(root, { recursive: true });
  }
});
