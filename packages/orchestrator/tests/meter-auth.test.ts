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
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fresh");
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
    expect(reports).toEqual([{ accountId: provider, meterId: provider === "anthropic" ? "anthropic-7d" : "codex-7d", outcome: "recorded", usedPercent: 17 }]);
    expect(JSON.parse(readFileSync(path, "utf8"))[provider]).toEqual(fresh);
    await sampler.sample(now + 1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    store.close(); rmSync(root, { recursive: true });
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
