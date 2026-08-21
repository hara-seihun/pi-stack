import type { Ledger } from "../ledger/ledger.js";

/**
 * Generation draining needs two runner processes alive at once: the old one
 * finishing its sessions and a fresh one claiming under the new generation.
 * A single service unit cannot provide that — its drained main process only
 * exits (and only then restarts) once its longest session ends, so every run
 * created in between expires unclaimed and the fleet silently stops working.
 *
 * The supervisor is that missing second process slot. It is the unit's main
 * process, hosts nothing itself, and spawns runner workers as children:
 * exactly one worker for the current generation, spawned from the deployed
 * CLI path so a worker always starts on the newest build. A generation bump
 * spawns the successor immediately; older workers drain and exit on their
 * own schedule, killed by nobody.
 *
 * The supervisor therefore never needs restarting for an ordinary code
 * update. Updating the supervisor itself still means draining every worker
 * first, which is why it holds no policy: claiming, capacity, and session
 * lifecycle all stay in `Runner` and `PiHost`.
 */

export interface SupervisorConfig {
  /** Base runner id; each worker gets a unique id derived from it. */
  readonly runnerId: string;
  /** Concurrent embedded sessions each worker will host. */
  readonly maxSessions: number;
  /** Wait before respawning a worker that died under the live generation,
   * so a worker that crashes on startup cannot hot-loop. */
  readonly respawnBackoffMs?: number;
}

export interface WorkerSpec {
  readonly workerId: string;
  readonly generation: string;
  readonly maxSessions: number;
}

export interface SupervisorTickReport {
  readonly generation: string;
  /** The worker spawned this tick, if any. */
  readonly spawned?: WorkerSpec;
  /** The worker currently expected to be claiming, if any. */
  readonly claiming?: string;
}

const DEFAULT_RESPAWN_BACKOFF_MS = 5_000;

export class RunnerSupervisor {
  private current?: WorkerSpec;
  private sequence = 0;
  private respawnAt = 0;

  constructor(
    private readonly ledger: Ledger,
    private readonly spawn: (spec: WorkerSpec) => void,
    private readonly cfg: SupervisorConfig,
  ) {}

  tick(now = Date.now()): SupervisorTickReport {
    const generation = this.ledger.getControl("runner_generation") ?? "1";
    if (this.current?.generation === generation) {
      return { generation, claiming: this.current.workerId };
    }
    // A worker of the live generation died; back off before replacing it.
    if (this.current === undefined && now < this.respawnAt) return { generation };
    const spec: WorkerSpec = {
      workerId: `${this.cfg.runnerId}-g${generation}.${++this.sequence}`,
      generation,
      maxSessions: this.cfg.maxSessions,
    };
    this.spawn(spec);
    this.current = spec;
    return { generation, spawned: spec, claiming: spec.workerId };
  }

  /**
   * A worker process ended. A drained worker of a superseded generation is
   * the normal, wanted case and needs no action; only the loss of the worker
   * that should be claiming asks for a replacement.
   */
  workerExited(workerId: string, now = Date.now()): void {
    const worker = this.current;
    if (worker?.workerId !== workerId) return;
    this.current = undefined;
    // Exiting because it was superseded between ticks is not a failure:
    // replace it at once instead of leaving the fleet unclaimed for a backoff.
    if (worker.generation === (this.ledger.getControl("runner_generation") ?? "1")) {
      this.respawnAt = now + (this.cfg.respawnBackoffMs ?? DEFAULT_RESPAWN_BACKOFF_MS);
    }
  }
}
