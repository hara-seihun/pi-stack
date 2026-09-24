import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHostAdministrator, peopleUsage, peopleUsagePeriod } from "./people-usage";

const figures = (tokens = 0, value = 0, spend = 0) => ({ tokens, value, spend });
const sources = (fleet = figures()) => ({ interactive: figures(), fleet, completion: figures() });
const row = (principal: string | null, tokens: number, value: number, spend: number, fleet = figures()) =>
  ({ principal, tokens, value, spend, unpricedTokens: value > 0 ? 0 : tokens, sources: sources(fleet), providers: {} });
const plans = [
  { planId: "openai", label: "OpenAI", provider: "openai-codex", accounts: 5, monthlyUsd: 200, spend: 33.33, idle: 0, rate: 0.03, rateSince: "a" },
  { planId: "anthropic", label: "Anthropic", provider: "anthropic", accounts: 3, monthlyUsd: 250, spend: 25, idle: 25, rate: null, rateSince: "a" },
  { planId: "other", label: "Other", provider: "other", accounts: 0, monthlyUsd: 10, spend: 0, idle: 0, rate: null, rateSince: "a" },
];

describe("people usage", () => {
  test("names principals, gives the owner the ledger's own spending and shares by subscription spend", () => {
    const period = peopleUsagePeriod({ since: "a", until: "b", subscriptions: plans, rows: [
      row(null, 900, 300, 30, figures(600, 200, 20)),
      row("sybil", 100, 10, 10),
      row("ghost", 0, 0, 0),
    ] }, "kenan", new Map([["kenan", "Hara"], ["sybil", "Sybil"]]));
    expect(period.people.map((person) => [person.user, person.name, person.percent, person.spend])).toEqual([["kenan", "Hara", 75, 30], ["sybil", "Sybil", 25, 10]]);
    expect(period.people[0]!.workersPercent).toBeCloseTo(66.67, 1);
    expect(period.people[1]!.workersPercent).toBeNull();
    expect(period.spend).toBeCloseTo(58.33, 2);
    expect(period.used).toBe(40);
    expect(period.subscriptions.map((plan) => [plan.label, plan.idle])).toEqual([["OpenAI", false], ["Anthropic", true]]);
  });

  test("without subscriptions falls back to list-price value, then tokens", () => {
    const byValue = peopleUsagePeriod({ since: "a", until: "b", subscriptions: [], rows: [row("jodie", 10, 3, 0), row("martine", 30, 1, 0)] }, "kenan", new Map());
    expect(byValue.people.map((person) => [person.name, person.percent])).toEqual([["jodie", 75], ["martine", 25]]);
    const byTokens = peopleUsagePeriod({ since: "a", until: "b", subscriptions: [], rows: [row("jodie", 30, 0, 0), row("martine", 10, 0, 0)] }, "kenan", new Map());
    expect(byTokens.people.map((person) => [person.name, person.percent])).toEqual([["jodie", 75], ["martine", 25]]);
  });

  test("reads a day and a week", () => {
    const windows: number[] = [];
    const usage = peopleUsage((windowMs) => { windows.push(windowMs); return { since: "a", until: "b", subscriptions: [], rows: [] }; }, "kenan", new Map());
    expect(Object.keys(usage.periods)).toEqual(["day", "week"]);
    expect(windows).toEqual([86_400_000, 604_800_000]);
  });

  test("only the host's fleet user is its administrator", () => {
    const root = mkdtempSync(join(tmpdir(), "people-usage-"));
    try {
      const path = join(root, "host.json");
      writeFileSync(path, JSON.stringify({ fleetUser: "kenan" }));
      expect(isHostAdministrator({ PI_STACK_HOST_CONFIG: path }, "kenan")).toBe(true);
      expect(isHostAdministrator({ PI_STACK_HOST_CONFIG: path }, "sybil")).toBe(false);
      expect(isHostAdministrator({ PI_STACK_HOST_CONFIG: join(root, "missing.json") }, "kenan")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
