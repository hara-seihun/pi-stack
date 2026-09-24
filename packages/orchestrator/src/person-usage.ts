import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import customModelConfig from "./models.json" with { type: "json" };
import type { UsageComponent } from "./domain.js";
import type { Store } from "./store.js";

/**
 * Who spent this ledger's tokens. Ordinary Unix users reach providers only
 * through the model broker, whose leases are named `broker:<principal>:<id>`,
 * and their broker completions carry the principal in the completion's access
 * record. Everything else in the ledger was spent by the ledger's own owner:
 * her interactive sessions, her fleet and her completions. The owner has no
 * principal here because the ledger does not know its own Unix name.
 */
export interface PersonUsageRow {
  /** Broker principal (a Unix user name), or null for the ledger's owner. */
  readonly principal: string | null;
  /** Fresh input + output + cache reads + cache writes. */
  readonly tokens: number;
  /** API-list-price value in US dollars of the priced tokens. */
  readonly value: number;
  /** Tokens from models with no known list price; they add nothing to `value`. */
  readonly unpricedTokens: number;
  /** The same figures split by what spent them. `fleet` is background workers. */
  readonly sources: Readonly<Record<"interactive" | "fleet" | "completion", { tokens: number; value: number }>>;
}

export interface PersonUsageWindow {
  readonly since: string;
  readonly until: string;
  readonly rows: readonly PersonUsageRow[];
}

type Price = Record<UsageComponent, number>;
const COMPONENTS: readonly UsageComponent[] = ["input", "output", "cacheRead", "cacheWrite"];
const POOLED_PROVIDERS = new Set(["openai-codex", "anthropic"]);

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
  u.source source, u.model model, u.component component, SUM(u.tokens) tokens
FROM usage_hour u
LEFT JOIN control r ON u.source = 'completion' AND r.key = 'completion-run:' || u.run_id
LEFT JOIN control c ON r.value IS NOT NULL AND c.key = 'completion:' || r.value
WHERE u.hour >= ? AND u.hour < ?
GROUP BY 1, 2, 3, 4`;

type Row = { principal: string | null; source: string; model: string; component: UsageComponent; tokens: number };

/** Token use and list-price value per person for the hour buckets that start in [since, until). */
export function personUsage(store: Store, since: number, until = Date.now(), priceOf: (model: string) => Price | undefined = model => modelPrices().get(model)): PersonUsageWindow {
  const rows = store.db.prepare(PRINCIPAL_SQL).all(since, until) as Row[];
  const people = new Map<string | null, { principal: string | null; tokens: number; value: number; unpricedTokens: number; sources: Record<"interactive" | "fleet" | "completion", { tokens: number; value: number }> }>();
  for (const row of rows) {
    const principal = row.principal || null;
    let person = people.get(principal);
    if (!person) people.set(principal, person = { principal, tokens: 0, value: 0, unpricedTokens: 0, sources: { interactive: { tokens: 0, value: 0 }, fleet: { tokens: 0, value: 0 }, completion: { tokens: 0, value: 0 } } });
    const price = priceOf(row.model);
    const value = price ? row.tokens * price[row.component] / 1_000_000 : 0;
    person.tokens += row.tokens;
    person.value += value;
    if (!price) person.unpricedTokens += row.tokens;
    const source = person.sources[row.source as "interactive" | "fleet" | "completion"] ?? person.sources.interactive;
    source.tokens += row.tokens;
    source.value += value;
  }
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    rows: [...people.values()].sort((a, b) => b.value - a.value || b.tokens - a.tokens),
  };
}
