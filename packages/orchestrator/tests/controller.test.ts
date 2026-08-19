import { describe, expect, it } from "vitest";
import { Broker } from "../src/broker/broker.js";
import { Controller } from "../src/controller/controller.js";
import { Ledger } from "../src/ledger/ledger.js";
import { Scheduler } from "../src/tasks/scheduler.js";
import type { HostManager, LaunchSpec } from "../src/host/types.js";
import type { MeterSpec } from "../src/calibrator/types.js";

const HOUR = 3_600_000;
const METERS: MeterSpec[] = [{ id: "weekly", drainedBy: ["cost"], nominalWindowMs: 7 * 24 * HOUR }];

class FakeHost implements HostManager {
  launched: LaunchSpec[] = [];
  aborted: string[] = [];
  launch(spec: LaunchSpec): void {
    this.launched.push(spec);
  }
  abort(runId: string): void {
    this.aborted.push(runId);
  }
}

function build(probes: Record<string, number | (() => number)> = {}) {
  const ledger = Ledger.open(":memory:");
  ledger.upsertAccount({ id: "anth-1", provider: "anthropic" });
  ledger.upsertAccount({ id: "codex-1", provider: "openai-codex" });
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
  const host = new FakeHost();
  const controller = new Controller(ledger, scheduler, broker, host);
  return { ledger, controller, host };
}

describe("controller launch loop", () => {
  it("end to end: demand -> allocation -> admission -> launch -> completion -> reprobe", async () => {
    let backlog = 2;
    const { ledger, controller, host } = build({ "probe ingest": () => backlog });
    ledger.upsertTask({
      id: "ingest",
      demandCommand: "probe ingest",
      tiers: ["standard"],
      prompt: "Ingest the queue.",
      cwd: "/tmp",
    });

    const first = await controller.tick(0);
    // Two bootstrap accounts serve the standard tier: both work units launch.
    expect(first.launched).toHaveLength(2);
    const spec = first.launched[0];
    expect(spec.prompt).toBe("Ingest the queue.");
    expect(spec.cwd).toBe("/tmp");
    expect((spec as unknown as Record<string, unknown>).tier).toBeUndefined(); // leak check
    expect(ledger.runs({ state: "running" })).toHaveLength(2);

    // While both accounts are saturated, another tick launches nothing.
    const second = await controller.tick(1000);
    expect(second.launched).toHaveLength(0);

    // One session finishes productively; demand is invalidated and re-probed
    // (backlog now 1), and the freed account takes the remaining unit.
    backlog = 1;
    controller.runFinished(spec.runId, { state: "done", productive: true, complete: false }, 2000);
    expect(ledger.run(spec.runId)?.state).toBe("done");
    const third = await controller.tick(3000);
    expect(third.launched).toHaveLength(0); // 1 unit, 1 already running
    expect(ledger.runs({ state: "running" })).toHaveLength(1);
  });

  it("a task without a prompt is a pure demand signal and never launches", async () => {
    const { ledger, controller } = build({ "probe signal": 5 });
    ledger.upsertTask({ id: "signal", demandCommand: "probe signal", tiers: ["standard"] });
    const report = await controller.tick(0);
    expect(report.evaluation.tasks[0]?.eligible).toBe(true);
    expect(report.launched).toHaveLength(0);
  });

  it("pause is honoured before any launch", async () => {
    const { ledger, controller } = build();
    ledger.upsertTask({ id: "t", demandConstant: 3, tiers: ["standard"], prompt: "Work." });
    ledger.setControl("launches", "paused");
    const report = await controller.tick(0);
    expect(report.evaluation.launches).toBe("paused");
    expect(report.launched).toHaveLength(0);
  });

  it("gated ingest-before-produce: producer launches only when ingest is drained", async () => {
    let queue = 3;
    const { ledger, controller } = build({ "probe queue": () => queue });
    ledger.upsertTask({
      id: "ingest",
      demandCommand: "probe queue",
      tiers: ["standard"],
      prompt: "Ingest.",
    });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 4,
      gate: "ingest.demand == 0",
      tiers: ["standard", "light"],
      prompt: "Produce.",
    });
    const first = await controller.tick(0);
    expect(first.launched.map((l) => l.taskId)).toEqual(["ingest", "ingest"]);
    for (const l of first.launched) controller.runFinished(l.runId, { state: "done" }, 1000);
    queue = 0;
    const second = await controller.tick(2000);
    expect(new Set(second.launched.map((l) => l.taskId))).toEqual(new Set(["produce"]));
  });
});

describe("controller custody", () => {
  it("reaps a run whose heartbeat went stale and frees its account", async () => {
    const { ledger, controller } = build();
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: ["expert"], prompt: "Work." });
    const first = await controller.tick(0);
    expect(first.launched).toHaveLength(1);
    const runId = first.launched[0].runId;
    // 11 minutes of silence: past the 10-minute default timeout.
    const later = 11 * 60_000;
    const report = await controller.tick(later);
    expect(report.reaped).toEqual([runId]);
    expect(ledger.run(runId)?.state).toBe("error");
    expect(ledger.run(runId)?.detail).toBe("heartbeat timeout");
    // The account is free again; the invalidated demand re-launches.
    expect(report.launched).toHaveLength(1);
  });

  it("heartbeats keep a long run alive", async () => {
    const { ledger, controller } = build();
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: ["expert"], prompt: "Work." });
    const first = await controller.tick(0);
    const runId = first.launched[0].runId;
    controller.heartbeat(runId, 9 * 60_000);
    const report = await controller.tick(11 * 60_000);
    expect(report.reaped).toHaveLength(0);
    expect(ledger.run(runId)?.state).toBe("running");
  });

  it("abort requests are forwarded to the host", async () => {
    const { ledger, controller, host } = build();
    ledger.upsertTask({ id: "t", demandConstant: 1, tiers: ["expert"], prompt: "Work." });
    const first = await controller.tick(0);
    const runId = first.launched[0].runId;
    ledger.requestAbort(runId);
    await controller.tick(1000);
    expect(host.aborted).toEqual([runId]);
  });

  it("circuit breaker: a crashing task stops launching inside the error window", async () => {
    const { ledger, controller } = build();
    ledger.upsertTask({ id: "crashy", demandConstant: 5, tiers: ["standard"], prompt: "Work." });
    let now = 0;
    for (let i = 0; i < 3; i++) {
      const report = await controller.tick(now);
      for (const l of report.launched) {
        controller.runFinished(l.runId, { state: "error", detail: "boom" }, now + 500);
      }
      now += 60_000;
    }
    const blocked = await controller.tick(now);
    expect(blocked.launched).toHaveLength(0);
    expect(blocked.skipped).toContainEqual({ taskId: "crashy", reason: "error-backoff" });
    // Outside the 30-minute window the breaker closes again.
    const recovered = await controller.tick(now + 31 * 60_000);
    expect(recovered.launched.length).toBeGreaterThan(0);
  });

  it("a finished run wakes tasks gated on it", async () => {
    let queue = 1;
    const { ledger, controller } = build({ "probe queue": () => queue });
    ledger.upsertTask({
      id: "ingest",
      demandCommand: "probe queue",
      tiers: ["standard"],
      prompt: "Ingest.",
    });
    ledger.upsertTask({
      id: "produce",
      demandConstant: 2,
      gate: "ingest.demand == 0",
      tiers: ["light", "standard"],
      prompt: "Produce.",
    });
    const first = await controller.tick(0);
    const ingestRun = first.launched.find((l) => l.taskId === "ingest")!;
    queue = 0;
    // Well inside the demand TTL: without invalidation the stale backlog
    // would keep the gate closed until expiry.
    controller.runFinished(ingestRun.runId, { state: "done" }, 10_000);
    const second = await controller.tick(20_000);
    expect(second.launched.some((l) => l.taskId === "produce")).toBe(true);
  });
});
