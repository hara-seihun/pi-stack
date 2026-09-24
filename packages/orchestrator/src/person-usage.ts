import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import customModelConfig from "./models.json" with { type: "json" };
import { catalogMeter, ORCHESTRATOR_CATALOG, type PlanDefinition } from "./catalog.js";
import type { UsageComponent } from "./domain.js";
import type { Store } from "./store.js";

/**
 * Who spent this ledger's subscriptions, in dollars of subscription actually used.
 *
 * Ordinary Unix users reach providers only through the model broker, whose
 * leases are named `broker:<principal>:<id>`, and their broker completions
 * carry the principal in the completion's access record. Everything else in
 * the ledger was spent by the ledger's own owner: her interactive sessions,
 * her fleet and her completions. The owner has no principal here because the
 * ledger does not know its own Unix name.
 *
 * Dollars come from quota, not from assuming every plan is fully used. Each
 * account's weekly meter says what percentage of its week it has consumed
 * since its window began, and one percentage point costs 1% of a week of the
 * plan. Dividing the pool's consumed-quota dollars by the list-price value
 * those accounts served in the same windows gives one rate per provider:
 * subscription dollars per list-price dollar. List-price value weighs a cache
 * read against fresh output the way the provider's quota roughly does, and
 * providers are rated separately.
 *
 * Rates are frozen per provider-hour in `usage_rate` the first time an hour
 * is priced, so a person's spend for a past hour never changes afterwards and
 * her total since any fixed moment only grows. Hours priced before any
 * calibration existed take the first calibration available.
 */
export interface PersonUsageRow {
  /** Broker principal (a Unix user name), or null for the ledger's owner. */
  readonly principal: string | null;
  /** Fresh input + output + cache reads + cache writes. */
  readonly tokens: number;
  /** API-list-price value in US dollars of the priced tokens. */
  readonly value: number;
  /** Dollars of subscription this person actually used in the window. */
  readonly spend: number;
  /** Tokens from models with no known list price; they add nothing to `value` or `spend`. */
  readonly unpricedTokens: number;
  /** The same figures split by what spent them. `fleet` is background workers. */
  readonly sources: Readonly<Record<UsageSource, UsageFigures>>;
  /** The same figures split by provider family. */
  readonly providers: Readonly<Record<string, UsageFigures>>;
}

export interface UsageFigures { readonly tokens: number; readonly value: number; readonly spend: number }

/** One provider's subscriptions over the window. */
export interface SubscriptionSpend {
  readonly planId: string;
  readonly label: string;
  readonly provider: string;
  readonly accounts: number;
  readonly monthlyUsd: number;
  /** What the enabled accounts cost over the window: accounts × monthlyUsd, prorated. */
  readonly spend: number;
  /** Dollars of that subscription the window actually used, at the frozen hourly rates. */
  readonly used: number;
  /** The newest hourly rate in the window, subscription dollars per list-price dollar. */
  readonly rate: number | null;
}

export interface PersonUsageWindow {
  readonly since: string;
  readonly until: string;
  readonly subscriptions: readonly SubscriptionSpend[];
  readonly rows: readonly PersonUsageRow[];
}

type UsageSource = "interactive" | "fleet" | "completion";
type Price = Record<UsageComponent, number>;
type PriceOf = (model: string) => Price | undefined;
const COMPONENTS: readonly UsageComponent[] = ["input", "output", "cacheRead", "cacheWrite"];
const POOLED_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const HOUR = 3_600_000;
/** Monthly plan prices are prorated over a 30-day month, as `pi-user-usage` does. */
export const SUBSCRIPTION_MONTH_MS = 30 * 24 * HOUR;
/** A meter reading older than this does not calibrate a rate. */
const CALIBRATION_READING_AGE_MS = 6 * HOUR;

let prices: Map<string, Price> | undefined;

/** List prices per million tokens for every model the pooled providers have
 * served, including ones the catalog no longer offers: old usage still cost. */
export function modelPrices(): Map<string, Price> {
  if (prices) return prices;
  const map = new Map<string, Price>();
  const models = [
    ...builtinProviders().filter(provider => POOLED_PROVIDERS.has(provider.id)).flatMap(provider => [...provider.getModels()]),
    ...customModelConfig.providers.anthropic.models,
  ] as Array<{ id: string; cost?: Partial<Price> }>;
  for (const model of models) {
    const cost = model.cost;
    if (!cost || COMPONENTS.every(component => !cost[component])) continue;
    map.set(model.id, Object.fromEntries(COMPONENTS.map(component => [component, Number(cost[component] ?? 0)])) as Price);
  }
  prices = map;
  return map;
}

const defaultPrice: PriceOf = model => modelPrices().get(model);
const valueOf = (priceOf: PriceOf, model: string, component: UsageComponent, tokens: number) => {
  const price = priceOf(model);
  return price ? tokens * price[component] / 1_000_000 : 0;
};

/**
 * The provider's current rate from its accounts' latest weekly readings:
 * consumed-quota dollars over the list-price value those accounts served
 * since each one's window began. An account whose meter moved without any
 * usage in this ledger (traffic from elsewhere) is left out. Null without a
 * fresh reading on an account this ledger used.
 */
export function calibrateRate(store: Store, plan: PlanDefinition, priceOf: PriceOf = defaultPrice, now = Date.now()): number | null {
  const meter = catalogMeter(plan.quotaMeter);
  if (!meter) return null;
  const windowMs = meter.windowHours * HOUR;
  const pointUsd = plan.monthlyUsd * windowMs / SUBSCRIPTION_MONTH_MS / 100;
  const windows = store.accounts().filter(account => account.provider === plan.provider).flatMap(account => {
    const reading = store.latestReading(account.id, plan.quotaMeter);
    if (!reading || now - reading.at > CALIBRATION_READING_AGE_MS || !reading.resetAt || reading.resetAt <= now) return [];
    return [{ id: account.id, since: Math.floor((reading.resetAt - windowMs) / HOUR) * HOUR, usedPercent: reading.usedPercent }];
  });
  if (!windows.length) return null;
  const earliest = Math.min(...windows.map(window => window.since));
  const rows = store.db.prepare(`SELECT account_id, hour, model, component, SUM(tokens) tokens FROM usage_hour
    WHERE hour >= ? AND hour < ? AND account_id IN (${windows.map(() => "?").join(",")}) GROUP BY 1, 2, 3, 4`)
    .all(earliest, now, ...windows.map(window => window.id)) as Array<{ account_id: string; hour: number; model: string; component: UsageComponent; tokens: number }>;
  let cost = 0, value = 0;
  for (const window of windows) {
    const served = rows.filter(row => row.account_id === window.id && row.hour >= window.since)
      .reduce((sum, row) => sum + valueOf(priceOf, row.model, row.component, row.tokens), 0);
    if (served <= 0) continue;
    cost += window.usedPercent * pointUsd;
    value += served;
  }
  return value > 0 ? cost / value : null;
}

/** Frozen hourly rates for [since, until), freezing each hour up to `now` that has none yet. */
export function hourlyRates(store: Store, since: number, until: number, plans: readonly PlanDefinition[] = ORCHESTRATOR_CATALOG.plans, priceOf: PriceOf = defaultPrice, now = Date.now()): Map<string, Map<number, number>> {
  const first = Math.floor(since / HOUR) * HOUR;
  const rates = new Map<string, Map<number, number>>();
  const of = (provider: string) => rates.get(provider) ?? rates.set(provider, new Map()).get(provider)!;
  for (const row of store.db.prepare("SELECT provider, hour, rate FROM usage_rate WHERE hour >= ? AND hour < ?").all(first, until) as Array<{ provider: string; hour: number; rate: number }>) of(row.provider).set(row.hour, row.rate);
  const insert = store.db.prepare("INSERT OR IGNORE INTO usage_rate(provider, hour, rate) VALUES (?, ?, ?)");
  for (const plan of plans) {
    const mine = of(plan.provider);
    let current: number | null | undefined;
    for (let hour = first; hour < until && hour <= now; hour += HOUR) {
      if (mine.has(hour)) continue;
      current ??= calibrateRate(store, plan, priceOf, now)
        ?? (store.db.prepare("SELECT rate FROM usage_rate WHERE provider = ? ORDER BY hour DESC LIMIT 1").get(plan.provider) as { rate: number } | undefined)?.rate
        ?? null;
      if (current === null) break;
      mine.set(hour, current);
      try { insert.run(plan.provider, hour, current); } catch { /* a read-only ledger prices without freezing */ }
    }
  }
  return rates;
}

const PRINCIPAL_SQL = `
SELECT CASE
    WHEN u.run_id LIKE 'broker:%' THEN substr(u.run_id, 8, instr(substr(u.run_id, 8), ':') - 1)
    WHEN u.source = 'completion' THEN json_extract(c.value, '$.access.principal')
  END principal,
  a.provider provider, u.hour hour, u.source source, u.model model, u.component component, SUM(u.tokens) tokens
FROM usage_hour u
LEFT JOIN account a ON a.id = u.account_id
LEFT JOIN control r ON u.source = 'completion' AND r.key = 'completion-run:' || u.run_id
LEFT JOIN control c ON r.value IS NOT NULL AND c.key = 'completion:' || r.value
WHERE u.hour >= ? AND u.hour < ?
GROUP BY 1, 2, 3, 4, 5, 6`;

type Row = { principal: string | null; provider: string | null; hour: number; source: string; model: string; component: UsageComponent; tokens: number };
type Mutable = { tokens: number; value: number; spend: number };
type Person = { principal: string | null; unpricedTokens: number; total: Mutable; sources: Record<UsageSource, Mutable>; providers: Record<string, Mutable> };

const figures = (): Mutable => ({ tokens: 0, value: 0, spend: 0 });
const providerOf = (row: { provider: string | null; model: string }) => row.provider ?? (row.model.startsWith("claude-") ? "anthropic" : "openai-codex");

/** Token use, list-price value and each person's dollars of subscription
 * actually used, for the hour buckets that start in [since, until). */
export function personUsage(
  store: Store,
  since: number,
  until = Date.now(),
  priceOf: PriceOf = defaultPrice,
  plans: readonly PlanDefinition[] = ORCHESTRATOR_CATALOG.plans,
  now = until,
): PersonUsageWindow {
  const rows = store.db.prepare(PRINCIPAL_SQL).all(since, until) as Row[];
  const rates = hourlyRates(store, since, until, plans, priceOf, now);
  const enabled = new Map<string, number>();
  for (const account of store.accounts()) if (account.enabled) enabled.set(account.provider, (enabled.get(account.provider) ?? 0) + 1);
  const used = new Map<string, number>();

  const people = new Map<string | null, Person>();
  for (const row of rows) {
    const principal = row.principal || null;
    let person = people.get(principal);
    if (!person) people.set(principal, person = { principal, unpricedTokens: 0, total: figures(), sources: { interactive: figures(), fleet: figures(), completion: figures() }, providers: {} });
    const provider = providerOf(row);
    const value = valueOf(priceOf, row.model, row.component, row.tokens);
    const spend = value * (rates.get(provider)?.get(row.hour) ?? 0);
    used.set(provider, (used.get(provider) ?? 0) + spend);
    const source: UsageSource = row.source in person.sources ? row.source as UsageSource : "interactive";
    if (!priceOf(row.model)) person.unpricedTokens += row.tokens;
    for (const target of [person.total, person.sources[source], person.providers[provider] ??= figures()]) {
      target.tokens += row.tokens;
      target.value += value;
      target.spend += spend;
    }
  }

  const subscriptions: SubscriptionSpend[] = plans.map(plan => {
    const accounts = enabled.get(plan.provider) ?? 0;
    const newest = [...(rates.get(plan.provider)?.entries() ?? [])].sort((a, b) => b[0] - a[0])[0];
    return {
      planId: plan.id, label: plan.label, provider: plan.provider, accounts, monthlyUsd: plan.monthlyUsd,
      spend: accounts * plan.monthlyUsd * (until - since) / SUBSCRIPTION_MONTH_MS,
      used: used.get(plan.provider) ?? 0,
      rate: newest?.[1] ?? null,
    };
  });

  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    subscriptions,
    rows: [...people.values()]
      .map(person => ({ principal: person.principal, tokens: person.total.tokens, value: person.total.value, spend: person.total.spend, unpricedTokens: person.unpricedTokens, sources: person.sources, providers: person.providers }))
      .sort((a, b) => b.spend - a.spend || b.value - a.value || b.tokens - a.tokens),
  };
}

export type PersonalUsagePeriod = "day" | "week";

/** Local midnight today. */
export function dayStart(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday 00:00 local time: the start of the week personal figures and limits count from. */
export function weekStart(now = Date.now()): number {
  const date = new Date(dayStart(now));
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date.getTime();
}

/** When the week that contains `now` resets. */
export function weekResetsAt(now = Date.now()): number {
  const date = new Date(weekStart(now));
  date.setDate(date.getDate() + 7);
  return date.getTime();
}

/** One person's dollars of each plan today and this week. Both only grow until they reset. */
export interface PersonalUsage {
  readonly periods: Readonly<Record<PersonalUsagePeriod, {
    readonly since: string;
    readonly until: string;
    /** Keyed by catalog plan id. */
    readonly plans: Readonly<Record<string, UsageFigures>>;
  }>>;
  readonly weekResetsAt: string;
}

/** `principal` is a broker principal, or null for the ledger's own owner. */
export function personalUsage(store: Store, principal: string | null, now = Date.now(), plans: readonly PlanDefinition[] = ORCHESTRATOR_CATALOG.plans): PersonalUsage {
  const starts: Record<PersonalUsagePeriod, number> = { day: dayStart(now), week: weekStart(now) };
  const periods = Object.fromEntries(Object.entries(starts).map(([period, since]) => {
    const window = personUsage(store, since, now, undefined, plans);
    const row = window.rows.find(candidate => candidate.principal === principal);
    return [period, {
      since: window.since,
      until: window.until,
      plans: Object.fromEntries(plans.map(plan => [plan.id, row?.providers[plan.provider] ?? { tokens: 0, value: 0, spend: 0 }])),
    }];
  }));
  return { periods: periods as PersonalUsage["periods"], weekResetsAt: new Date(weekResetsAt(now)).toISOString() };
}
