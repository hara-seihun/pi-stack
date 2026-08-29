import type { Broker } from "../broker/broker.js";
import type { Ledger, RunRow } from "../ledger/ledger.js";
import type { Scheduler } from "../tasks/scheduler.js";
import { allocate, desiredByTier } from "../tasks/allocate.js";
import type { EvaluateResult, Tier } from "../tasks/types.js";

/**
 * The controller is the launch loop: each tick it reaps dead runs, evaluates
 * the scheduler, and turns broker capacity into pending runs that runner
 * processes claim. It never touches a session itself — the ledger is the
 * only channel to runners — and holds no state of its own, so a controller
 * restart (or update) affects no running agent.
 *
 * It also never ends one. A live session belongs to the agent working in it
 * until that agent has spent its asks, and composition is converged by what
 * the controller launches into slots as they free, never by taking a slot
 * back. The controller used to shed one surplus session per tick so a mix
 * change would land before attrition; on the night of 2026-08-22 that loop
 * killed fourteen consecutive frontier sessions, thirty seconds apart, each
 * one mid-thought in its first work turn, because the freed slot was never
 * placeable and the surplus therefore never cleared. Hours of warm context
 * bought a rebalance that never happened. A mis-composed fleet costs a lane
 * some share for an hour; shedding costs an agent everything it was holding,
 * and the fleet is not owed that.
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
      if ((run.heartbeatAt ?? run.startedAt) >= now - this.cfg.heartbeatTimeoutMs) continue;
      if (this.ledger.runSession(run.id)?.sessionFile !== undefined) {
        this.ledger.requeueRun(run.id, now);
      } else {
        this.ledger.finishRun(run.id, { state: "aborted", detail: "runner heartbeat timeout" }, now);
        this.ledger.taskFinished(run.taskId);
      }
      reaped.push(run.id);
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
    const activeRuns: RunRow[] = [];
    for (const run of this.ledger.runs()) {
      if (run.state !== "pending" && run.state !== "running") continue;
      activeRuns.push(run);
      activeByTask.set(run.taskId, (activeByTask.get(run.taskId) ?? 0) + 1);
    }
    const missingTeamRoles = new Map<
      string,
      Array<{ role: "worker" | "supervisor"; slot: number }>
    >();
    for (const task of tasks.values()) {
      if (task.team === undefined) continue;
      const held = new Set(
        activeRuns
          .filter((run) => run.taskId === task.id && run.teamRole !== undefined)
          .map((run) => `${run.teamRole}:${run.teamSlot ?? 0}`),
      );
      const desired: Array<{ role: "worker" | "supervisor"; slot: number }> = [
        { role: "supervisor", slot: 0 },
        ...Array.from(
          { length: task.team.workers },
          (_, index) => ({ role: "worker" as const, slot: index + 1 }),
        ),
      ];
      missingTeamRoles.set(
        task.id,
        desired.filter(({ role, slot }) => !held.has(`${role}:${slot}`)),
      );
    }
    const activeTeamPresenceByTier = (taskId: string): Partial<Record<Tier, number>> => {
      const held: Partial<Record<Tier, number>> = {};
      for (const run of activeRuns) {
        if (run.taskId !== taskId) continue;
        held[run.tier] = (held[run.tier] ?? 0) + 1;
      }
      return held;
    };

    // A pending or running ordinary session holds one work unit. A team
    // lane's demand is boolean instead: any positive reading asks for its
    // complete roster, and the controller fills only the roles currently
    // missing from that roster. Recent ended runs still smooth ordinary lane
    // composition, but cannot occupy a fixed team role after that role ends.
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
      .map((t) => {
        const team = tasks.get(t.taskId)?.team;
        return {
          ...t,
          units:
            t.units === undefined
              ? undefined
              : team !== undefined
                ? t.units > 0
                  ? missingTeamRoles.get(t.taskId)?.length ?? 0
                  : 0
                : Math.max(0, t.units - (activeByTask.get(t.taskId) ?? 0)),
          heldByTier:
            team === undefined
              ? this.ledger.fleetPresenceByTier(
                  t.taskId,
                  now - this.cfg.compositionWindowMs,
                  now,
                )
              : activeTeamPresenceByTier(t.taskId),
        };
      });

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
        const teamRole = missingTeamRoles.get(a.taskId)?.shift();
        const runId = this.ledger.createRun({
          taskId: a.taskId,
          tier: a.tier,
          ...admission,
          ...(teamRole === undefined
            ? {}
            : { teamRole: teamRole.role, teamSlot: teamRole.slot }),
          at: now,
        });
        created.push(this.ledger.run(runId)!);
      }
    }
    return { evaluation, created, reaped, expired, skipped };
  }
}
