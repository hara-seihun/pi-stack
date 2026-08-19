import type { Broker } from "../broker/broker.js";
import type { Ledger } from "../ledger/ledger.js";
import type { Scheduler } from "../tasks/scheduler.js";
import { allocate } from "../tasks/allocate.js";
import type { HostEvents, HostManager, HostRunResult, LaunchSpec } from "../host/types.js";
import type { EvaluateResult, Tier } from "../tasks/types.js";

/**
 * The controller is the launch loop: each tick it reaps dead runs, forwards
 * abort requests, evaluates the scheduler, and turns broker capacity into
 * host launches. It holds no state of its own — every fact lives in the
 * ledger, so a controller restart loses nothing and a stale heartbeat is the
 * only signal needed to recover from a crashed host.
 */

export interface ControllerConfig {
  /** A running run whose heartbeat is older than this is presumed dead. */
  readonly heartbeatTimeoutMs: number;
  /** Circuit breaker: a task with this many error runs inside the window is
   * skipped, so a crashing task cannot hot-loop through capacity. */
  readonly errorWindowMs: number;
  readonly errorThreshold: number;
}

export const CONTROLLER_DEFAULTS: ControllerConfig = {
  heartbeatTimeoutMs: 10 * 60_000,
  errorWindowMs: 30 * 60_000,
  errorThreshold: 3,
};

export interface TickReport {
  readonly evaluation: EvaluateResult;
  readonly launched: readonly LaunchSpec[];
  readonly reaped: readonly string[];
  readonly skipped: readonly { taskId: string; reason: "error-backoff" | "no-admission" }[];
}

export class Controller implements HostEvents {
  private readonly cfg: ControllerConfig;

  constructor(
    private readonly ledger: Ledger,
    private readonly scheduler: Scheduler,
    private readonly broker: Broker,
    private readonly host: HostManager,
    cfg: Partial<ControllerConfig> = {},
  ) {
    this.cfg = { ...CONTROLLER_DEFAULTS, ...cfg };
  }

  async tick(now = Date.now()): Promise<TickReport> {
    const reaped: string[] = [];
    for (const run of this.ledger.runs({ state: "running" })) {
      if ((run.heartbeatAt ?? run.startedAt) < now - this.cfg.heartbeatTimeoutMs) {
        this.runFinished(run.id, { state: "error", detail: "heartbeat timeout" }, now);
        reaped.push(run.id);
      } else if (run.abortRequested) {
        this.host.abort(run.id);
      }
    }

    const evaluation = await this.scheduler.evaluate(now);
    const skipped: { taskId: string; reason: "error-backoff" | "no-admission" }[] = [];
    if (evaluation.launches === "paused") {
      return { evaluation, launched: [], reaped, skipped };
    }

    const tasks = new Map(this.ledger.tasks().map((t) => [t.id, t]));
    const activeByTask = new Map<string, number>();
    for (const run of this.ledger.runs({ state: "running" })) {
      activeByTask.set(run.taskId, (activeByTask.get(run.taskId) ?? 0) + 1);
    }
    // A running session is presumed to hold one work unit, so demand is
    // netted against in-flight runs: a backlog of 3 with 2 agents on it
    // wants exactly one more agent, not three.
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
      }));

    const demandByTier: Partial<Record<Tier, number>> = {};
    for (const t of launchable) {
      for (const tier of t.tiers) {
        demandByTier[tier] = (demandByTier[tier] ?? 0) + Math.ceil(t.units ?? 0);
      }
    }
    const launched: LaunchSpec[] = [];
    const { assignments } = allocate(launchable, this.broker.slotsByTier(now, demandByTier));
    for (const a of assignments) {
      const task = tasks.get(a.taskId);
      if (task?.prompt === undefined) continue;
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
        const spec: LaunchSpec = {
          runId,
          taskId: a.taskId,
          prompt: task.prompt,
          cwd: task.cwd,
          ...admission,
        };
        this.host.launch(spec);
        launched.push(spec);
      }
    }
    return { evaluation, launched, reaped, skipped };
  }

  /** Terminal report for a run; also wakes the demand of the finished task
   * and every task gated on it. */
  runFinished(runId: string, result: HostRunResult, at = Date.now()): void {
    const run = this.ledger.run(runId);
    if (run === undefined || run.state !== "running") return;
    this.ledger.finishRun(runId, result, at);
    this.ledger.taskFinished(run.taskId);
  }

  heartbeat(runId: string, at = Date.now()): void {
    this.ledger.heartbeatRun(runId, at);
  }
}
