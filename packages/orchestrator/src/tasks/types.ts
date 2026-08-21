export type Tier = "light" | "standard" | "expert";
export const TIERS: readonly Tier[] = ["light", "standard", "expert"];

/**
 * How one task wants its launches divided across tiers. Weights are relative
 * and hold over the fairness window, not inside a cycle: `light:20,standard:1`
 * asks for twenty light sessions per standard one, which is a ratio no single
 * one-slot cycle can express. A tier with no capacity simply loses its turn
 * to the others, so the same list is still the substitution set. With one
 * tier the weight says nothing and is conventionally 1.
 */
export interface TierShare {
  readonly tier: Tier;
  readonly weight: number;
}

/**
 * A task is an action plus two observable predicates: demand (is there work
 * right now?) and, eventually, completion. Demand is either a constant or a
 * cheap read-only probe command whose last stdout line is a work-unit count.
 * The gate is a small expression over other tasks' demand; tiers are the
 * weighted substitution set the governor may satisfy a launch with. Tier
 * labels are launch-side data only and must never reach agent-visible
 * surfaces.
 */
export interface TaskSpec {
  readonly id: string;
  readonly demandCommand?: string;
  readonly demandConstant?: number;
  readonly gate?: string;
  readonly tiers: readonly TierShare[];
  /** This lane's relative claim on the fleet's launches, default 1. Demand
   * says whether a lane can absorb another agent and caps how many; share
   * says how the scarce slots are divided between the lanes that can. They
   * are different questions, and letting demand answer both made the split a
   * side effect of how each probe happens to count its work — a lane
   * counting problems in sixes outranked a lane counting review items one by
   * one, for no reason an operator ever chose. */
  readonly share?: number;
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
  readonly tiers: readonly TierShare[];
  /** Relative claim on launches; absent means 1. */
  readonly share?: number;
  readonly units: number | undefined;
  readonly gateOpen: boolean;
  readonly eligible: boolean;
  readonly error: string | undefined;
  /** Launches this task has already had inside the fairness window. What
   * makes allocation proportional across cycles instead of only within one;
   * omitted by callers that do not track it. */
  readonly recentLaunches?: number;
  /** The same history split by tier, which is what makes a weighted mix
   * hold: a 20:1 ratio is invisible inside a cycle that hands out one slot.
   * Omitted by callers that do not track it. */
  readonly recentLaunchesByTier?: Readonly<Partial<Record<Tier, number>>>;
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
