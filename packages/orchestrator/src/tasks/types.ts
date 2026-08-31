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
export interface TeamSpec {
  /** Colleagues working concurrently in the lane's shared cwd. */
  readonly workers: number;
  /** The supervisor's task prompt. Workers receive TaskSpec.prompt. */
  readonly supervisorPrompt: string;
}

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
  /** URL of a doctrine document the host pins into every session's system
   * prompt for this lane. The task prompt is the first user message and is
   * the first thing compaction summarizes away; doctrine that must hold for
   * a whole shift — the ledger's attack guide, whose anti-ladder rules are
   * binding — survives only in the system prompt. Fetched at launch so
   * sessions carry the current text. */
  readonly doctrineUrl?: string;
  /** Opening exchange: user messages the host sends as real turns, in
   * order, before the task prompt. The agent lives the exchange — answers
   * each message, runs whatever tools it reaches for — and the host then
   * pins the whole thing verbatim through every compaction. Agents are
   * acutely good at telling self from not-self: a summarized or paraphrased
   * opening reads as someone else's words and loses its force, so the pin
   * is word for word, tool traffic included. */
  readonly opening?: readonly string[];
  /** Command run at each launch whose stdout is a JSON object; every
   * `{{key}}` placeholder in the opening messages is replaced by the
   * object's value for that key. This is what lets an opening exchange vary
   * per session — the math lane samples a different famous open problem for
   * each launch so a batch of agents does not crowd one anchor. The probe
   * runs fresh every launch (a cache would hand a whole batch the same
   * draw), and a probe failure or an unresolved placeholder fails the
   * launch loudly rather than sending a template. */
  readonly openingProbe?: string;
  /** Run this lane as one durable team: N workers plus one supervisor. Demand
   * is boolean for a team lane. Any positive reading asks for the complete
   * roster, and missing roles are replaced without disturbing their peers. */
  readonly team?: TeamSpec;
  /** Launch on operator authority instead of paced capacity. While the lane
   * is eligible with unmet demand, every tick admits its sessions before the
   * paced allocation and past plan-rate budgets, bootstrap caps, and duty
   * cycles — the spawn command's "forced past pacing" path made durable.
   * Stops are not pacing and still stop it: lane and machine pause, gate,
   * demand, the error circuit breaker, credential custody, family halts
   * (boost 0), access expiry, cooldowns, and the machine's concurrent-session
   * ceiling all hold. The runs it creates are ledger facts, so paced lanes
   * price the forced sessions into their own admission the same tick. */
  readonly ignoreCapacity?: boolean;
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
  /** A session declared this lane's work finished (`pi-orchestrator
   * complete`). Demand reads zero and a team lane's roster is asked to
   * stop. */
  readonly completed?: boolean;
  readonly error: string | undefined;
  /** Sessions this lane already holds, pending or running, split by tier.
   * The allocator targets the fleet's composition, so what a lane is already
   * running is what it is measured against; omitted by callers that do not
   * track it, which then allocate from empty. */
  readonly heldByTier?: Readonly<Partial<Record<Tier, number>>>;
  /** Mirrors TaskSpec.ignoreCapacity so launch surfaces can say which lanes
   * run past pacing. */
  readonly ignoreCapacity?: boolean;
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
