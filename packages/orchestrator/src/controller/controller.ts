import type { Broker } from "../broker/broker.js";
import type { Ledger, RunRow } from "../ledger/ledger.js";
import type { Scheduler } from "../tasks/scheduler.js";
import { allocate } from "../tasks/allocate.js";
import type { EvaluateResult, Tier } from "../tasks/types.js";

/**
 * The controller is the launch loop: each tick it reaps dead runs, evaluates
 * the scheduler, and turns broker capacity into pending runs that runner
 * processes claim. It never touches a session itself — the ledger is the
 * only channel to runners — and holds no state of its own, so a controller
 * restart (or update) affects no running agent.
 */

export interface ControllerConfig {
  /** A running run whose heartbeat is older than this is presumed dead. */
  readonly heartbeatTimeoutMs: number;
  /** A pending run no runner claimed within this window is aborted;
   * its account reservation is released. */
  readonly claimTimeoutMs: number;
  /** Circuit breaker: a task with this many error runs inside the window is
   * skipped, so a crashing task cannot hot-loop through plan capacity. */
  readonly errorWindowMs: number;
  readonly errorThreshold: number;
  /** How far back the allocator looks when measuring what share of launches a
   * task has already had. Long enough to smooth single-slot cycles, short
   * enough that a demand change is honoured within a shift. */
  readonly fairnessWindowMs: number;
}

export const CONTROLLER_DEFAULTS: ControllerConfig = {
  heartbeatTimeoutMs: 10 * 60_000,
  claimTimeoutMs: 2 * 60_000,
  errorWindowMs: 30 * 60_000,
  errorThreshold: 3,
  fairnessWindowMs: 6 * 60 * 60_000,
};

export interface TickReport {
  readonly evaluation: EvaluateResult;
  /** Pending runs created this tick, awaiting runner claim. */
  readonly created: readonly RunRow[];
  readonly reaped: readonly string[];
  readonly expired: readonly string[];
  readonly skipped: readonly { taskId: string; reason: "error-backoff" | "no-admission" }[];
}

export class Controller {
  private readonly cfg: ControllerConfig;

  constructor(
    private readonly ledger: Ledger,
    private readonly scheduler: Scheduler,
    private readonly broker: Broker,
    cfg: Partial<ControllerConfig> = {},
  ) {
    this.cfg = { ...CONTROLLER_DEFAULTS, ...cfg };
  }

  async tick(now = Date.now()): Promise<TickReport> {
    const reaped: string[] = [];
    for (const run of this.ledger.runs({ state: "running" })) {
      if ((run.heartbeatAt ?? run.startedAt) < now - this.cfg.heartbeatTimeoutMs) {
        this.ledger.finishRun(run.id, { state: "aborted", detail: "runner heartbeat timeout" }, now);
        this.ledger.taskFinished(run.taskId);
        reaped.push(run.id);
      }
    }
    const expired: string[] = [];
    for (const run of this.ledger.expireUnclaimed(now - this.cfg.claimTimeoutMs, now)) {
      this.ledger.taskFinished(run.taskId);
      expired.push(run.id);
    }

    const evaluation = await this.scheduler.evaluate(now);
    const skipped: { taskId: string; reason: "error-backoff" | "no-admission" }[] = [];
    if (evaluation.launches === "paused") {
      return { evaluation, created: [], reaped, expired, skipped };
    }

    const tasks = new Map(this.ledger.tasks().map((t) => [t.id, t]));
    const activeByTask = new Map<string, number>();
    for (const run of this.ledger.runs()) {
      if (run.state !== "pending" && run.state !== "running") continue;
      activeByTask.set(run.taskId, (activeByTask.get(run.taskId) ?? 0) + 1);
    }
    // A pending or running session is presumed to hold one work unit, so
    // demand is netted against it: a backlog of 3 with 2 agents on it wants
    // exactly one more agent, not three.
    const launchable = evaluation.tasks
      .filter((t) => {
        if (!t.eligible || tasks.get(t.taskId)?.prompt === undefined) return false;
        if (
          this.ledger.recentErrorCount(t.taskId, now - this.cfg.errorWindowMs) >=
          this.cfg.errorThreshold
        ) {
          skipped.push({ taskId: t.taskId, reason: "error-backoff" });
          return false;
        }
        return true;
      })
      .map((t) => ({
        ...t,
        units:
          t.units === undefined
            ? undefined
            : Math.max(0, t.units - (activeByTask.get(t.taskId) ?? 0)),
        recentLaunches: this.ledger.recentLaunchCount(t.taskId, now - this.cfg.fairnessWindowMs),
      }));

    const demandByTier: Partial<Record<Tier, number>> = {};
    for (const t of launchable) {
      for (const tier of t.tiers) {
        demandByTier[tier] = (demandByTier[tier] ?? 0) + Math.ceil(t.units ?? 0);
      }
    }
    const created: RunRow[] = [];
    const { assignments } = allocate(launchable, this.broker.slotsByTier(now, demandByTier));
    for (const a of assignments) {
      for (let i = 0; i < a.count; i++) {
        const admission = this.broker.admit(a.tier, now);
        if (admission === undefined) {
          skipped.push({ taskId: a.taskId, reason: "no-admission" });
          break;
        }
        const runId = this.ledger.createRun({
          taskId: a.taskId,
          tier: a.tier,
          ...admission,
          at: now,
        });
        created.push(this.ledger.run(runId)!);
      }
    }
    return { evaluation, created, reaped, expired, skipped };
  }
}
