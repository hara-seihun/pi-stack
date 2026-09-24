import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { modelPrices, personUsage, SUBSCRIPTION_MONTH_MS } from "../src/person-usage.js";

const plans = [
  { id: "openai", label: "OpenAI", icon: "openai", provider: "openai-codex", maxReadingAgeMs: 1, monthlyUsd: 200, metrics: [] },
  { id: "anthropic", label: "Anthropic", icon: "anthropic", provider: "anthropic", maxReadingAgeMs: 1, monthlyUsd: 250, metrics: [] },
];

test("usage is attributed to broker principals, their completions and otherwise the ledger owner, and splits each provider's subscription cost", () => {
  const root = mkdtempSync(join(tmpdir(), "person-usage-"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  try {
    store.upsertAccount({ id: "codex-1", provider: "openai-codex" });
    store.upsertAccount({ id: "codex-2", provider: "openai-codex" });
    store.upsertAccount({ id: "codex-off", provider: "openai-codex", enabled: false });
    store.upsertAccount({ id: "claude", provider: "anthropic" });
    const hour = 10 * 3_600_000;
    const record = (accountId: string, source: string, runId: string, model: string, component: "input" | "output" | "cacheRead", tokens: number, at = hour) =>
      store.recordUsage({ accountId, hour: at, source, runId, model, component, tokens });
    record("codex-1", "interactive", "broker:sybil:1", "priced", "input", 1_000_000);
    record("codex-1", "interactive", "broker:sybil:2", "priced", "cacheRead", 1_000_000);
    record("codex-2", "interactive", "owner-session", "priced", "output", 1_000_000);
    record("codex-2", "fleet", "fleet-run", "priced", "input", 1_000_000);
    record("claude", "interactive", "broker:sybil:3", "costly", "output", 1_000);
    record("codex-1", "completion", "completion-run", "unpriced", "output", 500);
    store.setControl("completion-run:completion-run", "broker-abc");
    store.setControl("completion:broker-abc", JSON.stringify({ access: { principal: "jodie" } }));
    record("codex-1", "interactive", "broker:sybil:old", "priced", "input", 9_000_000, hour - 3_600_000);
    const prices = { priced: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 }, costly: { input: 100, output: 1000, cacheRead: 10, cacheWrite: 100 } };
    const window = personUsage(store, hour, hour + SUBSCRIPTION_MONTH_MS, model => prices[model as keyof typeof prices], plans);
    expect(window.subscriptions.map(plan => [plan.planId, plan.accounts, plan.spend, plan.idle])).toEqual([["openai", 2, 400, 0], ["anthropic", 1, 250, 0]]);
    const byPrincipal = Object.fromEntries(window.rows.map(row => [row.principal ?? "owner", row]));
    // OpenAI value: owner 12, sybil 2.5, jodie 0 → owner gets 12/14.5 of $400.
    expect(byPrincipal.owner!.spend).toBeCloseTo(400 * 12 / 14.5, 6);
    expect(byPrincipal.owner!.sources.fleet.spend).toBeCloseTo(400 * 2 / 14.5, 6);
    // Sybil alone used Anthropic, so its whole bill is hers however cheap her use was.
    expect(byPrincipal.sybil!.providers.anthropic!.spend).toBe(250);
    expect(byPrincipal.sybil!.spend).toBeCloseTo(250 + 400 * 2.5 / 14.5, 6);
    expect(byPrincipal.jodie).toMatchObject({ tokens: 500, value: 0, spend: 0, unpricedTokens: 500 });
    expect(window.rows.map(row => row.principal)).toEqual([null, "sybil", "jodie"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a light user's quiet day is part of her week, not a share of the day's whole cost", () => {
  const root = mkdtempSync(join(tmpdir(), "person-usage-"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  try {
    store.upsertAccount({ id: "claude", provider: "anthropic" });
    const day = 24 * 3_600_000, until = 10 * day;
    const record = (runId: string, tokens: number, at: number) => store.recordUsage({ accountId: "claude", hour: at, source: "interactive", runId, model: "priced", component: "output", tokens });
    record("owner-session", 1_000_000_000, until - 5 * day);
    record("broker:martine:1", 1_000_000, until - 3_600_000);
    const priceOf = () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
    const spend = (windowMs: number) => personUsage(store, until - windowMs, until, priceOf, plans).rows.find(row => row.principal === "martine")!.spend;
    expect(spend(day)).toBeCloseTo(spend(7 * day), 9);
    expect(spend(day)).toBeCloseTo(250 * 7 / 30 / 1001, 9);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a provider nobody used is reported idle", () => {
  const root = mkdtempSync(join(tmpdir(), "person-usage-"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  try {
    store.upsertAccount({ id: "claude", provider: "anthropic" });
    const window = personUsage(store, 0, SUBSCRIPTION_MONTH_MS / 30, () => undefined, plans);
    expect(window.subscriptions.find(plan => plan.planId === "anthropic")).toMatchObject({ accounts: 1, idle: 250 / 30 });
    expect(window.rows).toEqual([]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("list prices cover catalog and retired pooled models", () => {
  const prices = modelPrices();
  expect(prices.get("claude-fable-5-1")?.output).toBeGreaterThan(0);
  expect(prices.get("gpt-6-astra")?.input).toBeGreaterThan(0);
});
