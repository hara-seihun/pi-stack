import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHostAdministrator, peopleUsage, peopleUsagePeriod } from "./people-usage";

const sources = (fleetTokens = 0, fleetValue = 0) => ({ interactive: { tokens: 0, value: 0 }, fleet: { tokens: fleetTokens, value: fleetValue }, completion: { tokens: 0, value: 0 } });

describe("people usage", () => {
  test("names principals, gives the owner the ledger's own spending and shares by list-price value", () => {
    const period = peopleUsagePeriod({ since: "a", until: "b", rows: [
      { principal: null, tokens: 900, value: 30, unpricedTokens: 0, sources: sources(600, 20) },
      { principal: "sybil", tokens: 100, value: 10, unpricedTokens: 0, sources: sources() },
      { principal: "ghost", tokens: 0, value: 0, unpricedTokens: 0, sources: sources() },
    ] }, "kenan", new Map([["kenan", "Hara"], ["sybil", "Sybil"]]));
    expect(period.people.map((person) => [person.user, person.name, person.percent])).toEqual([["kenan", "Hara", 75], ["sybil", "Sybil", 25]]);
    expect(period.people[0]!.workersPercent).toBeCloseTo(66.67, 1);
    expect(period.people[1]!.workersPercent).toBeNull();
  });

  test("falls back to token shares when nothing in the period has a price", () => {
    const period = peopleUsagePeriod({ since: "a", until: "b", rows: [
      { principal: "jodie", tokens: 30, value: 0, unpricedTokens: 30, sources: sources() },
      { principal: "martine", tokens: 10, value: 0, unpricedTokens: 10, sources: sources() },
    ] }, "kenan", new Map());
    expect(period.people.map((person) => [person.name, person.percent])).toEqual([["jodie", 75], ["martine", 25]]);
  });

  test("reads a day and a week", () => {
    const windows: number[] = [];
    const usage = peopleUsage((windowMs) => { windows.push(windowMs); return { since: "a", until: "b", rows: [] }; }, "kenan", new Map());
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
