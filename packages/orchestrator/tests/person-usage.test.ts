import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import customModelConfig from "../src/models.json" with { type: "json" };
import { withCustomModels } from "../src/models.js";
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
const record = (store: Store, accountId: string, source: string, runId: string, component: "input" | "output" | "cacheRead" | "cacheWrite", tokens: number, hour: number, model = "priced") =>
  store.recordUsage({ accountId, hour, source, runId, model, component, tokens });

test("dollars come from consumed quota and are split by list-price value among principals and the ledger owner", () => ledger(store => {
  const now = 20 * DAY, hour = now - HOUR;
  store.upsertAccount({ id: "codex-1", provider: "openai-codex" });
  store.upsertAccount({ id: "codex-2", provider: "openai-codex" });
  record(store, "codex-1", "interactive", "broker:sybil:1", "input", 1_000_000, hour);
  record(store, "codex-1", "interactive", "broker:sybil:2", "cacheRead", 1_000_000, hour);
  record(store, "codex-2", "interactive", "owner-session", "output", 1_000_000, hour);
  record(store, "codex-2", "fleet", "fleet-run", "input", 1_000_000, hour);
  record(store, "codex-1", "completion", "completion-run", "output", 500, hour);
  store.setControl("completion-run:completion-run", "broker-abc");
  store.setControl("completion:broker-abc", JSON.stringify({ access: { principal: "jodie" } }));
  // Together the two accounts used 30 points of their weeks for $14.505 of list-price value.
  store.recordMeter("codex-1", "codex-7d", 10, now + DAY, now);
  store.recordMeter("codex-2", "codex-7d", 20, now + DAY, now);
  expect(calibrateRate(store, plans[0]!, priceOf, now)).toBeCloseTo(30 * OPENAI_POINT / 14.505, 9);
  const window = personUsage(store, now - DAY, now, priceOf, plans);
  const byPrincipal = Object.fromEntries(window.rows.map(row => [row.principal ?? "owner", row]));
  expect(byPrincipal.owner!.spend).toBeCloseTo(30 * OPENAI_POINT * 12 / 14.505, 9);
  expect(byPrincipal.owner!.sources.fleet.spend).toBeCloseTo(30 * OPENAI_POINT * 2 / 14.505, 9);
  expect(byPrincipal.sybil!.spend).toBeCloseTo(30 * OPENAI_POINT * 2.5 / 14.505, 9);
  expect(byPrincipal.jodie).toMatchObject({ tokens: 500, value: 0.005, unpricedTokens: 0 });
  expect(byPrincipal.jodie!.spend).toBeCloseTo(30 * OPENAI_POINT * 0.005 / 14.505, 9);
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

test("a reset meter rounded to zero retains the last positive rate rather than freezing zero-dollar hours", () => ledger(store => {
  const start = 20 * DAY;
  store.upsertAccount({ id: "codex-1", provider: "openai-codex" });
  record(store, "codex-1", "interactive", "broker:sybil:1", "output", 1_000_000, start);
  store.recordMeter("codex-1", "codex-7d", 10, start + 5 * DAY, start + HOUR / 2);
  const prior = personUsage(store, start, start + HOUR, priceOf, plans).subscriptions[0]!.rate!;
  record(store, "codex-1", "interactive", "broker:sybil:2", "output", 1_000_000, start + HOUR);
  store.recordMeter("codex-1", "codex-7d", 0, start + 8 * DAY, start + HOUR + 1);
  expect(calibrateRate(store, plans[0]!, priceOf, start + 2 * HOUR)).toBeNull();
  const next = personUsage(store, start + HOUR, start + 2 * HOUR, priceOf, plans);
  expect(next.rows[0]!.spend).toBeCloseTo(10 * prior);
  expect(next.subscriptions[0]!.rate).toBe(prior);
}));

test("opening a ledger repairs frozen zero rates from a rounded reset", () => {
  const root = mkdtempSync(join(tmpdir(), "person-usage-"));
  const path = join(root, "ledger.sqlite3");
  try {
    const store = Store.open(path);
    store.db.exec(`INSERT INTO usage_rate(provider,hour,rate) VALUES ('openai-codex',0,0.025),('openai-codex',3600000,0),('openai-codex',7200000,0),('anthropic',0,0)`);
    store.close();
    const reopened = Store.open(path);
    expect(reopened.db.prepare("SELECT hour,rate FROM usage_rate WHERE provider='openai-codex' ORDER BY hour").all()).toEqual([
      { hour: 0, rate: 0.025 }, { hour: HOUR, rate: 0.025 }, { hour: 2 * HOUR, rate: 0.025 },
    ]);
    expect(reopened.db.prepare("SELECT count(*) count FROM usage_rate WHERE provider='anthropic'").get()).toEqual({ count: 0 });
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("list prices share every pooled custom definition with routing and retain retired models", () => {
  const prices = modelPrices();
  for (const [id, config] of Object.entries(customModelConfig.providers)) {
    const provider = withCustomModels(builtinProviders().find(provider => provider.id === id)!);
    for (const custom of config.models) {
      const routed = provider.getModels().find(model => model.id === custom.id)!;
      expect(prices.get(custom.id)).toEqual(Object.fromEntries(
        (["input", "output", "cacheRead", "cacheWrite"] as const).map(component => [component, routed.cost[component]]),
      ));
    }
  }
  expect(prices.get("gpt-6-sol")?.input).toBeGreaterThan(0);
  expect(prices.get("gpt-6-astra")?.input).toBeGreaterThan(0);
});

test("Sol 6.1 prices every component and calibrates without rewriting historical usage or frozen rates", () => ledger(store => {
  const start = 20 * DAY, now = start + 2 * HOUR;
  store.upsertAccount({ id: "codex-1", provider: "openai-codex" });
  for (const hour of [start, start + HOUR]) {
    for (const component of ["input", "output", "cacheRead", "cacheWrite"] as const)
      record(store, "codex-1", "fleet", "sol-run", component, 1_000_000, hour, "gpt-6.1-sol");
  }
  store.recordMeter("codex-1", "codex-7d", 10, start + 5 * DAY, now);
  store.db.prepare("INSERT INTO usage_rate(provider, hour, rate) VALUES (?, ?, ?)").run("openai-codex", start, 0.5);
  const evidence = store.db.prepare("SELECT * FROM usage_hour ORDER BY hour, component").all();
  expect(modelPrices().get("gpt-6.1-sol")).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  expect(calibrateRate(store, plans[0]!, undefined, now)).toBeCloseTo(10 * OPENAI_POINT / 29.4, 9);
  const window = personUsage(store, start, now, undefined, plans);
  expect(window.rows[0]).toMatchObject({ tokens: 8_000_000, value: 29.4, unpricedTokens: 0 });
  expect(window.rows[0]!.spend).toBeCloseTo(14.7 * 0.5 + 10 * OPENAI_POINT / 2, 9);
  expect(store.db.prepare("SELECT rate FROM usage_rate WHERE provider=? AND hour=?").get("openai-codex", start)).toEqual({ rate: 0.5 });
  expect(store.db.prepare("SELECT * FROM usage_hour ORDER BY hour, component").all()).toEqual(evidence);
}));

test("unknown prices remain explicit and cannot bias calibration with a partial account denominator", () => ledger(store => {
  const now = 20 * DAY, hour = now - HOUR;
  store.upsertAccount({ id: "partial", provider: "openai-codex" });
  record(store, "partial", "interactive", "broker:sybil:1", "output", 1_000_000, hour);
  record(store, "partial", "interactive", "broker:sybil:2", "output", 1000, hour, "unknown-model");
  store.recordMeter("partial", "codex-7d", 20, now + DAY, now);
  expect(calibrateRate(store, plans[0]!, priceOf, now)).toBeNull();
  const window = personUsage(store, hour, now, priceOf, plans);
  expect(window.rows[0]).toMatchObject({ value: 10, spend: 0, unpricedTokens: 1000 });
  expect(window.subscriptions[0]!.rate).toBeNull();
  expect(store.db.prepare("SELECT * FROM usage_rate").all()).toEqual([]);
  store.upsertAccount({ id: "priced", provider: "openai-codex" });
  record(store, "priced", "interactive", "owner-session", "output", 2_000_000, hour);
  store.recordMeter("priced", "codex-7d", 5, now + DAY, now);
  expect(calibrateRate(store, plans[0]!, priceOf, now)).toBeCloseTo(5 * OPENAI_POINT / 20, 9);
}));
