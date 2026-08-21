export type Tier = "light" | "standard" | "expert";
export const TIERS: readonly Tier[] = ["light", "standard", "expert"];

/**
 * A task is an action plus two observable predicates: demand (is there work
 * right now?) and, eventually, completion. Demand is either a constant or a
 * cheap read-only probe command whose last stdout line is a work-unit count.
 * The gate is a small expression over other tasks' demand; tiers are the
 * preference-ordered substitution set the governor may satisfy a launch with.
 * Tier labels are launch-side data only and must never reach agent-visible
 * surfaces.
 */
export interface TaskSpec {
  readonly id: string;
  readonly demandCommand?: string;
  readonly demandConstant?: number;
  readonly gate?: string;
  readonly tiers: readonly Tier[];
  /** The agent's task prompt. A task without one is a pure demand signal
   * (referenced by gates) and is never launched. */
  readonly prompt?: string;
  /** Working directory for launched sessions. */
  readonly cwd?: string;
}

export interface DemandState {
  readonly units: number | undefined;
  readonly probedAt: number | undefined;
  readonly invalidated: boolean;
  readonly error: string | undefined;
  readonly gateOpenSince: number | undefined;
}

export interface TaskSnapshot {
  readonly taskId: string;
  readonly tiers: readonly Tier[];
  readonly units: number | undefined;
  readonly gateOpen: boolean;
  readonly eligible: boolean;
  readonly error: string | undefined;
  /** Launches this task has already had inside the fairness window. What
   * makes allocation proportional across cycles instead of only within one;
   * omitted by callers that do not track it. */
  readonly recentLaunches?: number;
}

export interface EvaluateResult {
  readonly launches: "enabled" | "paused";
  readonly tasks: readonly TaskSnapshot[];
}

export interface SchedulerConfig {
  /** How long a successful or failed probe result stays fresh. */
  readonly demandTtlMs: number;
  /** A gate must be continuously open this long before the task is eligible. */
  readonly gateDebounceMs: number;
  /** Kill a probe command after this long. */
  readonly probeTimeoutMs: number;
}

export type ProbeRunner = (command: string) => Promise<number>;

export interface Assignment {
  readonly taskId: string;
  readonly tier: Tier;
  readonly count: number;
}

export interface AllocationResult {
  readonly assignments: readonly Assignment[];
  readonly unusedSlots: Readonly<Record<Tier, number>>;
}
