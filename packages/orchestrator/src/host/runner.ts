import type { Ledger } from "../ledger/ledger.js";
import {
  type CooldownPolicy,
  CREDENTIAL_COOLDOWN_MS,
  isCredentialError,
  isPermanentError,
  isRateLimitError,
  uniformCooldown,
} from "../provider-errors.js";
import {
  MAX_CHECK_INS,
  type HostEvents,
  type HostManager,
  type HostRunResult,
  type LaunchSpec,
} from "./types.js";

/**
 * A runner is a separate process from the controller, so orchestrator
 * restarts never kill agents, and one runner hosts many embedded sessions,
 * so hundreds of agents do not mean hundreds of node processes. The ledger
 * is the only channel between controller and runners: the controller writes
 * pending runs, runners claim them atomically, results and heartbeats flow
 * back as row updates.
 *
 * Updates use generation draining: `runner_generation` is a control row;
 * when it changes, a live runner stops claiming and exits once its last
 * session ends, while a freshly started runner (reading the new generation)
 * takes over claiming. Nothing is ever killed mid-run.
 */

export interface RunnerConfig {
  readonly runnerId: string;
  /** Concurrent embedded sessions this process will host. */
  readonly maxSessions: number;
  /**
   * A session that records nothing for this long is stuck, not thinking. The
   * longest legitimate quiet stretch is one tool call (fleet sessions cap bash
   * at five minutes) or one silent stretch of reasoning, both far short of
   * this. The run is asked to abort at this point.
   */
  readonly progressTimeoutMs?: number;
  /** How long the polite abort gets before the session is torn down. A stall
   * inside a provider call never returns, so asking is not enough. */
  readonly stallKillGraceMs?: number;
  /** How long a rate-limited account sits out, per provider family. Absent,
   * every family is treated as plan-metered. */
  readonly cooldown?: CooldownPolicy;
}

const PROGRESS_TIMEOUT_MS = 20 * 60_000;
const STALL_KILL_GRACE_MS = 10 * 60_000;

/**
 * How a session rides out a provider failure instead of dying of it.
 *
 * The first wait is the family's own cooldown class where the error is a
 * rate limit — that number already answers "how long is this condition out
 * for", measured per family — and half a minute for anything else, which is
 * the shape of a dropped stream or a 500. It doubles per consecutive failure
 * and stops climbing at ten minutes; six attempts spend a little over half an
 * hour, after which the run ends and the broker places the task somewhere
 * with a working provider.
 *
 * A condition the provider names in hours (a weekly or monthly window) is not
 * weather and gets no waiting: the run ends at once so the account cools and
 * the task moves to a sibling.
 */
const RECOVERY_BASE_MS = 30_000;
const RECOVERY_MAX_MS = 10 * 60_000;
const RECOVERY_ATTEMPTS = 6;

/** A demand reading older than this says nothing about the queue now. The
 * controller re-probes on a 60s TTL, so anything this old means nobody is
 * measuring the lane — and an unmeasured lane never ends a live shift. */
const DEMAND_FRESH_MS = 5 * 60_000;

export interface RunnerTickReport {
  readonly claimed: readonly LaunchSpec[];
  readonly active: number;
  readonly draining: boolean;
  /** Runs torn down this tick for making no progress. */
  readonly stalled: readonly string[];
}

export class Runner implements HostEvents {
  private readonly generation: string;
  private draining = false;

  constructor(
    private readonly ledger: Ledger,
    private readonly engine: HostManager,
    private readonly cfg: RunnerConfig,
  ) {
    this.generation = ledger.getControl("runner_generation") ?? "1";
  }

  tick(now = Date.now()): RunnerTickReport {
    if ((this.ledger.getControl("runner_generation") ?? "1") !== this.generation) {
      this.draining = true;
    }
    const owned = this.ledger.runs({ state: "running", runnerId: this.cfg.runnerId });
    const progressTimeoutMs = this.cfg.progressTimeoutMs ?? PROGRESS_TIMEOUT_MS;
    const killGraceMs = this.cfg.stallKillGraceMs ?? STALL_KILL_GRACE_MS;
    const stalled: string[] = [];
    for (const run of owned) {
      const stalledForMs = now - (run.progressAt ?? run.claimedAt ?? run.startedAt);
      if (stalledForMs > progressTimeoutMs + killGraceMs) {
        this.engine.kill(
          run.id,
          `session made no progress for ${Math.round(stalledForMs / 60_000)}m`,
        );
        stalled.push(run.id);
        continue;
      }
      const overdue = stalledForMs > progressTimeoutMs;
      if (overdue && !run.abortRequested) this.ledger.requestAbort(run.id);
      if (overdue || run.abortRequested) this.engine.abort(run.id);
      // Operator messages are delivered exactly once: a message the host no
      // longer holds a session for stays queued rather than being lost, and
      // is retired with the run below.
      for (const message of this.ledger.pendingRunMessages(run.id)) {
        if (!this.engine.message(run.id, message.text)) break;
        this.ledger.markRunMessageDelivered(message.id, now);
      }
    }

    // A run can also end outside this loop — an operator `kill`, a controller reap
    // — and the ledger row is the authority on whether a session should exist. A
    // session outliving its row would hold a slot and keep spending an account.
    const ownedIds = new Set(owned.map((run) => run.id));
    for (const runId of this.engine.liveRuns()) {
      if (ownedIds.has(runId)) continue;
      const run = this.ledger.run(runId);
      if (run === undefined || run.state === "running") continue;
      this.engine.kill(runId, run.detail ?? `run ${run.state}`);
      stalled.push(runId);
    }

    const claimed: LaunchSpec[] = [];
    if (!this.draining) {
      const room = this.cfg.maxSessions - owned.length;
      const tasks = new Map(this.ledger.tasks().map((t) => [t.id, t]));
      for (const run of this.ledger.claimRuns(this.cfg.runnerId, room, now)) {
        const task = tasks.get(run.taskId);
        if (task?.prompt === undefined) {
          // The task vanished between creation and claim; not the task's
          // fault, so aborted rather than error.
          this.runFinished(run.id, { state: "aborted", detail: "task deleted" }, now);
          continue;
        }
        const spec: LaunchSpec = {
          runId: run.id,
          taskId: run.taskId,
          prompt: task.prompt,
          cwd: task.cwd,
          doctrineUrl: task.doctrineUrl,
          opening: task.opening,
          openingProbe: task.openingProbe,
          selfPaced: task.selfPaced,
          provider: run.provider,
          model: run.model,
          thinking: run.thinking,
          accountId: run.accountId,
        };
        this.engine.launch(spec);
        claimed.push(spec);
      }
    }
    const active = owned.length - stalled.length + claimed.length;
    return { claimed, active, draining: this.draining, stalled };
  }

  /** True when a draining runner has nothing left and should exit. */
  drained(): boolean {
    return (
      this.draining &&
      this.ledger.runs({ state: "running", runnerId: this.cfg.runnerId }).length === 0
    );
  }

  sessionStarted(runId: string, sessionId: string): void {
    this.ledger.linkRunSession(runId, sessionId);
  }

  runFinished(runId: string, result: HostRunResult, at = Date.now()): void {
    const run = this.ledger.run(runId);
    if (run === undefined) return;
    const detail = result.detail ?? "";
    // An account that cannot authenticate is not a failing task: recorded as
    // aborted (like an unclaimed run) so it never trips a task's circuit
    // breaker, and cooled down so waves stop being spent on it.
    const credential = result.state === "error" && isCredentialError(detail);
    this.ledger.finishRun(runId, credential ? { ...result, state: "aborted" } : result, at);
    this.ledger.taskFinished(run.taskId);
    if (credential) {
      this.ledger.setAccountCooldown(run.accountId, at + CREDENTIAL_COOLDOWN_MS);
      return;
    }
    // An exhausted account fails every launch it gets; cool it down so the
    // broker moves the task's next run to a sibling account instead of
    // burning the breaker window on the same dead meter.
    if (result.state === "error" && isRateLimitError(detail)) {
      const family = this.ledger.accounts().find((a) => a.id === run.accountId)?.provider;
      const cooldown = this.cfg.cooldown ?? uniformCooldown;
      this.ledger.setAccountCooldown(run.accountId, at + cooldown(family, detail));
    }
  }

  heartbeat(runId: string, at = Date.now()): void {
    this.ledger.heartbeatRun(runId, at);
  }

  progress(runId: string, at = Date.now()): void {
    this.ledger.progressRun(runId, at);
  }

  /**
   * Whether a shift on this lane should end instead of being re-prompted.
   * Only lanes that asked for it (`exitWhenDrained`) can end this way, and
   * only against a demand reading that is both current and successful:
   * unknown demand means the queue is unobserved, not empty, and tearing a
   * warm session down on a failed probe would cost the lane its context for
   * nothing.
   */
  /**
   * The shift's budget of asks, spent in the ledger so it is a property of
   * the run rather than of the process hosting it. A worker on a superseded
   * build cannot re-open a budget the run has already spent.
   */
  claimCheckIn(runId: string): boolean {
    return this.ledger.claimCheckIn(runId, MAX_CHECK_INS);
  }

  turnFailed(runId: string, detail: string, attempt: number, now = Date.now()): number | undefined {
    if (isCredentialError(detail) || isPermanentError(detail)) return undefined;
    if (attempt > RECOVERY_ATTEMPTS) return undefined;
    const run = this.ledger.run(runId);
    if (run === undefined) return undefined;
    const rateLimited = isRateLimitError(detail);
    const family = this.ledger.accounts().find((a) => a.id === run.accountId)?.provider;
    const cooldown = (this.cfg.cooldown ?? uniformCooldown)(family, detail);
    const base = rateLimited ? cooldown : RECOVERY_BASE_MS;
    if (base > RECOVERY_MAX_MS) return undefined;
    const waitMs = Math.min(base * 2 ** (attempt - 1), RECOVERY_MAX_MS);
    // The session waits, and meanwhile nothing new is launched onto the
    // account: an agent already holding context is the one worth keeping in
    // the queue, and a fresh launch into a provider that just failed is the
    // one worth not making. This holds for any failure, not only a throttle —
    // otherwise a hard-down provider keeps drawing fresh sessions, each of
    // which spends half an hour discovering the same outage.
    this.ledger.setAccountCooldown(run.accountId, now + waitMs);
    return waitMs;
  }

  laneDrained(taskId: string, now = Date.now()): boolean {
    const task = this.ledger.tasks().find((t) => t.id === taskId);
    if (task?.exitWhenDrained !== true) return false;
    if (task.demandConstant !== undefined) return task.demandConstant <= 0;
    const demand = this.ledger.demandState(taskId);
    if (demand?.units === undefined || demand.error !== undefined) return false;
    if (demand.probedAt === undefined || now - demand.probedAt > DEMAND_FRESH_MS) return false;
    return demand.units <= 0;
  }
}

/** Ordered but non-destructive: bump the generation and every live runner
 * drains; freshly started runners claim under the new generation. */
export function bumpRunnerGeneration(ledger: Ledger): string {
  const next = String(Number(ledger.getControl("runner_generation") ?? "1") + 1);
  ledger.setControl("runner_generation", next);
  return next;
}
