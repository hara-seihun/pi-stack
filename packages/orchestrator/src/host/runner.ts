import type { Ledger } from "../ledger/ledger.js";
import type { HostEvents, HostManager, HostRunResult, LaunchSpec } from "./types.js";

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
}

export interface RunnerTickReport {
  readonly claimed: readonly LaunchSpec[];
  readonly active: number;
  readonly draining: boolean;
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
    for (const run of owned) {
      if (run.abortRequested) this.engine.abort(run.id);
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
          provider: run.provider,
          model: run.model,
          thinking: run.thinking,
          accountId: run.accountId,
        };
        this.engine.launch(spec);
        claimed.push(spec);
      }
    }
    const active = owned.length + claimed.length;
    return { claimed, active, draining: this.draining };
  }

  /** True when a draining runner has nothing left and should exit. */
  drained(): boolean {
    return (
      this.draining &&
      this.ledger.runs({ state: "running", runnerId: this.cfg.runnerId }).length === 0
    );
  }

  runFinished(runId: string, result: HostRunResult, at = Date.now()): void {
    const run = this.ledger.run(runId);
    if (run === undefined) return;
    this.ledger.finishRun(runId, result, at);
    this.ledger.taskFinished(run.taskId);
  }

  heartbeat(runId: string, at = Date.now()): void {
    this.ledger.heartbeatRun(runId, at);
  }
}

/** Ordered but non-destructive: bump the generation and every live runner
 * drains; freshly started runners claim under the new generation. */
export function bumpRunnerGeneration(ledger: Ledger): string {
  const next = String(Number(ledger.getControl("runner_generation") ?? "1") + 1);
  ledger.setControl("runner_generation", next);
  return next;
}
