import { planUsage, type PlanUsageSnapshot } from "./client.js";
import { personalUsage, type PersonalUsage } from "./person-usage.js";
import type { Store } from "./store.js";

/** `GET` on a principal's broker listener: the shared plans she can draw on and what she spent of them. */
export const BROKER_USAGE_PATH = "/v1/usage";

export interface BrokerUsage {
  /** Meters of the enabled accounts in her grant. Account labels are replaced by their aliases. */
  readonly plans: PlanUsageSnapshot;
  readonly personal: PersonalUsage;
}

/** The broker's answer for one principal. It carries aliases, meters and her
 * own totals, never other people's usage or an account's private label. */
export function brokerUsage(store: Store, principal: string, accounts: readonly string[], now = Date.now()): BrokerUsage {
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
  };
}

/** Reads the caller's own usage from her broker listener. */
export async function readBrokerUsage(brokerUrl: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<BrokerUsage> {
  const response = await fetch(new URL(BROKER_USAGE_PATH, brokerUrl), { signal });
  if (!response.ok) throw new Error(`Model broker usage returned HTTP ${response.status}`);
  return await response.json() as BrokerUsage;
}
