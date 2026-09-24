import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { calibrateRate, modelPrices, personUsage, weekResetsAt, weekStart } from "../src/person-usage.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const plans = [
  { id: "openai", label: "OpenAI", icon: "openai", provider: "openai-codex", maxReadingAgeMs: 1, monthlyUsd: 200, quotaMeter: "codex-7d", metrics: [] },
  { id: "anthropic", label: "Anthropic", icon: "anthropic", provider: "anthropic", maxReadingAgeMs: 1, monthlyUsd: 250, quotaMeter: "anthropic-7d", metrics: [] },
];
const prices = { priced: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 } };
const priceOf = (model: string) => prices[model as keyof typeof prices];
/** 1% of a $200 plan's week. */
const OPENAI_POINT = 200 * 7 / 30 / 100;

function ledger(run: (store: Store) => void) {
  const root = mkdtempSync(join(tmpdir(), "person-usage-"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  try { run(store); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
const record = (store: Store, accountId: string, source: string, runId: string, component: "input" | "output" | "cacheRead", tokens: number, hour: number, model = "priced") =>
  store.recordUsage({ accountId, hour, source, runId, model, component, tokens });

test("dollars come from consumed quota and are split by list-price value among principals and the ledger owner", () => ledger(store => {
  const now = 20 * DAY, hour = now - HOUR;
  store.upsertAccount({ id: "codex-1", provider: "openai-codex" });
  store.upsertAccount({ id: "codex-2", provider: "openai-codex" });
  record(store, "codex-1", "interactive", "broker:sybil:1", "input", 1_000_000, hour);
  record(store, "codex-1", "interactive", "broker:sybil:2", "cacheRead", 1_000_000, hour);
  record(store, "codex-2", "interactive", "owner-session", "output", 1_000_000, hour);
  record(store, "codex-2", "fleet", "fleet-run", "input", 1_000_000, hour);
  record(store, "codex-1", "completion", "completion-run", "output", 500, hour, "unpriced");
  store.setControl("completion-run:completion-run", "broker-abc");
  store.setControl("completion:broker-abc", JSON.stringify({ access: { principal: "jodie" } }));
  // Together the two accounts used 30 points of their weeks for $14.50 of list-price value.
  store.recordMeter("codex-1", "codex-7d", 10, now + DAY, now);
  store.recordMeter("codex-2", "codex-7d", 20, now + DAY, now);
  expect(calibrateRate(store, plans[0]!, priceOf, now)).toBeCloseTo(30 * OPENAI_POINT / 14.5, 9);
  const window = personUsage(store, now - DAY, now, priceOf, plans);
  const byPrincipal = Object.fromEntries(window.rows.map(row => [row.principal ?? "owner", row]));
  expect(byPrincipal.owner!.spend).toBeCloseTo(30 * OPENAI_POINT * 12 / 14.5, 9);
  expect(byPrincipal.owner!.sources.fleet.spend).toBeCloseTo(30 * OPENAI_POINT * 2 / 14.5, 9);
  expect(byPrincipal.sybil!.spend).toBeCloseTo(30 * OPENAI_POINT * 2.5 / 14.5, 9);
  expect(byPrincipal.jodie).toMatchObject({ tokens: 500, value: 0, spend: 0, unpricedTokens: 500 });
  const openai = window.subscriptions.find(plan => plan.planId === "openai")!;
  expect(openai.used).toBeCloseTo(30 * OPENAI_POINT, 9);
  expect(openai.spend).toBeCloseTo(2 * 200 / 30, 9);
  expect(window.subscriptions.find(plan => plan.planId === "anthropic")).toMatchObject({ accounts: 0, used: 0, rate: null });
}));

test("a priced hour keeps its rate, so spend since a fixed moment only grows", () => ledger(store => {
  const start = 20 * DAY;
  store.upsertAccount({ id: "codex-1", provider: "openai-codex" });
  record(store, "codex-1", "interactive", "broker:martine:1", "output", 100_000, start);
  store.recordMeter("codex-1", "codex-7d", 10, start + 5 * DAY, start + HOUR / 2);
  const spent = (now: number) => personUsage(store, start, now, priceOf, plans).rows.find(row => row.principal === "martine")?.spend ?? 0;
  const first = spent(start + HOUR);
  expect(first).toBeGreaterThan(0);
  // Later the pool serves far more value per quota point: the rate falls, but her past hour does not.
  record(store, "codex-1", "interactive", "owner-session", "output", 10_000_000, start + HOUR);
  store.recordMeter("codex-1", "codex-7d", 11, start + 5 * DAY, start + 1.5 * HOUR);
  expect(spent(start + 2 * HOUR)).toBeCloseTo(first, 12);
  record(store, "codex-1", "interactive", "broker:martine:2", "output", 1, start + 2 * HOUR);
  expect(spent(start + 3 * HOUR)).toBeGreaterThan(first);
}));

test("without any meter reading nothing is priced", () => ledger(store => {
  store.upsertAccount({ id: "claude", provider: "anthropic" });
  record(store, "claude", "interactive", "broker:sybil:1", "output", 1000, 0);
  const window = personUsage(store, 0, DAY, priceOf, plans);
  expect(window.rows[0]!.spend).toBe(0);
  expect(window.subscriptions.find(plan => plan.planId === "anthropic")).toMatchObject({ accounts: 1, used: 0, rate: null });
}));

test("the personal week runs Monday midnight to Monday midnight", () => {
  const wednesday = new Date(2026, 8, 23, 15, 30).getTime();
  expect(new Date(weekStart(wednesday)).toString()).toContain("Mon Sep 21 2026 00:00:00");
  expect(new Date(weekResetsAt(wednesday)).toString()).toContain("Mon Sep 28 2026 00:00:00");
  const monday = new Date(2026, 8, 28, 0, 0).getTime();
  expect(weekStart(monday)).toBe(monday);
});

test("list prices cover catalog and retired pooled models", () => {
  const prices = modelPrices();
  expect(prices.get("claude-fable-5-1")?.output).toBeGreaterThan(0);
  expect(prices.get("gpt-6-astra")?.input).toBeGreaterThan(0);
});
