import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import customModelConfig from "./models.json" with { type: "json" };
import { ORCHESTRATOR_CATALOG, type PlanDefinition } from "./catalog.js";
import type { UsageComponent } from "./domain.js";
import type { Store } from "./store.js";

/**
 * Who spent this ledger's subscriptions. Ordinary Unix users reach providers
 * only through the model broker, whose leases are named `broker:<principal>:<id>`,
 * and their broker completions carry the principal in the completion's access
 * record. Everything else in the ledger was spent by the ledger's own owner:
 * her interactive sessions, her fleet and her completions. The owner has no
 * principal here because the ledger does not know its own Unix name.
 *
 * The money actually paid is the subscriptions: every enabled account costs
 * its plan's monthly price. Each provider gets one rate, dollars of
 * subscription per dollar of list-price value, measured over a trailing rate
 * window of at least a week: that window's prorated cost divided by all the
 * value used in it. A person's spend is her value times that rate, so a
 * shorter period is always a part of a longer one. Dividing each period's own
 * cost among whoever happened to be active in it did not have that property:
 * on a quiet day a light user absorbed most of the day's fixed cost and her
 * day could exceed her week. List-price value weighs a cache read against
 * fresh output the way the provider's quota roughly does. Providers are rated
 * separately, so an expensive Anthropic token does not take a share of the
 * OpenAI bill.
 */
export interface PersonUsageRow {
  /** Broker principal (a Unix user name), or null for the ledger's owner. */
  readonly principal: string | null;
  /** Fresh input + output + cache reads + cache writes. */
  readonly tokens: number;
  /** API-list-price value in US dollars of the priced tokens. */
  readonly value: number;
  /** This person's part of the window's subscription cost, in US dollars. */
  readonly spend: number;
  /** Tokens from models with no known list price; they add nothing to `value`. */
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
  /** accounts × monthlyUsd, prorated to the window. */
  readonly spend: number;
  /** The part of `spend` nobody used in the window. */
  readonly idle: number;
  /** Subscription dollars per list-price dollar over the rate window; null when nothing was priced there. */
  readonly rate: number | null;
  readonly rateSince: string;
}

export interface PersonUsageWindow {
  readonly since: string;
  readonly until: string;
  readonly subscriptions: readonly SubscriptionSpend[];
  readonly rows: readonly PersonUsageRow[];
}

type UsageSource = "interactive" | "fleet" | "completion";
type Price = Record<UsageComponent, number>;
const COMPONENTS: readonly UsageComponent[] = ["input", "output", "cacheRead", "cacheWrite"];
const POOLED_PROVIDERS = new Set(["openai-codex", "anthropic"]);
/** Monthly plan prices are prorated over a 30-day month, as `pi-user-usage` does. */
export const SUBSCRIPTION_MONTH_MS = 30 * 24 * 3_600_000;
/** The shortest window a provider's rate is measured over. */
export const SUBSCRIPTION_RATE_WINDOW_MS = 7 * 24 * 3_600_000;

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

const PRINCIPAL_SQL = `
SELECT CASE
    WHEN u.run_id LIKE 'broker:%' THEN substr(u.run_id, 8, instr(substr(u.run_id, 8), ':') - 1)
    WHEN u.source = 'completion' THEN json_extract(c.value, '$.access.principal')
  END principal,
  a.provider provider, u.source source, u.model model, u.component component, SUM(u.tokens) tokens
FROM usage_hour u
LEFT JOIN account a ON a.id = u.account_id
LEFT JOIN control r ON u.source = 'completion' AND r.key = 'completion-run:' || u.run_id
LEFT JOIN control c ON r.value IS NOT NULL AND c.key = 'completion:' || r.value
WHERE u.hour >= ? AND u.hour < ?
GROUP BY 1, 2, 3, 4, 5`;

type Row = { principal: string | null; provider: string | null; source: string; model: string; component: UsageComponent; tokens: number };
type Mutable = { tokens: number; value: number; spend: number };
type Person = { principal: string | null; unpricedTokens: number; total: Mutable; sources: Record<UsageSource, Mutable>; providers: Record<string, Mutable> };

const figures = (): Mutable => ({ tokens: 0, value: 0, spend: 0 });
const providerOf = (row: Row) => row.provider ?? (row.model.startsWith("claude-") ? "anthropic" : "openai-codex");

function readCells(store: Store, since: number, until: number, priceOf: (model: string) => Price | undefined) {
  return (store.db.prepare(PRINCIPAL_SQL).all(since, until) as Row[]).map(row => {
    const price = priceOf(row.model);
    return { row, provider: providerOf(row), priced: Boolean(price), value: price ? row.tokens * price[row.component] / 1_000_000 : 0 };
  });
}

/** Token use, list-price value and each person's part of the subscription cost
 * for the hour buckets that start in [since, until). */
export function personUsage(
  store: Store,
  since: number,
  until = Date.now(),
  priceOf: (model: string) => Price | undefined = model => modelPrices().get(model),
  plans: readonly PlanDefinition[] = ORCHESTRATOR_CATALOG.plans,
  rateWindowMs = SUBSCRIPTION_RATE_WINDOW_MS,
): PersonUsageWindow {
  const rateSince = Math.min(since, until - rateWindowMs);
  const cells = readCells(store, since, until, priceOf);
  const rateCells = rateSince === since ? cells : readCells(store, rateSince, until, priceOf);
  const enabled = new Map<string, number>();
  for (const account of store.accounts()) if (account.enabled) enabled.set(account.provider, (enabled.get(account.provider) ?? 0) + 1);

  // Dollars of subscription per unit of weight, per provider. Value is the
  // weight; a provider whose models are all unpriced falls back to tokens.
  const rates = new Map<string, { byValue: boolean; rate: number }>();
  const subscriptions: SubscriptionSpend[] = [];
  for (const plan of plans) {
    const accounts = enabled.get(plan.provider) ?? 0;
    const monthly = accounts * plan.monthlyUsd;
    const mine = rateCells.filter(cell => cell.provider === plan.provider);
    const value = mine.reduce((sum, cell) => sum + cell.value, 0);
    const tokens = mine.reduce((sum, cell) => sum + cell.row.tokens, 0);
    const rateCost = monthly * (until - rateSince) / SUBSCRIPTION_MONTH_MS;
    const byValue = value > 0;
    const rate = byValue ? rateCost / value : tokens > 0 ? rateCost / tokens : 0;
    rates.set(plan.provider, { byValue, rate });
    const used = cells.some(cell => cell.provider === plan.provider && cell.row.tokens > 0);
    const spend = monthly * (until - since) / SUBSCRIPTION_MONTH_MS;
    subscriptions.push({ planId: plan.id, label: plan.label, provider: plan.provider, accounts, monthlyUsd: plan.monthlyUsd, spend, idle: used ? 0 : spend, rate: byValue ? rate : null, rateSince: new Date(rateSince).toISOString() });
  }

  const people = new Map<string | null, Person>();
  for (const { row, provider, priced, value } of cells) {
    const principal = row.principal || null;
    let person = people.get(principal);
    if (!person) people.set(principal, person = { principal, unpricedTokens: 0, total: figures(), sources: { interactive: figures(), fleet: figures(), completion: figures() }, providers: {} });
    const source: UsageSource = row.source in person.sources ? row.source as UsageSource : "interactive";
    const rate = rates.get(provider);
    const spend = rate ? (rate.byValue ? value : row.tokens) * rate.rate : 0;
    if (!priced) person.unpricedTokens += row.tokens;
    for (const target of [person.total, person.sources[source], person.providers[provider] ??= figures()]) {
      target.tokens += row.tokens;
      target.value += value;
      target.spend += spend;
    }
  }

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
export const PERSONAL_USAGE_PERIODS: Readonly<Record<PersonalUsagePeriod, number>> = { day: 24 * 3_600_000, week: 7 * 24 * 3_600_000 };

/** One person's part of each plan's subscription cost over the last day and week. */
export interface PersonalUsage {
  readonly periods: Readonly<Record<PersonalUsagePeriod, {
    readonly since: string;
    readonly until: string;
    /** Keyed by catalog plan id. */
    readonly plans: Readonly<Record<string, UsageFigures>>;
  }>>;
}

/** `principal` is a broker principal, or null for the ledger's own owner. */
export function personalUsage(store: Store, principal: string | null, now = Date.now(), plans: readonly PlanDefinition[] = ORCHESTRATOR_CATALOG.plans): PersonalUsage {
  const periods = Object.fromEntries(Object.entries(PERSONAL_USAGE_PERIODS).map(([period, windowMs]) => {
    const window = personUsage(store, now - windowMs, now, undefined, plans);
    const row = window.rows.find(candidate => candidate.principal === principal);
    return [period, {
      since: window.since,
      until: window.until,
      plans: Object.fromEntries(plans.map(plan => [plan.id, row?.providers[plan.provider] ?? { tokens: 0, value: 0, spend: 0 }])),
    }];
  }));
  return { periods: periods as PersonalUsage["periods"] };
}
