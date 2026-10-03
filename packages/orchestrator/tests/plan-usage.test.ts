import { afterEach, expect, it } from "vitest";
import { ORCHESTRATOR_CATALOG } from "../src/catalog.js";
import { planUsage } from "../src/client.js";
import { Store } from "../src/store.js";
import type { Account } from "../src/domain.js";

const HOUR = 3_600_000;
const now = Date.UTC(2026, 9, 2, 12);
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(provider: Account["provider"]) {
  const store = Store.open(":memory:");
  stores.push(store);
  store.upsertAccount({ id: "primary", provider, label: "Primary" });
  return store;
}
const providers: { provider: Account["provider"]; plan: string; short: string; weekly: string; metric: string }[] = [
  { provider: "openai-codex", plan: "openai", short: "codex-5h", weekly: "codex-7d", metric: "remaining" },
  { provider: "anthropic", plan: "anthropic", short: "anthropic-5h", weekly: "anthropic-7d", metric: "weekly" },
];

it.each(providers)("reports independent five-hour and weekly quota for $plan", ({ provider, plan, short, weekly, metric }) => {
  const store = setup(provider);
  store.upsertAccount({ id: "secondary", provider });
  store.recordMeter("primary", short, 90, now + HOUR, now);
  store.recordMeter("primary", weekly, 20, now + 84 * HOUR, now);
  store.recordMeter("secondary", short, 10, now + 4 * HOUR, now);
  store.recordMeter("secondary", weekly, 60, now + 126 * HOUR, now);
  const usage = planUsage(store, undefined, now).plans[plan]!;
  expect(usage.metrics["five-hour"]).toMatchObject({ percentLeft: 50, expectedPercentLeft: 50, paceDelta: 0 });
  expect(usage.metrics[metric]).toMatchObject({ percentLeft: 60, expectedPercentLeft: 63, paceDelta: -2 });
  expect(usage.metrics["five-hour"]!.accounts.map(account => account.meterId)).toEqual([short, short]);
  expect(usage.metrics[metric]!.accounts.map(account => account.meterId)).toEqual([weekly, weekly]);
  expect(ORCHESTRATOR_CATALOG.plans.find(item => item.id === plan)!.quotaMeter).toBe(weekly);
});

it.each(providers.flatMap(provider => [0, -1].map(resetOffset => ({ ...provider, resetOffset }))))(
  "excludes $plan five-hour readings at/past reset ($resetOffset ms), retaining history until another observation",
  ({ provider, plan, short, weekly, metric, resetOffset }) => {
    const store = setup(provider);
    const resetAt = now + resetOffset;
    store.recordMeter("primary", short, 100, resetAt, now - 60_000);
    store.recordMeter("primary", weekly, 40, now + 84 * HOUR, now);
    const usage = planUsage(store, undefined, now).plans[plan]!;
    expect(usage.metrics["five-hour"]).toMatchObject({ percentLeft: null, expectedPercentLeft: null, paceDelta: null });
    expect(usage.metrics["five-hour"]!.accounts[0]).toMatchObject({
      state: "stale", usedPercent: 100, percentLeft: 0, meterId: short,
      readingAt: new Date(now - 60_000).toISOString(), resetAt: new Date(resetAt).toISOString(),
    });
    expect(usage.metrics[metric]!.percentLeft).toBe(60);
    store.recordMeter("primary", short, 7, now + 5 * HOUR, now);
    expect(planUsage(store, undefined, now).plans[plan]!.metrics["five-hour"]).toMatchObject({
      percentLeft: 93, accounts: [expect.objectContaining({ state: "ready", usedPercent: 7 })],
    });
  },
);

it.each([undefined, now + HOUR])("does not apply Anthropic's 14-day weekly freshness to five-hour data (reset %s)", resetAt => {
  const store = setup("anthropic");
  store.recordMeter("primary", "anthropic-5h", 25, resetAt, now - 6 * HOUR);
  store.recordMeter("primary", "anthropic-7d", 40, now - HOUR, now - 13 * 24 * HOUR);
  store.recordMeter("primary", "anthropic-7d_oi", 55, now - HOUR, now - 13 * 24 * HOUR);
  const usage = planUsage(store, undefined, now).plans.anthropic!;
  expect(usage.metrics["five-hour"]).toMatchObject({
    percentLeft: null, accounts: [expect.objectContaining({ state: "stale", percentLeft: 75 })],
  });
  expect(usage.metrics.weekly).toMatchObject({ percentLeft: 60, accounts: [expect.objectContaining({ state: "ready" })] });
  expect(usage.metrics.fable).toMatchObject({ percentLeft: 45, accounts: [expect.objectContaining({ state: "ready" })] });
});

it.each(providers)("keeps missing $plan short-window quota unknown without hiding weekly values", ({ provider, plan, weekly, metric }) => {
  const store = setup(provider);
  store.recordMeter("primary", weekly, 40, now + HOUR, now);
  const usage = planUsage(store, undefined, now).plans[plan]!;
  expect(usage.metrics["five-hour"]).toMatchObject({
    percentLeft: null, accounts: [expect.objectContaining({ state: "unavailable", percentLeft: null })],
  });
  expect(usage.metrics[metric]!.percentLeft).toBe(60);
});

it("retains OpenAI's stricter one-hour observation freshness", () => {
  const store = setup("openai-codex");
  store.recordMeter("primary", "codex-5h", 25, now + HOUR, now - 2 * HOUR);
  expect(planUsage(store, undefined, now).plans.openai!.metrics["five-hour"]).toMatchObject({
    percentLeft: null, accounts: [expect.objectContaining({ state: "stale", percentLeft: 75 })],
  });
});
