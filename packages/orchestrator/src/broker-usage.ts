import { cachePercent, planUsage, type PlanAccountUsage, type PlanMetricUsage, type PlanUsage, type PlanUsageSnapshot } from "./client.js";
import { ORCHESTRATOR_CATALOG } from "./catalog.js";
import { personalUsage, personUsage, weekResetsAt, weekStart, type PersonalUsage } from "./person-usage.js";
import type { Store } from "./store.js";

/** `GET` on a principal's broker listener: the shared plans she can draw on and what she spent of them. */
export const BROKER_USAGE_PATH = "/v1/usage";

export interface BrokerUsage {
  /** Meters of the enabled accounts in her grant. Account labels are replaced by their aliases. */
  readonly plans: PlanUsageSnapshot;
  readonly personal: PersonalUsage;
  /** Her weekly spending limit, or null when she has none. */
  readonly allowance: WeeklyAllowance | null;
}

/** A principal's cap on subscription dollars per week, from Monday 00:00 local time to the next. */
export interface WeeklyAllowance { readonly weeklyUsd: number; readonly usedUsd: number; readonly resetsAt: string }

export function allowanceRefusal(weeklyUsd: number, now = Date.now()): string {
  const resets = new Intl.DateTimeFormat("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(weekResetsAt(now)));
  return `Your weekly model allowance of $${weeklyUsd} is used up. It resets ${resets}.`;
}

/** Spending since this week's reset per principal, reread at most every
 * `maxAgeMs` so admission does not scan the ledger on every model request. */
export class WeeklyAllowances {
  private readonly cache = new Map<string, { at: number; usd: number }>();
  constructor(private readonly store: Store) {}
  spent(principal: string, maxAgeMs = 30_000, now = Date.now()): number {
    const cached = this.cache.get(principal);
    if (cached && now - cached.at < maxAgeMs) return cached.usd;
    const window = personUsage(this.store, weekStart(now), now);
    const usd = window.rows.find(row => row.principal === principal)?.spend ?? 0;
    this.cache.set(principal, { at: now, usd });
    return usd;
  }
}

/** The broker's answer for one principal. It carries aliases, meters and her
 * own totals, never other people's usage or an account's private label. */
export function brokerUsage(store: Store, principal: string, accounts: readonly string[], now = Date.now(), allowance: WeeklyAllowance | null = null): BrokerUsage {
  const granted = new Set(accounts);
  const plans = planUsage(store, undefined, now, account => granted.has(account.id));
  return {
    plans: {
      ...plans,
      plans: Object.fromEntries(Object.entries(plans.plans).map(([id, usage]) => [id, {
        ...usage,
        metrics: Object.fromEntries(Object.entries(usage.metrics).map(([metricId, metric]) => [metricId, {
          ...metric,
          accounts: metric.accounts.map(account => ({ ...account, accountLabel: account.accountId })),
        }])),
      }])),
    },
    personal: personalUsage(store, principal, now),
    allowance,
  };
}

/** Retained ledgers keep their usage evidence and frozen rates. Sum each ledger once;
 * meter observations for the same granted alias select the newest observation. */
export function brokerUsageAcrossStores(stores: readonly Store[], principal: string, accounts: readonly string[], now = Date.now(), allowance: WeeklyAllowance | null = null): BrokerUsage {
  if (!stores.length || new Set(stores.map(store => store.path)).size !== stores.length) throw new Error("Broker usage requires unique declared ledger owners");
  if (stores.length === 1) return brokerUsage(stores[0]!, principal, accounts, now, allowance);
  const snapshots = stores.map(store => brokerUsage(store, principal, accounts, now));
  const totals = stores.flatMap(store => store.usageSince(now - 24 * 3_600_000));
  const mean = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  const plans: Record<string, PlanUsage> = {};
  for (const definition of ORCHESTRATOR_CATALOG.plans) {
    const metrics: Record<string, PlanMetricUsage> = {};
    const counts: number[] = [];
    const accountIds = new Set<string>();
    for (const metric of definition.metrics) {
      const observations = new Map<string, PlanAccountUsage>();
      for (const snapshot of snapshots) for (const account of snapshot.plans.plans[definition.id]?.metrics[metric.id]?.accounts ?? []) {
        const previous = observations.get(account.accountId);
        if (!previous || (account.readingAt ? Date.parse(account.readingAt) : -Infinity) > (previous.readingAt ? Date.parse(previous.readingAt) : -Infinity)) observations.set(account.accountId, account);
      }
      const observed = [...observations.values()], ready = observed.filter(account => account.state === "ready");
      for (const account of observed) accountIds.add(account.accountId);
      counts.push(ready.length);
      const expected = ready.flatMap(account => account.resetAt && account.windowHours && Date.parse(account.resetAt) > now
        ? [Math.max(0, Math.min(100, (Date.parse(account.resetAt) - now) * 100 / (account.windowHours * 3_600_000)))] : []);
      const percentLeft = mean(ready.flatMap(account => account.percentLeft === null ? [] : [account.percentLeft])), expectedPercentLeft = mean(expected);
      metrics[metric.id] = { accounts: observed, percentLeft, expectedPercentLeft,
        paceDelta: percentLeft === null || expectedPercentLeft === null ? null : percentLeft - expectedPercentLeft,
        cachePercent: cachePercent(totals, metric.model, new Set(observations.keys())) };
    }
    const checkedCount = counts.length ? Math.min(...counts) : 0;
    plans[definition.id] = { metrics, planCount: accountIds.size, checkedCount,
      state: accountIds.size && checkedCount === accountIds.size ? "ready" : checkedCount ? "partial" : "unavailable" };
  }
  const personal = snapshots[0]!.personal;
  const periods = Object.fromEntries((["day", "week"] as const).map(period => {
    const combined: Record<string, { tokens: number; value: number; spend: number }> = {};
    for (const snapshot of snapshots) for (const [planId, figures] of Object.entries(snapshot.personal.periods[period].plans)) {
      const sum = combined[planId] ??= { tokens: 0, value: 0, spend: 0 };
      sum.tokens += figures.tokens; sum.value += figures.value; sum.spend += figures.spend;
    }
    return [period, { since: personal.periods[period].since, until: personal.periods[period].until, plans: combined }];
  })) as PersonalUsage["periods"];
  return { plans: { plans, updatedAt: new Date(now).toISOString() }, personal: { periods, weekResetsAt: personal.weekResetsAt }, allowance };
}

/** Reads the caller's own usage from her broker listener. */
export async function readBrokerUsage(brokerUrl: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<BrokerUsage> {
  const response = await fetch(new URL(BROKER_USAGE_PATH, brokerUrl), { signal });
  if (!response.ok) throw new Error(`Model broker usage returned HTTP ${response.status}`);
  return await response.json() as BrokerUsage;
}
