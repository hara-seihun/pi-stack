export type Tier = "light" | "standard" | "expert";
export const TIERS: readonly Tier[] = ["light", "standard", "expert"];

/**
 * The shape of one lane's bundle: how many sessions of each tier it wants
 * running at once. `light:20,standard:1` asks for twenty light sessions per
 * standard one, and the lane's share scales that whole bundle, so weight and
 * share multiply into the lane's claim on each tier. A tier with no capacity
 * costs the lane only that tier's sessions — it is not substituted into
 * another tier, and it does not hold the rest of the bundle up. With one
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
  /** Scales this lane's whole tier bundle, default 1: `share × tier weight`
   * is the lane's claim on each tier, so two lanes asking for standard
   * sessions at share 10 and 5 hold them 2:1. Demand
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
  /** End the shift as soon as this lane's demand reaches zero, instead of
   * re-prompting the session until its budget is spent. A research lane is
   * never done and keeps its warm context; a queue lane (review) can empty
   * its queue mid-shift, and re-prompting it then asserts work that no
   * longer exists. Unknown demand — an unprobed, stale, or failed probe —
   * never ends a shift, because "I cannot see the queue" is not "the queue
   * is empty". */
  readonly exitWhenDrained?: boolean;
  /** URL of a doctrine document the host pins into every session's system
   * prompt for this lane. The task prompt is the first user message and is
   * the first thing compaction summarizes away; doctrine that must hold for
   * a whole shift — the ledger's attack guide, whose anti-ladder rules are
   * binding — survives only in the system prompt. Fetched at launch so
   * sessions carry the current text. */
  readonly doctrineUrl?: string;
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
  /** Lane-scoped launch control: this lane is held even though the machine
   * is launching. Omitted by callers that do not track it. */
  readonly paused?: boolean;
  readonly error: string | undefined;
  /** Sessions this lane already holds, pending or running, split by tier.
   * The allocator targets the fleet's composition, so what a lane is already
   * running is what it is measured against; omitted by callers that do not
   * track it, which then allocate from empty. */
  readonly heldByTier?: Readonly<Partial<Record<Tier, number>>>;
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
