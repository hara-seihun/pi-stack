import { describe, expect, it } from "vitest";
import { launchControl, sharePercent, taskSet } from "../src/cli.js";
import { mix } from "./harness.js";
import { Ledger } from "../src/ledger/ledger.js";

const open = (): Ledger => Ledger.open(":memory:");

const task = (ledger: Ledger, id: string) => ledger.tasks().find((t) => t.id === id);

describe("task set", () => {
  it("keeps the fields an edit does not name", () => {
    const ledger = open();
    taskSet(ledger, ["math", "--tiers", "standard", "--demand-command", "probe", "--cwd", "/work"]);

    // The realistic edit: change the prompt of a live standing lane.
    taskSet(ledger, ["math", "--prompt", "Attack the central problem."]);

    const t = task(ledger, "math")!;
    expect(t.prompt).toBe("Attack the central problem.");
    expect(t.demandCommand).toBe("probe"); // silently dropping this would strand the lane
    expect(t.cwd).toBe("/work");
    expect(t.tiers).toEqual([{ tier: "standard", weight: 1 }]);
    ledger.close();
  });

  it("reads a weighted tier mix, and defaults an unweighted tier to 1", () => {
    const ledger = open();
    taskSet(ledger, ["frontier", "--tiers", "light:20,standard", "--demand-constant", "9"]);
    expect(task(ledger, "frontier")!.tiers).toEqual([
      { tier: "light", weight: 20 },
      { tier: "standard", weight: 1 },
    ]);
    expect(() => taskSet(ledger, ["frontier", "--tiers", "light:0"])).toThrow(/positive/);
    expect(() => taskSet(ledger, ["frontier", "--tiers", "heavy:2"])).toThrow(/unknown tier/);
    ledger.close();
  });

  it("carries a lane's share, defaults it to 1, and refuses a meaningless one", () => {
    const ledger = open();
    taskSet(ledger, ["frontier", "--tiers", "light:20,standard", "--demand-constant", "9"]);
    expect(task(ledger, "frontier")!.share).toBe(1);
    taskSet(ledger, ["frontier", "--share", "14"]);
    expect(task(ledger, "frontier")!.share).toBe(14);
    // An unrelated edit must not quietly reset the fleet's split.
    taskSet(ledger, ["frontier", "--prompt", "go"]);
    expect(task(ledger, "frontier")!.share).toBe(14);
    expect(() => taskSet(ledger, ["frontier", "--share", "0"])).toThrow(/positive/);
    ledger.close();
  });

  it("clears a field only when told to, with an empty value", () => {
    const ledger = open();
    taskSet(ledger, ["math", "--tiers", "standard", "--demand-constant", "5", "--gate", "ingest.demand == 0"]);
    taskSet(ledger, ["math", "--gate", ""]);
    expect(task(ledger, "math")!.gate).toBeUndefined();
    expect(task(ledger, "math")!.demandConstant).toBe(5);
    ledger.close();
  });

  it("switches between the two exclusive demand forms", () => {
    const ledger = open();
    taskSet(ledger, ["math", "--tiers", "standard", "--demand-constant", "5"]);
    taskSet(ledger, ["math", "--demand-command", "probe"]);
    const t = task(ledger, "math")!;
    expect(t.demandCommand).toBe("probe");
    expect(t.demandConstant).toBeUndefined();
    ledger.close();
  });

  it("still requires tiers for a task that does not exist yet", () => {
    const ledger = open();
    expect(() => taskSet(ledger, ["fresh", "--demand-constant", "1"])).toThrow(/--tiers required/);
    ledger.close();
  });
});

describe("status display", () => {
  it("names the fleet fraction a lane actually claims, bundle and all", () => {
    // share × tier weight is the claim, so the light-heavy lane claims
    // twenty-one bundles' worth against the review lane's one. Reporting the
    // bare 14-against-2 split told the operator to expect 88% of the machine
    // for a lane that claims essentially all of it.
    const frontier = { share: 14, eligible: true, tiers: mix("light:20", "standard:1") };
    const review = { share: 2, eligible: true, tiers: mix("standard") };
    expect(sharePercent(frontier, [frontier, review])).toBe("14 (99%)");
    expect(sharePercent(review, [frontier, review])).toBe("2 (1%)");
    // A lane that is not claiming anything is not normalized against those
    // that are.
    const held = { share: 5, eligible: false, tiers: mix("standard") };
    expect(sharePercent(held, [frontier, review, held])).toBe("5");
  });
});

describe("launch control", () => {
  it("holds one lane, holds every other lane, and releases again", () => {
    const ledger = open();
    taskSet(ledger, ["review", "--tiers", "standard", "--demand-constant", "5"]);
    taskSet(ledger, ["frontier", "--tiers", "standard", "--demand-constant", "5"]);
    taskSet(ledger, ["survey", "--tiers", "light", "--demand-constant", "5"]);

    launchControl(ledger, "pause", ["--except", "review"]);
    expect(ledger.taskPaused("review")).toBe(false);
    expect(ledger.taskPaused("frontier")).toBe(true);
    expect(ledger.taskPaused("survey")).toBe(true);
    // Machine-wide control is a different row: holding lanes never pauses it.
    expect(ledger.getControl("launches")).toBe("enabled");

    launchControl(ledger, "resume", ["frontier"]);
    expect(ledger.taskPaused("frontier")).toBe(false);
    expect(() => launchControl(ledger, "pause", ["nosuch"])).toThrow(/unknown task/);
    expect(() => launchControl(ledger, "resume", ["--except", "review"])).toThrow(/--except/);

    // A held lane's row goes with it, so a reused id does not inherit a hold.
    ledger.deleteTask("survey");
    taskSet(ledger, ["survey", "--tiers", "light", "--demand-constant", "5"]);
    expect(ledger.taskPaused("survey")).toBe(false);
    ledger.close();
  });
});
