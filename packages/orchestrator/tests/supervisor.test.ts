import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { Runner, bumpRunnerGeneration } from "../src/host/runner.js";
import { RunnerSupervisor, type WorkerSpec } from "../src/host/supervisor.js";
import type { HostManager, LaunchSpec } from "../src/host/types.js";

class FakeEngine implements HostManager {
  launched: LaunchSpec[] = [];
  launch(spec: LaunchSpec): void {
    this.launched.push(spec);
  }
  abort(): void {}
  message(): boolean {
    return true;
  }
}

function seed(ledger: Ledger, count: number): void {
  ledger.upsertAccount({ id: "anth-1", provider: "anthropic" });
  ledger.upsertTask({ id: "t", demandConstant: 10, tiers: ["standard"], prompt: "Work." });
  for (let i = 0; i < count; i++) {
    ledger.createRun({
      taskId: "t",
      tier: "standard",
      accountId: "anth-1",
      model: "claude-opus",
      provider: "anthropic",
      at: i,
    });
  }
}

function supervisor(ledger: Ledger, spawned: WorkerSpec[]): RunnerSupervisor {
  return new RunnerSupervisor(ledger, (spec) => spawned.push(spec), {
    runnerId: "gmktec",
    maxSessions: 700,
    respawnBackoffMs: 5_000,
  });
}

describe("runner supervisor", () => {
  it("starts one worker and leaves it alone while the generation holds", () => {
    const ledger = Ledger.open(":memory:");
    const spawned: WorkerSpec[] = [];
    const live = supervisor(ledger, spawned);
    const first = live.tick(1_000);
    expect(first.spawned?.maxSessions).toBe(700);
    expect(live.tick(2_000).spawned).toBeUndefined();
    expect(live.tick(3_000).claiming).toBe(first.spawned?.workerId);
    expect(spawned).toHaveLength(1);
  });

  it("a drain starts the successor before the drained worker exits", () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, 3);
    const spawned: WorkerSpec[] = [];
    const live = supervisor(ledger, spawned);
    const old = live.tick(1_000).spawned!;

    // The old worker is hosting a session, so it cannot exit yet.
    const engine = new FakeEngine();
    const worker = new Runner(ledger, engine, { runnerId: old.workerId, maxSessions: 700 });
    worker.tick(1_100);
    expect(engine.launched).toHaveLength(3);

    bumpRunnerGeneration(ledger);
    const next = live.tick(2_000).spawned;
    expect(next).toBeDefined();
    expect(next?.workerId).not.toBe(old.workerId);
    expect(worker.tick(2_100).draining).toBe(true);
    expect(worker.drained()).toBe(false); // still hosting, nothing killed

    // The successor claims new work during the old worker's whole drain.
    seed(ledger, 1);
    const successor = new Runner(ledger, new FakeEngine(), {
      runnerId: next!.workerId,
      maxSessions: 700,
    });
    expect(successor.tick(2_200).claimed).toHaveLength(1);

    // The drained worker's later exit is expected and spawns nothing.
    live.workerExited(old.workerId, 9_000);
    expect(live.tick(9_100).spawned).toBeUndefined();
    expect(spawned).toHaveLength(2);
  });

  it("replaces a worker that dies under the live generation, after a backoff", () => {
    const ledger = Ledger.open(":memory:");
    const spawned: WorkerSpec[] = [];
    const live = supervisor(ledger, spawned);
    const crashed = live.tick(1_000).spawned!;

    live.workerExited(crashed.workerId, 1_500);
    expect(live.tick(2_000).spawned).toBeUndefined(); // backoff: no hot loop
    const replacement = live.tick(7_000).spawned;
    expect(replacement?.workerId).not.toBe(crashed.workerId);
    expect(replacement?.generation).toBe(crashed.generation);
  });

  it("gives every worker a distinct id so stale rows never eat capacity", () => {
    const ledger = Ledger.open(":memory:");
    const spawned: WorkerSpec[] = [];
    const live = supervisor(ledger, spawned);
    live.tick(1_000);
    for (let i = 0; i < 3; i++) {
      bumpRunnerGeneration(ledger);
      live.tick(2_000 + i);
    }
    expect(new Set(spawned.map((s) => s.workerId)).size).toBe(spawned.length);
  });
});
