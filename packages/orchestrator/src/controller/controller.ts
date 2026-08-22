import type { Broker } from "../broker/broker.js";
import type { Ledger, RunRow } from "../ledger/ledger.js";
import type { Scheduler } from "../tasks/scheduler.js";
import { allocate, desiredByTier, surpluses } from "../tasks/allocate.js";
import type { EvaluateResult, TaskSnapshot, Tier } from "../tasks/types.js";

/**
 * The controller is the launch loop: each tick it reaps dead runs, evaluates
 * the scheduler, and turns broker capacity into pending runs that runner
 * processes claim. It never touches a session itself — the ledger is the
 * only channel to runners — and holds no state of its own, so a controller
 * restart (or update) affects no running agent.
 */

export interface ControllerConfig {
  /** Enumerates the account ids the fleet can currently authenticate, from
   * its credential stores. Observed each tick into the ledger's
   * `fleet_credentialed` column, so admission follows credential custody
   * instead of an operator-maintained flag. Omitted (tests, read-only
   * consumers) means the recorded observations stand. */
  readonly fleetCredentials?: () => ReadonlySet<string>;
  /** A running run whose heartbeat is older than this is presumed dead. */
  readonly heartbeatTimeoutMs: number;
  /** A pending run no runner claimed within this window is aborted;
   * its account reservation is released. */
  readonly claimTimeoutMs: number;
  /** Circuit breaker: a task with this many error runs inside the window is
   * skipped, so a crashing task cannot hot-loop through plan capacity. */
  readonly errorWindowMs: number;
  readonly errorThreshold: number;
  /** The window over which a lane's hold on the machine is averaged. Long
   * enough that lanes with short sessions and lanes with hours-long ones are
   * compared on the same footing, short enough that a share or mix change is
   * honoured while the operator is still watching. */
  readonly compositionWindowMs: number;
}

export const CONTROLLER_DEFAULTS: ControllerConfig = {
  heartbeatTimeoutMs: 10 * 60_000,
  claimTimeoutMs: 2 * 60_000,
  errorWindowMs: 30 * 60_000,
  errorThreshold: 3,
  compositionWindowMs: 60 * 60_000,
};

export interface TickReport {
  readonly evaluation: EvaluateResult;
  /** Pending runs created this tick, awaiting runner claim. */
  readonly created: readonly RunRow[];
  readonly reaped: readonly string[];
  readonly expired: readonly string[];
  readonly skipped: readonly { taskId: string; reason: "error-backoff" | "no-admission" }[];
  /** A session asked to stop this tick so the fleet can re-compose. */
  readonly shed?: string;
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
    if (this.cfg.fleetCredentials !== undefined) {
      this.ledger.syncFleetCredentials(this.cfg.fleetCredentials());
    }
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
        heldByTier: this.ledger.fleetPresenceByTier(
          t.taskId,
          now - this.cfg.compositionWindowMs,
          now,
        ),
      }));

    // What the tiers are worth to the broker is what the claims would put in
    // them: a lane wanting twenty light sessions per standard one must not
    // have scarce standard accounts held for a standard session it is not
    // going to ask for, and must have light slots advertised in the quantity
    // it will actually take.
    const demandByTier = desiredByTier(launchable, this.broker.maxSlotsPerCycle);
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
    const shed = this.shed(launchable, created.length, now);
    return { evaluation, created, reaped, expired, skipped, ...(shed ? { shed } : {}) };
  }

  /**
   * Gives one session back when the machine is full and holding the wrong
   * shape, so a lane's declared mix takes effect before its sessions happen
   * to end.
   *
   * Sessions here run for hours, and allocation can only place slots that
   * exist: after an operator changed a lane from twenty light per standard to
   * five, the fleet sat at forty-six light and one standard with the quota
   * for eight standard sessions unused, and nothing but attrition would have
   * moved it. One session per tick is deliberate — enough to converge over a
   * few minutes, little enough that a mistake costs one agent's context
   * rather than the fleet's.
   *
   * The youngest session of the over-served pair goes: it is the one with the
   * least work behind it. Nothing is shed while slots were launched this
   * tick (the machine was not full), nor for a tier the broker could not fund
   * anyway.
   */
  private shed(tasks: readonly TaskSnapshot[], created: number, now: number): string | undefined {
    if (created > 0) return undefined;
    const running = this.ledger.runs({ state: "running" });
    for (const over of surpluses(tasks, (tier) => this.broker.hasQuotaFor(tier, now))) {
      const youngest = running
        .filter((r) => r.taskId === over.taskId && r.tier === over.tier)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (youngest === undefined) continue; // a surplus with nothing live to give
      this.ledger.requestAbort(youngest.id);
      return youngest.id;
    }
    return undefined;
  }
}
