import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { Runner, bumpRunnerGeneration } from "../src/host/runner.js";
import type { HostManager, LaunchSpec } from "../src/host/types.js";

class FakeEngine implements HostManager {
  launched: LaunchSpec[] = [];
  aborted: string[] = [];
  launch(spec: LaunchSpec): void {
    this.launched.push(spec);
  }
  abort(runId: string): void {
    this.aborted.push(runId);
  }
}

function seed(ledger: Ledger, count: number): string[] {
  ledger.upsertAccount({ id: "anth-1", provider: "anthropic" });
  ledger.upsertTask({ id: "t", demandConstant: 10, tiers: ["standard"], prompt: "Work." });
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
