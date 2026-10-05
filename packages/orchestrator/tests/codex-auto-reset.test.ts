import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedOAuthAuth } from "../src/auth/shared-oauth.js";
import { CodexMeterSampler } from "../src/meters-codex.js";
import { claimCodexReset, codexResetAttempt } from "../src/codex-resets.js";
import { Store } from "../src/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(autoReset = true) {
  const root = mkdtempSync(join(tmpdir(), "codex-auto-reset-")), path = join(root, "auth.json");
  const store = Store.open(":memory:"), accountId = "openai-codex-2";
  store.upsertAccount({ id: accountId, provider: "openai-codex", concurrency: 4 });
  writeFileSync(path, JSON.stringify({ [accountId]: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000, accountId: "test-account" } }));
  const auth = new SharedOAuthAuth({ path, providerId: "openai-codex", refresh: async () => { throw new Error("unexpected refresh"); }, toAuth: async () => ({ apiKey: "unused" }) });
  const state = { weekly: 100, five: 10, resetAt: 1900000000, ambiguous: false, consumed: false, noCredits: false };
  const post = vi.fn(async () => {
    if (state.ambiguous) throw new Error("connection lost after send");
    state.consumed = true;
    return Response.json({ code: "reset" });
  });
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return post();
    if (String(url).includes("reset-credits")) return Response.json({ credits: state.noCredits ? [] : [
      { id: "expired", expires_at: "2020-01-01", status: "available" },
      { id: "later", expires_at: "2029-12-01", status: "available" },
      ...(!state.consumed ? [{ id: "first", expires_at: "2029-01-01", status: "available" }] : []),
    ] });
    return Response.json({ rate_limit: { primary_window: { used_percent: state.five, limit_window_seconds: 18000 }, secondary_window: { used_percent: state.weekly, limit_window_seconds: 604800, reset_at: state.resetAt } } });
  });
  const sampler = () => new CodexMeterSampler(store, { auth, fetch, autoReset, meters: [{ id: "codex-7d", windowHours: 168 }, { id: "codex-5h", windowHours: 5 }] });
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true }); });
  return { store, accountId, state, fetch, post, sampler };
}

it.each(["off", "fractional", "five-hour", "no-credit", "disabled"])("does not spend on %s", async scenario => {
  const f = fixture(scenario !== "off");
  if (scenario === "fractional") f.state.weekly = 99.9;
  if (scenario === "five-hour") { f.state.weekly = 40; f.state.five = 100; }
  if (scenario === "no-credit") f.state.noCredits = true;
  if (scenario === "disabled") f.store.setAccountEnabled(f.accountId, false);
  await f.sampler().sampleAccount(f.accountId);
  expect(f.post).not.toHaveBeenCalled();
});

it("reserves the oldest live credit once across concurrent samplers and restart, and waits for quota recovery", async () => {
  const f = fixture();
  f.store.setCooldown(f.accountId, Date.now() + 3600000);
  await Promise.all([f.sampler().sampleAccount(f.accountId), f.sampler().sampleAccount(f.accountId)]);
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(codexResetAttempt(f.store, f.accountId)).toMatchObject({ creditId: "first", status: "accepted" });
  expect(f.store.accounts()[0].cooldownUntil).toBeDefined();
  const body = JSON.parse(String(f.fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
  expect(body).toMatchObject({ credit_id: "first", account_id: "test-account" });
  await f.sampler().sampleAccount(f.accountId, Date.now() + 1000);
  expect(f.post).toHaveBeenCalledTimes(1);
  f.state.weekly = 0; f.state.resetAt += 604800;
  await f.sampler().sampleAccount(f.accountId, Date.now() + 2000);
  expect(codexResetAttempt(f.store, f.accountId)?.status).toBe("confirmed");
  expect(f.store.accounts()[0].cooldownUntil).toBeUndefined();
  expect(f.store.latestReading(f.accountId, "codex-7d")?.usedPercent).toBe(0);
  expect(claimCodexReset(f.store, f.accountId, "later", 1900000000000)).toBeUndefined();
  f.state.weekly = 100;
  await f.sampler().sampleAccount(f.accountId, Date.now() + 3000);
  expect(f.post).toHaveBeenCalledTimes(2);
});

it("never repeats an ambiguous POST even after restart and a different credit list", async () => {
  const f = fixture(); f.state.ambiguous = true;
  expect(await f.sampler().sampleAccount(f.accountId)).toContainEqual(expect.objectContaining({ outcome: "reset-failed" }));
  f.state.consumed = true;
  await f.sampler().sampleAccount(f.accountId, Date.now() + 1000);
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(codexResetAttempt(f.store, f.accountId)).toMatchObject({ creditId: "first", status: "failed" });
});

it("shares its durable reservation with manual redemption", async () => {
  const f = fixture();
  expect(claimCodexReset(f.store, f.accountId, "first", f.state.resetAt * 1000)).toBeDefined();
  await f.sampler().sampleAccount(f.accountId);
  expect(f.post).not.toHaveBeenCalled();
});
