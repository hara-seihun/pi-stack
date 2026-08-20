import { describe, expect, it } from "vitest";
import { taskSet } from "../src/cli.js";
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
    expect(t.tiers).toEqual(["standard"]);
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
