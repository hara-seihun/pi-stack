import { describe, expect, it } from "vitest";
import { Broker } from "../src/broker/broker.js";
import { Controller } from "../src/controller/controller.js";
import { Ledger } from "../src/ledger/ledger.js";
import { Runner } from "../src/host/runner.js";
import { Scheduler } from "../src/tasks/scheduler.js";
import type { HostManager, LaunchSpec } from "../src/host/types.js";
import { mix } from "./harness.js";
import type { MeterSpec } from "../src/calibrator/types.js";

const HOUR = 3_600_000;
const METERS: MeterSpec[] = [{ id: "weekly", drainedBy: ["cost"], nominalWindowMs: 7 * 24 * HOUR }];

class FakeEngine implements HostManager {
  launched: LaunchSpec[] = [];
  aborted: string[] = [];
  launch(spec: LaunchSpec): void {
    this.launched.push(spec);
  }
  abort(runId: string): void {
    this.aborted.push(runId);
  }
  message(): boolean {
    return true;
  }
}

function build(probes: Record<string, number | (() => number)> = {}) {
  const ledger = Ledger.open(":memory:");
  ledger.upsertAccount({ id: "anth-1", provider: "anthropic", domain: "orchestrator" });
  ledger.upsertAccount({ id: "codex-1", provider: "openai-codex", domain: "orchestrator" });
  const scheduler = new Scheduler(ledger, { demandTtlMs: 60_000, gateDebounceMs: 0 }, async (cmd) => {
    const probe = probes[cmd];
    if (probe === undefined) throw new Error(`unexpected probe ${cmd}`);
    return typeof probe === "function" ? probe() : probe;
  });
  const broker = new Broker(ledger, {
    tiers: {
      light: [{ provider: "openai-codex", model: "gpt-5.6-luna" }],
      standard: [
        { provider: "anthropic", model: "claude-opus" },
        { provider: "openai-codex", model: "gpt-5.6-sol" },
      ],
      expert: [{ provider: "anthropic", model: "claude-fable" }],
    },
    meters: { anthropic: METERS, "openai-codex": METERS },
  });
  const engine = new FakeEngine();
  const controller = new Controller(ledger, scheduler, broker);
  const runner = new Runner(ledger, engine, { runnerId: "r1", maxSessions: 100 });
  /** One full dispatch cycle: controller creates pending runs, runner claims
   * and launches them. Returns the specs launched this cycle. */
  const cycle = async (now: number) => {
    const tick = await controller.tick(now);
    const claimed = runner.tick(now).claimed;
    return { tick, claimed };
  };
  return { ledger, controller, runner, engine, cycle };
}

describe("dispatch cycle", () => {
  it("end to end: demand -> pending run -> claim -> launch -> completion -> reprobe", async () => {
    let backlog = 2;
    const { ledger, runner, cycle } = build({ "probe ingest": () => backlog });
    ledger.upsertTask({
      id: "ingest",
      demandCommand: "probe ingest",
      tiers: mix("standard"),
      prompt: "Ingest the queue.",
      cwd: "/tmp",
    });

    const first = await cycle(0);
    // Two bootstrap accounts serve the standard tier: both work units launch.
    expect(first.claimed).toHaveLength(2);
    const spec = first.claimed[0];
    expect(spec.prompt).toBe("Ingest the queue.");
    expect(spec.cwd).toBe("/tmp");
    expect((spec as unknown as Record<string, unknown>).tier).toBeUndefined(); // leak check
    expect(ledger.runs({ state: "running" })).toHaveLength(2);

    // While both accounts are saturated, another cycle launches nothing.
    const second = await cycle(1000);
    expect(second.claimed).toHaveLength(0);

    // One session finishes; demand is re-probed (backlog 1) and netted
    // against the still-running session: no further launch.
    backlog = 1;
    runner.runFinished(spec.runId, { state: "done", productive: true, complete: false }, 2000);
    expect(ledger.run(spec.runId)?.state).toBe("done");
    const third = await cycle(3000);
    expect(third.claimed).toHaveLength(0);
    expect(ledger.runs({ state: "running" })).toHaveLength(1);
  });

  it("a task without a prompt is a pure demand signal and never launches", async () => {
    const { ledger, cycle } = build({ "probe signal": 5 });
    ledger.upsertTask({ id: "signal", demandCommand: "probe signal", tiers: mix("standard") });
    const { tick, claimed } = await cycle(0);
    expect(tick.evaluation.tasks[0]?.eligible).toBe(true);
    expect(tick.created).toHaveLength(0);
    expect(claimed).toHaveLength(0);
  });

  it("pause is honoured before any launch", async () => {
    const { ledger, cycle } = build();
    ledger.upsertTask({ id: "t", demandConstant: 3, tiers: mix("standard"), prompt: "Work." });
    ledger.setControl("launches", "paused");
    const { tick } = await cycle(0);
    expect(tick.evaluation.launches).toBe("paused");
    expect(tick.created).toHaveLength(0);
  });

  it("gated ingest-before-produce: producer launches only when ingest is drained", async () => {
    let queue = 3;
    const { ledger, runner, cycle } = build({ "probe queue": () => queue });
    ledger.upsertTask({
      id: "ingest",
      demandCommand: "probe queue",
      tiers: mix("standard"),
      prompt: "Ingest.",
    });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 4,
      gate: "ingest.demand == 0",
      tiers: mix("standard", "light"),
      prompt: "Produce.",
    });
    const first = await cycle(0);
    expect(first.claimed.map((l) => l.taskId)).toEqual(["ingest", "ingest"]);
    for (const l of first.claimed) runner.runFinished(l.runId, { state: "done" }, 1000);
    queue = 0;
    const second = await cycle(2000);
    expect(new Set(second.claimed.map((l) => l.taskId))).toEqual(new Set(["produce"]));
  });
});

describe("run custody", () => {
  it("reaps a run whose heartbeat went stale and frees its account", async () => {
    const { ledger, cycle } = build();
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: mix("expert"), prompt: "Work." });
    const first = await cycle(0);
    expect(first.claimed).toHaveLength(1);
    const runId = first.claimed[0].runId;
    // 11 minutes of silence: past the 10-minute default timeout.
    const later = 11 * 60_000;
    const report = await cycle(later);
    expect(report.tick.reaped).toEqual([runId]);
    expect(ledger.run(runId)?.state).toBe("aborted");
    expect(ledger.run(runId)?.detail).toBe("runner heartbeat timeout");
    // The account is free again; the invalidated demand re-launches.
    expect(report.claimed).toHaveLength(1);
  });

  it("heartbeats keep a long run alive", async () => {
    const { ledger, runner, cycle } = build();
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: mix("expert"), prompt: "Work." });
    const first = await cycle(0);
    const runId = first.claimed[0].runId;
    runner.heartbeat(runId, 9 * 60_000);
    const report = await cycle(11 * 60_000);
    expect(report.tick.reaped).toHaveLength(0);
    expect(ledger.run(runId)?.state).toBe("running");
  });

  it("a pending run no runner claims expires without tripping the circuit breaker", async () => {
    const { ledger, controller } = build();
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: mix("expert"), prompt: "Work." });
    const first = await controller.tick(0);
    expect(first.created).toHaveLength(1);
    const runId = first.created[0].id;
    // No runner exists. Past the 2-minute claim timeout the run is aborted,
    // the account reservation is released, and the task relaunches.
    const later = await controller.tick(3 * 60_000);
    expect(later.expired).toEqual([runId]);
    expect(ledger.run(runId)?.state).toBe("aborted");
    expect(ledger.run(runId)?.detail).toBe("unclaimed");
    expect(later.created).toHaveLength(1);
    expect(later.skipped).toHaveLength(0);
  });

  it("abort requests are forwarded by the owning runner", async () => {
    const { ledger, engine, runner, cycle } = build();
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: mix("expert"), prompt: "Work." });
    const first = await cycle(0);
    const runId = first.claimed[0].runId;
    ledger.requestAbort(runId);
    runner.tick(1000);
    expect(engine.aborted).toEqual([runId]);
  });

  it("circuit breaker: a crashing task stops launching inside the error window", async () => {
    const { ledger, runner, cycle } = build();
    ledger.upsertTask({ id: "crashy", demandConstant: 5, tiers: mix("standard"), prompt: "Work." });
    let now = 0;
    for (let i = 0; i < 3; i++) {
      const report = await cycle(now);
      for (const l of report.claimed) {
        runner.runFinished(l.runId, { state: "error", detail: "boom" }, now + 500);
      }
      now += 60_000;
    }
    const blocked = await cycle(now);
    expect(blocked.claimed).toHaveLength(0);
    expect(blocked.tick.skipped).toContainEqual({ taskId: "crashy", reason: "error-backoff" });
    // Outside the 30-minute window the breaker closes again.
    const recovered = await cycle(now + 31 * 60_000);
    expect(recovered.claimed.length).toBeGreaterThan(0);
  });

  it("a light-heavy lane launches its mix, and leaves the standard tier to the lane that wants it", async () => {
    // The operator asks for one standard session per twenty light ones on the
    // research lane. Two things have to hold through a real dispatch cycle:
    // the ratio itself, which no single cycle can express, and that the
    // light-heavy lane does not reserve the scarce standard capacity that the
    // review lane exists to use.
    const { ledger, runner, cycle } = build();
    ledger.upsertTask({
      id: "frontier",
      demandConstant: 40,
      tiers: mix("light:20", "standard:1"),
      prompt: "Attack.",
    });
    ledger.upsertTask({
      id: "review",
      demandConstant: 40,
      tiers: mix("standard"),
      prompt: "Review.",
    });

    const launched: { taskId: string; model: string }[] = [];
    let now = 0;
    for (let i = 0; i < 40; i++) {
      const { claimed } = await cycle(now);
      for (const l of claimed) {
        launched.push({ taskId: l.taskId, model: l.model });
        runner.runFinished(l.runId, { state: "done" }, now + 100);
      }
      now += 60_000;
    }

    const frontier = launched.filter((l) => l.taskId === "frontier");
    const frontierLight = frontier.filter((l) => l.model === "gpt-5.6-luna").length;
    expect(frontierLight / frontier.length).toBeGreaterThan(0.9);
    // Not a single-model lane either: the standard share is real, just small.
    expect(frontier.length - frontierLight).toBeGreaterThan(0);
    // The review lane still gets the standard capacity it asked for.
    expect(launched.filter((l) => l.taskId === "review").length).toBeGreaterThan(0);
    // Tier labels stay launch-side: the agent only ever sees a model.
    expect(launched.every((l) => l.model !== undefined)).toBe(true);
  });

  it("the standing fleet holds the shape of share × tier weight", async () => {
    // The production failure: the fleet came up almost entirely review
    // agents. The research lane was share 14 asking for twenty light sessions
    // per standard one; the review lane was share 2, standard only. Sessions
    // are long, so what matters is the fleet standing after a run of cycles,
    // not the launch order.
    const { ledger, cycle } = build();
    for (let i = 2; i <= 12; i++) {
      ledger.upsertAccount({ id: `codex-${i}`, provider: "openai-codex", domain: "orchestrator" });
    }
    ledger.upsertTask({
      id: "frontier",
      demandConstant: 90,
      tiers: mix("light:20", "standard:1"),
      share: 14,
      prompt: "Attack.",
    });
    ledger.upsertTask({
      id: "review",
      demandConstant: 41,
      tiers: mix("standard"),
      share: 2,
      prompt: "Review.",
    });

    let now = 0;
    for (let i = 0; i < 10; i++) {
      await cycle(now); // Nothing finishes: these sessions hold their slots.
      now += 60_000;
    }

    const fleet = ledger.runs().filter((r) => r.state === "pending" || r.state === "running");
    const held = (taskId: string, model: string): number =>
      fleet.filter((r) => r.taskId === taskId && r.model === model).length;
    const frontierLight = held("frontier", "gpt-5.6-luna");
    const reviewStandard = fleet.filter((r) => r.taskId === "review").length;
    // The research lane holds the machine, in the mix it asked for: its
    // standard session is the one its bundle buys, not a share of whatever
    // standard capacity happened to be free.
    expect(frontierLight).toBeGreaterThan(0.8 * fleet.length);
    expect(held("frontier", "gpt-5.6-sol") + held("frontier", "claude-opus")).toBe(1);
    // The review lane's claim is 2 of 296, so on a thirteen-session machine
    // it holds at most one — nothing like the thirteen it took when the mix
    // was a per-lane ceiling and the leftover standard slots went to whoever
    // could use them.
    expect(reviewStandard).toBeLessThanOrEqual(1);
  });

  it("a finished run wakes tasks gated on it", async () => {
    let queue = 1;
    const { ledger, runner, cycle } = build({ "probe queue": () => queue });
    ledger.upsertTask({
      id: "ingest",
      demandCommand: "probe queue",
      tiers: mix("standard"),
      prompt: "Ingest.",
    });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 2,
      gate: "ingest.demand == 0",
      tiers: mix("light", "standard"),
      prompt: "Produce.",
    });
    const first = await cycle(0);
    const ingestRun = first.claimed.find((l) => l.taskId === "ingest")!;
    queue = 0;
    // Well inside the demand TTL: without invalidation the stale backlog
    // would keep the gate closed until expiry.
    runner.runFinished(ingestRun.runId, { state: "done" }, 10_000);
    const second = await cycle(20_000);
    expect(second.claimed.some((l) => l.taskId === "produce")).toBe(true);
  });
});
