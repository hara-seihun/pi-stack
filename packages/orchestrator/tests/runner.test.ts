import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { Runner, bumpRunnerGeneration } from "../src/host/runner.js";
import type { HostManager, LaunchSpec } from "../src/host/types.js";
import { mix } from "./harness.js";

class FakeEngine implements HostManager {
  launched: LaunchSpec[] = [];
  aborted: string[] = [];
  launch(spec: LaunchSpec): void {
    this.launched.push(spec);
    this.live.add(spec.runId);
  }
  abort(runId: string): void {
    this.aborted.push(runId);
  }
  killed: { runId: string; detail: string }[] = [];
  kill(runId: string, detail: string): void {
    this.killed.push({ runId, detail });
    this.live.delete(runId);
  }
  live = new Set<string>();
  liveRuns(): readonly string[] {
    return [...this.live];
  }
  messages: { runId: string; text: string }[] = [];
  /** Live sessions only: a run this engine never launched cannot be told anything. */
  message(runId: string, text: string): boolean {
    if (!this.launched.some((spec) => spec.runId === runId)) return false;
    this.messages.push({ runId, text });
    return true;
  }
}

function seed(ledger: Ledger, count: number): string[] {
  ledger.upsertAccount({ id: "anth-1", provider: "anthropic" });
  ledger.upsertTask({ id: "t", demandConstant: 10, tiers: mix("standard"), prompt: "Work." });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      ledger.createRun({
        taskId: "t",
        tier: "standard",
        accountId: "anth-1",
        model: "claude-opus",
        provider: "anthropic",
        at: i,
      }),
    );
  }
  return ids;
}

describe("runner claims", () => {
  it("two runners never claim the same run and respect their capacity", () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, 5);
    const e1 = new FakeEngine();
    const e2 = new FakeEngine();
    const r1 = new Runner(ledger, e1, { runnerId: "r1", maxSessions: 2 });
    const r2 = new Runner(ledger, e2, { runnerId: "r2", maxSessions: 100 });
    const a = r1.tick(100);
    const b = r2.tick(100);
    expect(a.claimed).toHaveLength(2); // capacity-capped
    expect(b.claimed).toHaveLength(3); // the rest
    const all = [...a.claimed, ...b.claimed].map((s) => s.runId);
    expect(new Set(all).size).toBe(5); // no double-claims
    expect(ledger.runs({ state: "pending" })).toHaveLength(0);
    expect(ledger.runs({ state: "running", runnerId: "r1" })).toHaveLength(2);
  });

  it("claims oldest pending runs first", () => {
    const ledger = Ledger.open(":memory:");
    const ids = seed(ledger, 3);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 2 });
    const claimed = runner.tick(100).claimed.map((s) => s.runId);
    expect(claimed).toEqual([ids[0], ids[1]]);
  });

  it("a claim for a deleted task aborts the run instead of launching", () => {
    const ledger = Ledger.open(":memory:");
    const ids = seed(ledger, 1);
    ledger.deleteTask("t");
    const engine = new FakeEngine();
    const runner = new Runner(ledger, engine, { runnerId: "r1", maxSessions: 10 });
    expect(runner.tick(100).claimed).toHaveLength(0);
    expect(engine.launched).toHaveLength(0);
    expect(ledger.run(ids[0])?.state).toBe("aborted");
    expect(ledger.run(ids[0])?.detail).toBe("task deleted");
  });

  it("finished sessions free capacity for the next claim", () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, 3);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 2 });
    const first = runner.tick(100);
    expect(first.claimed).toHaveLength(2);
    runner.runFinished(first.claimed[0].runId, { state: "done" }, 200);
    expect(runner.tick(300).claimed).toHaveLength(1);
  });
});

describe("runner generations", () => {
  it("a generation bump drains live runners without killing sessions", () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, 3);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 2 });
    const first = runner.tick(100);
    expect(first.claimed).toHaveLength(2);

    bumpRunnerGeneration(ledger);
    const second = runner.tick(200);
    expect(second.draining).toBe(true);
    expect(second.claimed).toHaveLength(0); // stops claiming immediately
    expect(ledger.runs({ state: "running" })).toHaveLength(2); // nothing killed
    expect(runner.drained()).toBe(false); // still hosting

    // A new runner (started under the new generation) takes over claiming.
    const next = new Runner(ledger, new FakeEngine(), { runnerId: "r2", maxSessions: 10 });
    expect(next.tick(300).claimed).toHaveLength(1);

    // Once the old runner's sessions end, it reports drained and can exit.
    for (const spec of first.claimed) runner.runFinished(spec.runId, { state: "done" }, 400);
    runner.tick(500);
    expect(runner.drained()).toBe(true);
  });

  it("a draining runner still forwards aborts for its own sessions", () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, 1);
    const engine = new FakeEngine();
    const runner = new Runner(ledger, engine, { runnerId: "r1", maxSessions: 10 });
    const [spec] = runner.tick(100).claimed;
    bumpRunnerGeneration(ledger);
    ledger.requestAbort(spec.runId);
    runner.tick(200);
    expect(engine.aborted).toEqual([spec.runId]);
  });
});

describe("runner result classification", () => {
  it("a rate-limited error run cools the account down for broker admission", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.runFinished(runId, { state: "error", detail: "Codex error: The usage limit has been reached" }, 200);
    const account = ledger.accounts().find((a) => a.id === "anth-1");
    expect(account?.cooldownUntil).toBeGreaterThan(200);
    expect(ledger.run(runId)?.state).toBe("error");
  });

  it("an ordinary error run does not cool the account", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.runFinished(runId, { state: "error", detail: "TypeError: cannot read properties" }, 200);
    const account = ledger.accounts().find((a) => a.id === "anth-1");
    expect(account?.cooldownUntil ?? 0).toBe(0);
  });
});

describe("credential failures are the account's, not the task's", () => {
  it("an unauthenticated account aborts the run and cools down, sparing the breaker", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.runFinished(
      runId,
      { state: "error", detail: "Error: No API key found for openai-codex-9." },
      200,
    );
    expect(ledger.run(runId)?.state).toBe("aborted");
    expect(ledger.run(runId)?.detail).toMatch(/No API key found/);
    expect(ledger.recentErrorCount("t", 0)).toBe(0); // cannot trip the task breaker
    expect(ledger.accounts().find((a) => a.id === "anth-1")?.cooldownUntil).toBeGreaterThan(200);
  });
});

describe("operator messages reach a live session", () => {
  it("delivers queued messages once, in order, to the owning runner's sessions", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const engine = new FakeEngine();
    const runner = new Runner(ledger, engine, { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);

    ledger.queueRunMessage(runId, "Keep every command under a minute.", 150);
    ledger.queueRunMessage(runId, "Timeout everything.", 160);
    runner.tick(200);
    expect(engine.messages.map((m) => m.text)).toEqual([
      "Keep every command under a minute.",
      "Timeout everything.",
    ]);

    // Delivery is recorded, so the next tick does not repeat itself.
    runner.tick(300);
    expect(engine.messages).toHaveLength(2);
    expect(ledger.pendingRunMessages(runId)).toEqual([]);
  });

  it("a message for a session this runner does not hold stays queued", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const owner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    owner.tick(100);

    // A second runner sees the run row but hosts no session for it: the
    // message must not be marked delivered by a process that cannot deliver.
    const bystander = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    ledger.queueRunMessage(runId, "Stop that.", 150);
    bystander.tick(200);
    expect(ledger.pendingRunMessages(runId).map((m) => m.text)).toEqual(["Stop that."]);
  });

  it("an empty message is a mistake, not a turn", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    expect(() => ledger.queueRunMessage(runId, "   ")).toThrow();
  });
});

describe("a drained queue lane ends its shift", () => {
  it("only for lanes that asked, and only against a current, successful probe", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic" });
    ledger.upsertTask({ id: "review", demandCommand: "queue", tiers: mix("standard"), prompt: "Review.", exitWhenDrained: true });
    ledger.upsertTask({ id: "frontier", demandCommand: "queue", tiers: mix("standard"), prompt: "Attack." });
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });

    // Nothing probed yet: an unobserved queue is not an empty one.
    expect(runner.laneDrained("review", 10_000)).toBe(false);

    ledger.recordDemand("review", { units: 3 }, 10_000);
    expect(runner.laneDrained("review", 10_000)).toBe(false);

    ledger.recordDemand("review", { units: 0 }, 20_000);
    expect(runner.laneDrained("review", 20_000)).toBe(true);
    // The same reading five minutes later says nothing about the queue now.
    expect(runner.laneDrained("review", 20_000 + 6 * 60_000)).toBe(false);

    ledger.recordDemand("review", { error: "probe failed" }, 30_000);
    expect(runner.laneDrained("review", 30_000)).toBe(false);

    // A research lane keeps its warm context however quiet its probe goes.
    ledger.recordDemand("frontier", { units: 0 }, 30_000);
    expect(runner.laneDrained("frontier", 30_000)).toBe(false);
    ledger.close();
  });
});

describe("a session that stops making progress is torn down", () => {
  it("asks first, then kills, and a live session keeps its slot", () => {
    const ledger = Ledger.open(":memory:");
    const [stuck, healthy] = seed(ledger, 2);
    const engine = new FakeEngine();
    const runner = new Runner(ledger, engine, {
      runnerId: "r1",
      maxSessions: 5,
      progressTimeoutMs: 1_000,
      stallKillGraceMs: 500,
    });
    runner.tick(1_000);

    // Both sessions are streaming.
    ledger.progressRun(stuck!, 1_000);
    ledger.progressRun(healthy!, 1_000);
    expect(runner.tick(1_500).stalled).toEqual([]);
    expect(engine.aborted).toEqual([]);

    // One goes quiet. Cursor-style parks keep heartbeating, so only recorded
    // session activity may hold a run open.
    ledger.progressRun(healthy!, 2_100);
    ledger.heartbeatRun(stuck!, 2_100);
    expect(runner.tick(2_100).stalled).toEqual([]);
    expect(engine.aborted).toEqual([stuck]);
    expect(ledger.run(stuck!)?.state).toBe("running");

    // The abort had its grace period and the session never came back.
    ledger.progressRun(healthy!, 2_700);
    const report = runner.tick(2_700);
    expect(report.stalled).toEqual([stuck]);
    expect(engine.killed.map((k) => k.runId)).toEqual([stuck]);
    expect(report.active).toBe(1);
    expect(ledger.run(healthy!)?.state).toBe("running");
    ledger.close();
  });
});

describe("a session may not outlive its run row", () => {
  it("tears down a session whose run was killed out from under it", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const engine = new FakeEngine();
    const runner = new Runner(ledger, engine, { runnerId: "r1", maxSessions: 5 });
    runner.tick(1_000);
    expect(engine.liveRuns()).toEqual([runId]);

    ledger.finishRun(runId!, { state: "aborted", detail: "killed by operator" }, 2_000);
    const report = runner.tick(2_000);

    expect(report.stalled).toEqual([runId]);
    expect(engine.killed).toEqual([{ runId, detail: "killed by operator" }]);
    expect(engine.liveRuns()).toEqual([]);
    ledger.close();
  });
});
