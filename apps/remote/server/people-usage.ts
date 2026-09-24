import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { PersonUsageWindow } from "pi-orchestrator/api";
import type { PeopleUsage, PeopleUsagePeriod, PersonUsage } from "./protocol";

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
 * Names the ledger's principals and turns their list-price value into shares.
 * The ledger's own spending (principal null) belongs to `owner`, the
 * administrator reading it. When nothing in the period has a price, shares
 * fall back to tokens so the view still compares people.
 */
export function peopleUsagePeriod(window: PersonUsageWindow, owner: string, names: ReadonlyMap<string, string>) {
  const rows = window.rows.map((row) => ({ ...row, user: row.principal ?? owner }));
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const weight = (row: { value: number; tokens: number }) => totalValue > 0 ? row.value / totalValue : totalTokens > 0 ? row.tokens / totalTokens : 0;
  const people: PersonUsage[] = rows
    .filter((row) => row.tokens > 0)
    .map((row) => ({
      user: row.user,
      name: names.get(row.user) ?? row.user,
      percent: weight(row) * 100,
      tokens: row.tokens,
      value: row.value,
      workersPercent: row.sources.fleet.tokens > 0
        ? (row.value > 0 ? row.sources.fleet.value / row.value : row.sources.fleet.tokens / row.tokens) * 100
        : null,
    }))
    .sort((a, b) => b.percent - a.percent || b.tokens - a.tokens);
  return { since: window.since, until: window.until, people };
}

export function peopleUsage(read: (windowMs: number) => PersonUsageWindow, owner: string, names: ReadonlyMap<string, string>): PeopleUsage {
  return {
    periods: Object.fromEntries(Object.entries(PEOPLE_USAGE_PERIODS)
      .map(([period, windowMs]) => [period, peopleUsagePeriod(read(windowMs), owner, names)])) as PeopleUsage["periods"],
  };
}
