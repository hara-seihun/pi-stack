import { planUsage, type PlanUsageSnapshot } from "./client.js";
import { personalUsage, personUsage, SUBSCRIPTION_RATE_WINDOW_MS, type PersonalUsage } from "./person-usage.js";
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

/** A principal's cap on subscription dollars over any trailing seven days. */
export interface WeeklyAllowance { readonly weeklyUsd: number; readonly usedUsd: number }

export function allowanceRefusal(weeklyUsd: number): string {
  return `Your weekly model allowance of $${weeklyUsd} is used up. It frees up as your use from seven days ago ages out.`;
}

/** Trailing-week spending per principal, reread at most every `maxAgeMs` so
 * admission does not scan the ledger on every model request. */
export class WeeklyAllowances {
  private readonly cache = new Map<string, { at: number; usd: number }>();
  constructor(private readonly store: Store) {}
  spent(principal: string, maxAgeMs = 30_000, now = Date.now()): number {
    const cached = this.cache.get(principal);
    if (cached && now - cached.at < maxAgeMs) return cached.usd;
    const window = personUsage(this.store, now - SUBSCRIPTION_RATE_WINDOW_MS, now);
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

/** Reads the caller's own usage from her broker listener. */
export async function readBrokerUsage(brokerUrl: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<BrokerUsage> {
  const response = await fetch(new URL(BROKER_USAGE_PATH, brokerUrl), { signal });
  if (!response.ok) throw new Error(`Model broker usage returned HTTP ${response.status}`);
  return await response.json() as BrokerUsage;
}
