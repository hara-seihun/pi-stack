import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { Runner, bumpRunnerGeneration } from "../src/host/runner.js";
import type { HostManager, HostMessage, LaunchSpec } from "../src/host/types.js";
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
  messages: { runId: string; message: HostMessage }[] = [];
  /** Live sessions only: a run this engine never launched cannot be told anything. */
  message(runId: string, message: HostMessage): boolean {
    if (!this.launched.some((spec) => spec.runId === runId)) return false;
    this.messages.push({ runId, message });
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
  it("a terminal rate limit belongs to the account rather than the task", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.runFinished(runId, { state: "error", detail: "Codex error: The usage limit has been reached" }, 200);
    const account = ledger.accounts().find((a) => a.id === "anth-1");
    expect(account?.cooldownUntil).toBe(30 * 60_000 + 200);
    expect(ledger.run(runId)?.state).toBe("aborted");
    expect(ledger.recentErrorCount("t", 0)).toBe(0);
  });

  it("backs off across runs after a burst throttle survives the shift's retry budget", () => {
    const ledger = Ledger.open(":memory:");
    const [first, second] = seed(ledger, 2);
    const runner = new Runner(ledger, new FakeEngine(), {
      runnerId: "r1",
      maxSessions: 2,
      cooldown: (family) => (family === "anthropic" ? 30_000 : 10 * 60_000),
    });
    runner.tick(100);
    const detail = '{"status":429,"title":"Too Many Requests"}';
    runner.runFinished(first, { state: "error", detail }, 200);
    expect(ledger.accounts().find((a) => a.id === "anth-1")?.cooldownUntil).toBe(
      30 * 60_000 + 200,
    );
    runner.runFinished(second, { state: "error", detail }, 300);
    expect(ledger.accounts().find((a) => a.id === "anth-1")?.cooldownUntil).toBe(
      60 * 60_000 + 300,
    );
  });

  it("a retired provider model aborts against launch custody instead of breaking the task", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.runFinished(
      runId,
      {
        state: "error",
        detail: "404: Thank you for the testing period. This model is now unavailable.",
      },
      200,
    );
    expect(ledger.run(runId)?.state).toBe("aborted");
    expect(ledger.recentErrorCount("t", 0)).toBe(0);
    expect(ledger.accounts().find((account) => account.id === "anth-1")?.cooldownUntil)
      .toBe(30 * 60_000 + 200);
  });

  it("an empty extra-usage balance cools the account instead of blaming the task", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.runFinished(
      runId,
      {
        state: "error",
        detail:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
      },
      200,
    );
    expect(ledger.run(runId)?.state).toBe("aborted");
    expect(ledger.recentErrorCount("t", 0)).toBe(0);
    expect(ledger.accounts().find((a) => a.id === "anth-1")?.cooldownUntil).toBe(
      30 * 60_000 + 200,
    );
  });

  it("the third-party extra-usage refusal is the same account exhaustion", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.runFinished(
      runId,
      {
        state: "error",
        detail:
          '400 {"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits."}',
      },
      200,
    );
    expect(ledger.run(runId)?.state).toBe("aborted");
    expect(ledger.accounts().find((a) => a.id === "anth-1")?.cooldownUntil).toBe(
      30 * 60_000 + 200,
    );
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

describe("a failed turn is weather, not the end of the session", () => {
  function throttled() {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    const runner = new Runner(ledger, new FakeEngine(), {
      runnerId: "r1",
      maxSessions: 5,
      cooldown: (family, detail) =>
        /weekly/i.test(detail) ? 6 * 60 * 60_000 : family === "anthropic" ? 60_000 : 10 * 60_000,
    });
    runner.tick(100);
    return { ledger, runId, runner };
  }

  it("backs off exponentially from the family's own cooldown class", () => {
    const { runId, runner } = throttled();
    expect(runner.turnFailed(runId, "429 rate-limited upstream", 1, 1000)).toBe(60_000);
    expect(runner.turnFailed(runId, "429 rate-limited upstream", 2, 1000)).toBe(120_000);
    expect(runner.turnFailed(runId, "429 rate-limited upstream", 3, 1000)).toBe(240_000);
    // Six attempts is the whole budget; after that the broker gets the task.
    expect(runner.turnFailed(runId, "429 rate-limited upstream", 7, 1000)).toBeUndefined();
  });

  it("cools the account while the session waits, so nothing new launches into the failure", () => {
    const { ledger, runId, runner } = throttled();
    runner.turnFailed(runId, "429 rate-limited upstream", 1, 1000);
    expect(ledger.accounts().find((a) => a.id === "anth-1")?.cooldownUntil).toBe(61_000);
    expect(ledger.run(runId)?.state).toBe("running"); // the agent is still alive
  });

  it("cools it for an ordinary failure too, so a dead provider stops drawing sessions", () => {
    const { ledger, runId, runner } = throttled();
    runner.turnFailed(runId, "500: provider is down", 2, 1000);
    expect(ledger.accounts().find((a) => a.id === "anth-1")?.cooldownUntil).toBe(61_000);
  });

  it("rides out a dropped stream on half a minute, whatever the family's rate-limit class", () => {
    const { runId, runner } = throttled();
    expect(runner.turnFailed(runId, "JSON error injected into SSE stream", 1, 1000)).toBe(30_000);
  });

  it("refuses to wait for a condition measured in hours, or for one that will never clear", () => {
    const { runId, runner } = throttled();
    expect(runner.turnFailed(runId, "weekly limit reached", 1, 1000)).toBeUndefined();
    expect(runner.turnFailed(runId, "No API key found for openai-codex-9.", 1, 1000)).toBeUndefined();
    expect(runner.turnFailed(runId, "unknown model gpt-5.6-luna", 1, 1000)).toBeUndefined();
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
    expect(engine.messages.map((m) => m.message.text)).toEqual([
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

  it("routes idle notifications and supervisor replies as durable Pi messages", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic" });
    ledger.upsertTask({
      id: "team",
      demandConstant: 1,
      tiers: mix("standard"),
      prompt: "Whole programme.",
      cwd: "/work",
      team: { workers: 1, supervisorPrompt: "Observe." },
    });
    const create = (teamRole: "worker" | "supervisor", teamSlot: number, at: number) =>
      ledger.createRun({
        taskId: "team",
        tier: "standard",
        accountId: "anth-1",
        model: "claude-opus",
        provider: "anthropic",
        teamRole,
        teamSlot,
        at,
      });
    const supervisorId = create("supervisor", 0, 1);
    const workerId = create("worker", 1, 2);
    const engine = new FakeEngine();
    const runner = new Runner(ledger, engine, { runnerId: "r1", maxSessions: 5 });
    runner.tick(100);
    runner.sessionStarted(workerId, "session-worker", "/sessions/worker.jsonl");
    expect(runner.teamWorkerSession(supervisorId, workerId).sessionFile)
      .toBe("/sessions/worker.jsonl");

    const idle = runner.teamWorkerIdle(workerId);
    runner.tick(150);
    expect(engine.messages[0]).toMatchObject({
      runId: supervisorId,
      message: {
        senderRunId: workerId,
        replyRunId: workerId,
        replyIdleAt: idle.idleAt,
      },
    });
    expect(engine.messages[0]?.message.text).toContain("read_compressed_context");

    expect(
      runner.teamSupervisorResponded(
        supervisorId,
        workerId,
        idle.idleAt,
        "Step back from the constant ladder and look for the general mechanism.",
      ),
    ).toBe("resumed");
    runner.tick(200);
    expect(engine.messages[1]).toEqual({
      runId: workerId,
      message: {
        text: "Step back from the constant ladder and look for the general mechanism.",
        senderRunId: supervisorId,
        replyRunId: undefined,
        replyIdleAt: undefined,
      },
    });
    expect(ledger.pendingRunMessages(workerId)).toEqual([]);
  });

  it("an empty message is a mistake, not a turn", () => {
    const ledger = Ledger.open(":memory:");
    const [runId] = seed(ledger, 1);
    expect(() => ledger.queueRunMessage(runId, "   ")).toThrow();
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
