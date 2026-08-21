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
import { mix } from "./harness.js";

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
    expect(() => ledger.upsertTask({ id: "x", tiers: mix("light") })).toThrow(/exactly one/);
    expect(() =>
      ledger.upsertTask({ id: "x", demandConstant: 1, demandCommand: "true", tiers: mix("light") }),
    ).toThrow(/exactly one/);
    expect(() => ledger.upsertTask({ id: "x", demandConstant: 1, tiers: [] })).toThrow(/non-empty/);
    expect(() =>
      ledger.upsertTask({ id: "x", demandConstant: 1, tiers: mix("light", "light") }),
    ).toThrow(/duplicates/);
    expect(() =>
      ledger.upsertTask({ id: "x", demandConstant: 1, gate: "broken ==", tiers: mix("light") }),
    ).toThrow(/gate syntax/);
    ledger.upsertTask({
      id: "x",
      demandCommand: "probe",
      gate: "y.demand == 0",
      tiers: mix("expert", "standard"),
    });
    // Declaration order and weights both survive the round trip.
    expect(ledger.tasks()[0].tiers).toEqual(mix("expert", "standard"));
    expect(() =>
      ledger.upsertTask({
        id: "x",
        demandConstant: 1,
        tiers: [{ tier: "light", weight: 0 }],
      }),
    ).toThrow(/positive weight/);
    ledger.close();
  });

  it("migrates a v1 ledger in place and defaults launches to enabled", () => {
    const path = join(dir, "migrate.sqlite3");
    const old = new DatabaseSync(path);
    // The whole v1 schema: later migrations read the facts it holds, so a
    // fixture missing them would test a database that never existed.
    old.exec("CREATE TABLE account (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT, access_until INTEGER, created_at INTEGER NOT NULL) STRICT");
    old.exec("CREATE TABLE meter_reading (account_id TEXT NOT NULL REFERENCES account(id), meter_id TEXT NOT NULL, at INTEGER NOT NULL, used_percent INTEGER NOT NULL, reset_at INTEGER, PRIMARY KEY (account_id, meter_id, at)) STRICT");
    old.exec("CREATE TABLE usage_event (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id), class_id TEXT NOT NULL, at INTEGER NOT NULL, tokens REAL NOT NULL, source TEXT NOT NULL CHECK (source IN ('orchestrator', 'machine')), session_id TEXT) STRICT");
    old.exec("PRAGMA user_version = 1");
    old.close();
    const ledger = Ledger.open(path);
    expect(ledger.getControl("launches")).toBe("enabled");
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: mix("light") });
    expect(ledger.tasks()).toHaveLength(1);
    ledger.close();
  });
});

describe("scheduler", () => {
  it("T1 the ingest/produce story: production parks while ingestion has work", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "ingest", demandCommand: "count-pending", tiers: mix("standard") });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 1e9, // Effectively unbounded frontier work.
      gate: "ingest.demand == 0",
      tiers: mix("expert", "standard"),
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

  it("a held lane never launches, but still feeds the gates that read it", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "ingest", demandCommand: "count-pending", tiers: mix("standard") });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 5,
      gate: "ingest.demand == 0",
      tiers: mix("standard"),
    });
    const probes = fakeProbes({ "count-pending": 4 });
    const sched = new Scheduler(ledger, { demandTtlMs: 1000 }, probes.runner);
    ledger.setTaskPaused("ingest", true);

    const r = await sched.evaluate(1000);
    expect(snap(r, "ingest").paused).toBe(true);
    expect(snap(r, "ingest").eligible).toBe(false);
    expect(snap(r, "ingest").units).toBe(4);
    // Held is not unknown: the gate downstream still reads a real demand.
    expect(snap(r, "produce").gateOpen).toBe(false);

    ledger.setTaskPaused("ingest", false);
    expect(snap(await sched.evaluate(3000), "ingest").eligible).toBe(true);
    ledger.close();
  });

  it("T2 caches probes for the TTL and re-probes on invalidation", async () => {
    const ledger = openLedger();
    ledger.upsertTask({ id: "a", demandCommand: "probe-a", tiers: mix("light") });
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
    ledger.upsertTask({ id: "ingest", demandCommand: "p1", tiers: mix("light") });
    ledger.upsertTask({ id: "produce", demandCommand: "p2", gate: "ingest.demand == 0", tiers: mix("light") });
    ledger.upsertTask({ id: "unrelated", demandCommand: "p3", tiers: mix("light") });
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
    ledger.upsertTask({ id: "ingest", demandCommand: "boom", tiers: mix("light") });
    ledger.upsertTask({ id: "produce", demandConstant: 10, gate: "ingest.demand == 0", tiers: mix("light") });
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
    ledger.upsertTask({ id: "a", demandCommand: "probe-a", tiers: mix("light") });
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
    ledger.upsertTask({ id: "ingest", demandCommand: "pending", tiers: mix("light") });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 10,
      gate: "ingest.demand == 0",
      tiers: mix("light"),
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
    tiers: (Tier | `${Tier}:${number}`)[],
    eligible = true,
    share?: number,
  ): TaskSnapshot => ({
    taskId,
    tiers: mix(...tiers),
    units,
    ...(share === undefined ? {} : { share }),
    gateOpen: eligible,
    eligible,
    error: undefined,
  });

  it("A1 distributes proportionally to demand across a task's tiers, with spill", () => {
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
    const result = allocate([task("tiny", 2, ["light"])], { light: 5, standard: 5, expert: 0 });
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

  it("A11 share, not demand size, divides the fleet", () => {
    // Ten slots, and a lane whose probe counts problems in sixes against
    // lanes that count items one by one. On demand alone the counting unit
    // decided the split; the operator's declared share decides it now.
    const result = allocate(
      [
        task("frontier", 120, ["standard"], true, 7),
        task("review", 40, ["standard"], true, 2),
        task("survey", 30, ["standard"], true, 1),
      ],
      { light: 0, standard: 10, expert: 0 },
    );
    expect(result.assignments).toEqual([
      { taskId: "frontier", tier: "standard", count: 7 },
      { taskId: "review", tier: "standard", count: 2 },
      { taskId: "survey", tier: "standard", count: 1 },
    ]);
  });

  it("A12 a lane with less work than share gives the remainder back", () => {
    // Share is a claim, not a reservation: an idle majority lane must not
    // hold slots that another lane can use right now.
    const result = allocate(
      [
        task("frontier", 1, ["standard"], true, 7),
        task("review", 40, ["standard"], true, 2),
        task("survey", 40, ["standard"], true, 1),
      ],
      { light: 0, standard: 10, expert: 0 },
    );
    const count = (id: string) =>
      result.assignments.find((a) => a.taskId === id)?.count ?? 0;
    expect(count("frontier")).toBe(1);
    expect(count("review") + count("survey")).toBe(9);
    expect(count("review")).toBeGreaterThan(count("survey"));
    expect(result.unusedSlots.standard).toBe(0);
  });

  it("A6 one free slot goes to the task furthest behind its share, not the biggest", () => {
    // The production regime: sessions end one at a time, so almost every cycle
    // offers a single slot. Inside one cycle the 60% lane wins every time and
    // the 15% lane never launches; with history it takes its turn.
    const history = (taskId: string, share: number, recentLaunches: number): TaskSnapshot => ({
      ...task(taskId, 120, ["standard"], true, share),
      recentLaunches,
    });
    const slots = { light: 0, standard: 1, expert: 0 };
    // Served exactly in proportion so far (60/25/15 of 100 launches): the next
    // slot still goes to the largest, because nobody is behind.
    expect(
      allocate([history("big", 60, 60), history("mid", 25, 25), history("small", 15, 15)], slots)
        .assignments,
    ).toEqual([{ taskId: "big", tier: "standard", count: 1 }]);
    // Now the big task has taken everything. The slot goes to whoever is
    // furthest below its own share, which is mid (owed 25%, served 2%) rather
    // than the smallest task (owed 15%, served 0%).
    expect(
      allocate([history("big", 60, 98), history("mid", 25, 2), history("small", 15, 0)], slots)
        .assignments,
    ).toEqual([{ taskId: "mid", tier: "standard", count: 1 }]);
    // Starved outright, the smallest still gets its turn.
    expect(
      allocate([history("big", 60, 80), history("mid", 25, 20), history("small", 15, 0)], slots)
        .assignments,
    ).toEqual([{ taskId: "small", tier: "standard", count: 1 }]);
    // Repeated single-slot cycles converge on the declared split rather than
    // handing every slot to the same task.
    const served = new Map<string, number>([["big", 0], ["mid", 0], ["small", 0]]);
    for (let i = 0; i < 100; i++) {
      const [a] = allocate(
        [
          history("big", 60, served.get("big")!),
          history("mid", 25, served.get("mid")!),
          history("small", 15, served.get("small")!),
        ],
        slots,
      ).assignments;
      served.set(a!.taskId, served.get(a!.taskId)! + 1);
    }
    expect(served.get("big")).toBe(60);
    expect(served.get("mid")).toBe(25);
    expect(served.get("small")).toBe(15);
  });

  it("A7 holds a weighted tier mix across single-slot cycles", () => {
    // The point of weights: "one standard session per twenty light ones" is a
    // ratio no single cycle can express, and the production regime hands out
    // one slot at a time (demand is netted against running sessions, so a
    // busy lane asks for one more agent, not twenty). Without per-tier
    // history every one of those cycles picks the same tier and the mix never
    // materialises.
    const served: Partial<Record<Tier, number>> = {};
    const slots = { light: 1, standard: 1, expert: 0 };
    for (let i = 0; i < 63; i++) {
      const [a] = allocate(
        [{ ...task("frontier", 1, ["light:20", "standard:1"]), recentLaunchesByTier: served }],
        slots,
      ).assignments;
      served[a!.tier] = (served[a!.tier] ?? 0) + 1;
    }
    expect(served).toEqual({ light: 60, standard: 3 });
  });

  it("A8 a mixed lane spends its whole quota on the tiers that have capacity", () => {
    // Weights say what to prefer, not what to wait for: with no standard
    // slots the ratio yields and the light tier takes the lot.
    const result = allocate([task("frontier", 40, ["light:20", "standard:1"])], {
      light: 4,
      standard: 0,
      expert: 0,
    });
    expect(result.assignments).toEqual([{ taskId: "frontier", tier: "light", count: 4 }]);
  });

  it("A10 a light-heavy lane does not become a standard lane when light is short", () => {
    // The failure this rules out: light capacity dries up, the lane
    // substitutes into every free standard slot, and "one standard per twenty
    // light" silently becomes all-standard. It may take its one standard
    // share and no more; the rest of the scarce tier is left for lanes that
    // asked for it.
    const result = allocate(
      [
        task("frontier", 40, ["light:20", "standard:1"]),
        task("review", 10, ["standard"]),
      ],
      { light: 0, standard: 6, expert: 0 },
    );
    expect(result.assignments).toEqual([
      { taskId: "frontier", tier: "standard", count: 1 },
      { taskId: "review", tier: "standard", count: 5 },
    ]);

    // And a lane already at its standard share this window declines outright.
    const saturated = allocate(
      [
        {
          ...task("frontier", 40, ["light:20", "standard:1"]),
          recentLaunchesByTier: { light: 3, standard: 1 },
        },
      ],
      { light: 0, standard: 6, expert: 0 },
    );
    expect(saturated.assignments).toEqual([]);
    expect(saturated.unusedSlots.standard).toBe(6);
  });

  it("A9 splits one cycle's quota by weight when the slots are there", () => {
    const result = allocate([task("frontier", 40, ["light:3", "standard:1"])], {
      light: 40,
      standard: 40,
      expert: 0,
    });
    expect(result.assignments).toEqual([
      { taskId: "frontier", tier: "light", count: 30 },
      { taskId: "frontier", tier: "standard", count: 10 },
    ]);
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
