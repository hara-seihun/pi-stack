import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { PersonUsageWindow } from "pi-orchestrator/api";
import type { PeopleUsage, PeopleUsagePeriod, PeopleUsagePeriodData, PersonUsage } from "./protocol";

export const PEOPLE_USAGE_PERIODS: Record<PeopleUsagePeriod, number> = {
  day: 24 * 3_600_000,
  week: 7 * 24 * 3_600_000,
};

/** The host's administrator: the `fleetUser` whose ledger every broker writes to. */
export function hostAdministrator(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PI_STACK_HOST_CONFIG ?? "/etc/pi-stack/host.json";
  try {
    if (!existsSync(path)) return null;
    const fleetUser = JSON.parse(readFileSync(path, "utf8")).fleetUser;
    return typeof fleetUser === "string" && fleetUser ? fleetUser : null;
  } catch {
    return null;
  }
}

export function isHostAdministrator(env: NodeJS.ProcessEnv = process.env, person = userInfo().username): boolean {
  return hostAdministrator(env) === person;
}

/**
 * Names the ledger's principals and turns their part of the subscription cost
 * into shares. The ledger's own spending (principal null) belongs to `owner`,
 * the administrator reading it. Without any enabled subscription the shares
 * fall back to list-price value, then to tokens, so the view still compares people.
 */
export function peopleUsagePeriod(window: PersonUsageWindow, owner: string, names: ReadonlyMap<string, string>): PeopleUsagePeriodData {
  const rows = window.rows.filter((row) => row.tokens > 0);
  const total = (key: "spend" | "value" | "tokens") => rows.reduce((sum, row) => sum + row[key], 0);
  const basis = (["spend", "value", "tokens"] as const).find((key) => total(key) > 0) ?? "tokens";
  const whole = total(basis);
  const people: PersonUsage[] = rows
    .map((row) => {
      const user = row.principal ?? owner;
      const fleet = row.sources.fleet;
      return {
        user,
        name: names.get(user) ?? user,
        percent: whole > 0 ? row[basis] * 100 / whole : 0,
        spend: row.spend,
        tokens: row.tokens,
        value: row.value,
        workersPercent: fleet.tokens > 0 && row[basis] > 0 ? fleet[basis] * 100 / row[basis] : null,
      };
    })
    .sort((a, b) => b.percent - a.percent || b.tokens - a.tokens);
  return {
    since: window.since,
    until: window.until,
    spend: window.subscriptions.reduce((sum, plan) => sum + plan.spend, 0),
    used: rows.reduce((sum, row) => sum + row.spend, 0),
    subscriptions: window.subscriptions
      .filter((plan) => plan.accounts > 0)
      .map((plan) => ({ label: plan.label, accounts: plan.accounts, monthlyUsd: plan.monthlyUsd, spend: plan.spend, used: plan.used })),
    people,
  };
}

export function peopleUsage(read: (windowMs: number) => PersonUsageWindow, owner: string, names: ReadonlyMap<string, string>): PeopleUsage {
  return {
    periods: Object.fromEntries(Object.entries(PEOPLE_USAGE_PERIODS)
      .map(([period, windowMs]) => [period, peopleUsagePeriod(read(windowMs), owner, names)])) as PeopleUsage["periods"],
  };
}
