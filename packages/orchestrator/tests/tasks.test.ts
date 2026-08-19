import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { allocate } from "../src/tasks/allocate.js";
import { evalGate, gateRefs, parseGate } from "../src/tasks/gate.js";
import { Scheduler } from "../src/tasks/scheduler.js";
import type { TaskSnapshot, Tier } from "../src/tasks/types.js";

const dir = mkdtempSync(join(tmpdir(), "pi-orch-tasks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let dbCount = 0;
const openLedger = (): Ledger => Ledger.open(join(dir, `t${dbCount++}.sqlite3`));

/** Probe runner backed by a mutable map; counts calls per command. */
function fakeProbes(values: Record<string, number | Error>) {
  const calls = new Map<string, number>();
  const runner = async (command: string): Promise<number> => {
    calls.set(command, (calls.get(command) ?? 0) + 1);
    const v = values[command];
    if (v === undefined) throw new Error(`unexpected probe: ${command}`);
    if (v instanceof Error) throw v;
    return v;
  };
  return { runner, calls, values };
}

function snap(result: { tasks: readonly TaskSnapshot[] }, id: string): TaskSnapshot {
  const s = result.tasks.find((t) => t.taskId === id);
  if (!s) throw new Error(`no snapshot for ${id}`);
  return s;
}

describe("gate expressions", () => {
  it("parses and evaluates comparisons, and/or, parentheses, thresholds", () => {
    const ast = parseGate("(ingest.demand < 5 and review.demand == 0) or override.demand > 0");
    expect(gateRefs(ast).sort()).toEqual(["ingest", "override", "review"]);
    const withValues =
      (v: Record<string, number>) =>
      (id: string): number | undefined =>
        v[id];
    expect(evalGate(ast, withValues({ ingest: 3, review: 0, override: 0 }))).toBe(true);
    expect(evalGate(ast, withValues({ ingest: 9, review: 0, override: 0 }))).toBe(false);
    expect(evalGate(ast, withValues({ ingest: 9, review: 4, override: 2 }))).toBe(true);
  });

  it("rejects malformed gates loudly", () => {
    expect(() => parseGate("ingest.demand ==")).toThrow(/gate syntax/);
    expect(() => parseGate("ingest == 0")).toThrow(/gate syntax/);
    expect(() => parseGate("ingest.demand == 0 extra")).toThrow(/gate syntax/);
    expect(() => parseGate("a.demand == 0 b.demand == 1")).toThrow(/trailing/);
    expect(() => parseGate("(ingest.demand == 0")).toThrow(/gate syntax/);
  });

  it("unknown demand makes a gate unevaluable (fail-safe), with and/or short-circuit", () => {
    const missing = () => undefined;
    expect(evalGate(parseGate("a.demand == 0"), missing)).toBeUndefined();
    // false and unknown = false; true or unknown = true.
    const partial = (id: string) => (id === "a" ? 1 : undefined);
    expect(evalGate(parseGate("a.demand == 0 and b.demand == 0"), partial)).toBe(false);
    expect(evalGate(parseGate("a.demand > 0 or b.demand == 0"), partial)).toBe(true);
    expect(evalGate(parseGate("a.demand > 0 and b.demand == 0"), partial)).toBeUndefined();
  });
});

describe("task custody", () => {
  it("validates tasks at write time", () => {
    const ledger = openLedger();
    expect(() => ledger.upsertTask({ id: "x", tiers: ["light"] })).toThrow(/exactly one/);
    expect(() =>
      ledger.upsertTask({ id: "x", demandConstant: 1, demandCommand: "true", tiers: ["light"] }),
    ).toThrow(/exactly one/);
    expect(() => ledger.upsertTask({ id: "x", demandConstant: 1, tiers: [] })).toThrow(/non-empty/);
    expect(() =>
      ledger.upsertTask({ id: "x", demandConstant: 1, tiers: ["light", "light"] }),
    ).toThrow(/duplicates/);
    expect(() =>
      ledger.upsertTask({ id: "x", demandConstant: 1, gate: "broken ==", tiers: ["light"] }),
    ).toThrow(/gate syntax/);
    ledger.upsertTask({
      id: "x",
      demandCommand: "probe",
      gate: "y.demand == 0",
      tiers: ["expert", "standard"],
    });
    expect(ledger.tasks()[0].tiers).toEqual(["expert", "standard"]); // Preference order kept.
    ledger.close();
  });

  it("migrates a v1 ledger in place and defaults launches to enabled", () => {
    const path = join(dir, "migrate.sqlite3");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE account (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT, access_until INTEGER, created_at INTEGER NOT NULL) STRICT");
    old.exec("PRAGMA user_version = 1");
    old.close();
    const ledger = Ledger.open(path);
    expect(ledger.getControl("launches")).toBe("enabled");
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: ["light"] });
    expect(ledger.tasks()).toHaveLength(1);
    ledger.close();
  });
});

describe("scheduler", () => {
  it("T1 the ingest/produce story: production parks while ingestion has work", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "ingest", demandCommand: "count-pending", tiers: ["standard"] });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 1e9, // Effectively unbounded frontier work.
      gate: "ingest.demand == 0",
      tiers: ["expert", "standard"],
    });
    const probes = fakeProbes({ "count-pending": 7 });
    const sched = new Scheduler(ledger, { demandTtlMs: 1000 }, probes.runner);

    let r = await sched.evaluate(1000);
    expect(snap(r, "ingest").eligible).toBe(true);
    expect(snap(r, "produce").gateOpen).toBe(false);
    expect(snap(r, "produce").eligible).toBe(false);

    // Ingestion drains; a finished run invalidates, and the gate flips.
    probes.values["count-pending"] = 0;
    ledger.taskFinished("ingest");
    r = await sched.evaluate(2000);
    expect(snap(r, "ingest").eligible).toBe(false); // No work left.
    expect(snap(r, "produce").eligible).toBe(true);
    ledger.close();
  });

  it("T2 caches probes for the TTL and re-probes on invalidation", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "a", demandCommand: "probe-a", tiers: ["light"] });
    const probes = fakeProbes({ "probe-a": 5 });
    const sched = new Scheduler(ledger, { demandTtlMs: 60_000 }, probes.runner);
    await sched.evaluate(0);
    await sched.evaluate(1000);
    await sched.evaluate(59_000);
    expect(probes.calls.get("probe-a")).toBe(1); // Fresh for the whole TTL.
    await sched.evaluate(61_000);
    expect(probes.calls.get("probe-a")).toBe(2); // TTL expiry.
    ledger.invalidateDemand("a");
    await sched.evaluate(62_000);
    expect(probes.calls.get("probe-a")).toBe(3); // Invalidation beats TTL.
    ledger.close();
  });

  it("T3 taskFinished invalidates the finisher and gate-dependents only", () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "ingest", demandCommand: "p1", tiers: ["light"] });
    ledger.upsertTask({ id: "produce", demandCommand: "p2", gate: "ingest.demand == 0", tiers: ["light"] });
    ledger.upsertTask({ id: "unrelated", demandCommand: "p3", tiers: ["light"] });
    ledger.recordDemand("ingest", { units: 1 }, 0);
    ledger.recordDemand("produce", { units: 1 }, 0);
    ledger.recordDemand("unrelated", { units: 1 }, 0);
    ledger.taskFinished("ingest");
    expect(ledger.demandState("ingest")?.invalidated).toBe(true);
    expect(ledger.demandState("produce")?.invalidated).toBe(true);
    expect(ledger.demandState("unrelated")?.invalidated).toBe(false);
    ledger.close();
  });

  it("T4 probe failure fails closed: task ineligible, dependent gates closed, error surfaced", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "ingest", demandCommand: "boom", tiers: ["light"] });
    ledger.upsertTask({ id: "produce", demandConstant: 10, gate: "ingest.demand == 0", tiers: ["light"] });
    const probes = fakeProbes({ boom: new Error("db locked") });
    const sched = new Scheduler(ledger, {}, probes.runner);
    const r = await sched.evaluate(0);
    expect(snap(r, "ingest").eligible).toBe(false);
    expect(snap(r, "ingest").error).toMatch(/db locked/);
    expect(snap(r, "produce").eligible).toBe(false); // Unknown upstream: closed, not open.
    ledger.close();
  });

  it("T5 machine pause gates everything and runs no probes", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "a", demandCommand: "probe-a", tiers: ["light"] });
    const probes = fakeProbes({ "probe-a": 5 });
    const sched = new Scheduler(ledger, {}, probes.runner);
    ledger.setControl("launches", "paused");
    const r = await sched.evaluate(0);
    expect(r.launches).toBe("paused");
    expect(r.tasks).toHaveLength(0);
    expect(probes.calls.size).toBe(0);
    ledger.setControl("launches", "enabled");
    expect((await sched.evaluate(1)).launches).toBe("enabled");
    ledger.close();
  });

  it("T6 debounce: a gate must stay open for the window; flapping resets it", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "ingest", demandCommand: "pending", tiers: ["light"] });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 10,
      gate: "ingest.demand == 0",
      tiers: ["light"],
    });
    const probes = fakeProbes({ pending: 0 });
    const sched = new Scheduler(ledger, { demandTtlMs: 1, gateDebounceMs: 600_000 }, probes.runner);

    let r = await sched.evaluate(0); // Gate opens at t=0...
    expect(snap(r, "produce").eligible).toBe(false); // ...but debounce holds.
    r = await sched.evaluate(300_000);
    expect(snap(r, "produce").eligible).toBe(false);
    // New ingest work arrives mid-window: the gate flaps shut.
    probes.values["pending"] = 3;
    r = await sched.evaluate(400_000);
    expect(snap(r, "produce").gateOpen).toBe(false);
    probes.values["pending"] = 0;
    r = await sched.evaluate(500_000); // Reopens: debounce restarts here.
    expect(snap(r, "produce").eligible).toBe(false);
    r = await sched.evaluate(1_099_000); // 599s after reopen: still held.
    expect(snap(r, "produce").eligible).toBe(false);
    r = await sched.evaluate(1_101_000); // 601s after reopen: eligible.
    expect(snap(r, "produce").eligible).toBe(true);
    ledger.close();
  });
});

describe("allocation", () => {
  const task = (
    taskId: string,
    units: number,
    tiers: Tier[],
    eligible = true,
  ): TaskSnapshot => ({ taskId, tiers, units, gateOpen: eligible, eligible, error: undefined });

  it("A1 distributes proportionally to demand with tier preference and spill", () => {
    const result = allocate(
      [
        task("heavy", 60, ["standard", "expert"]),
        task("mid", 30, ["light"]),
        task("small", 10, ["light"]),
      ],
      { light: 2, standard: 2, expert: 1 },
    );
    expect(result.assignments).toEqual([
      { taskId: "heavy", tier: "standard", count: 2 },
      { taskId: "heavy", tier: "expert", count: 1 },
      { taskId: "mid", tier: "light", count: 2 },
    ]);
    // small's quota rounded to zero; every slot used.
    expect(result.unusedSlots).toEqual({ light: 0, standard: 0, expert: 0 });
  });

  it("A2 a tier-restricted task waits rather than being downgraded; capacity redistributes", () => {
    const result = allocate(
      [task("expert-only", 100, ["expert"]), task("flexible", 50, ["light", "standard"])],
      { light: 2, standard: 2, expert: 0 },
    );
    // expert-only gets nothing (its only tier has no capacity) and its share
    // flows to the task that can use the machine.
    expect(result.assignments).toEqual([
      { taskId: "flexible", tier: "light", count: 2 },
      { taskId: "flexible", tier: "standard", count: 2 },
    ]);
  });

  it("A3 never assigns more agents than work units", () => {
    const result = allocate([task("tiny", 2, ["light", "standard"])], { light: 5, standard: 5, expert: 0 });
    expect(result.assignments).toEqual([{ taskId: "tiny", tier: "light", count: 2 }]);
    expect(result.unusedSlots.light).toBe(3);
  });

  it("A4 ineligible and zero-demand tasks receive nothing", () => {
    const result = allocate(
      [task("parked", 50, ["light"], false), task("empty", 0, ["light"])],
      { light: 3, standard: 0, expert: 0 },
    );
    expect(result.assignments).toEqual([]);
    expect(result.unusedSlots.light).toBe(3);
  });

  it("A5 is deterministic under equal demand (ties break by id)", () => {
    const a = allocate([task("b", 10, ["light"]), task("a", 10, ["light"])], {
      light: 3,
      standard: 0,
      expert: 0,
    });
    expect(a.assignments).toEqual([
      { taskId: "a", tier: "light", count: 2 },
      { taskId: "b", tier: "light", count: 1 },
    ]);
  });
});
