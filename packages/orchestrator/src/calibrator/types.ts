export type UsageClassId = string;
export type MeterId = string;
export type UsageSource = "orchestrator" | "machine";

/**
 * A meter is one provider-reported limit window (e.g. anthropic weekly,
 * codex 5h). Coupled limits are modelled as multiple meters drained by
 * overlapping usage classes.
 */
export interface MeterSpec {
  readonly id: MeterId;
  readonly drainedBy: readonly UsageClassId[];
  readonly nominalWindowMs: number;
}

/** Provider-reported state. usedPercent is the integer the provider shows. */
export interface MeterReading {
  readonly at: number;
  readonly usedPercent: number;
  readonly resetAt?: number;
}

export interface UsageEvent {
  readonly at: number;
  readonly classId: UsageClassId;
  readonly tokens: number;
  readonly source: UsageSource;
}

export type Confidence = "none" | "low" | "high";

export interface ClassStats {
  readonly classId: UsageClassId;
  /**
   * The fitted coefficient itself: percent of the meter one token of this
   * class drains. `tokensPerPercent` is its reciprocal and goes undefined
   * once the class is too cheap to price confidently — which is exactly the
   * case a launcher most needs an answer for, because a model that barely
   * touches the meter is one it can run many of. Zero is a real answer here
   * ("this class was observed and drained nothing"); undefined means the
   * class had no tokens in the window, so nothing was observed at all.
   */
  readonly percentPerToken: number | undefined;
  readonly tokensPerPercent: number | undefined;
  readonly planTokens: number | undefined;
  readonly confidence: Confidence;
  readonly attributedPercent: number;
}

export interface PlanShift {
  readonly windowIndex: number;
  readonly tokensPerPercentRatio: number;
}

/**
 * Percent drained across idle gaps (no recorded usage for idleSplitMs).
 * On a fully instrumented machine this is a direct, model-free alarm:
 * `percent` should stay near zero, and a sustained excess means usage is
 * escaping instrumentation (or the account is used off-machine).
 */
export interface IdleDrain {
  readonly percent: number;
  readonly hours: number;
  readonly tokens: number;
  readonly observations: number;
}

export interface MeterStats {
  readonly meterId: MeterId;
  readonly classes: readonly ClassStats[];
  readonly leakPercentPerDay: number;
  readonly leakConfidence: Confidence;
  readonly idleDrain: IdleDrain;
  readonly windowsObserved: number;
  readonly totalObservedPercent: number;
  readonly tokensBySource: Readonly<Record<UsageSource, number>>;
  readonly planShift: PlanShift | undefined;
}

export interface ResetEvent {
  readonly meterId: MeterId;
  readonly at: number;
  readonly kind: "scheduled" | "surprise";
  readonly windowMs: number;
  readonly unspentPercent: number;
}

export interface ResetStats {
  readonly meterId: MeterId;
  readonly windowsCompleted: number;
  readonly scheduledResets: number;
  readonly surpriseResets: number;
  readonly surpriseHazardPerDay: number;
  readonly meanWindowDays: number | undefined;
  readonly wastedSurprisePercentTotal: number;
  readonly unspentScheduledPercentTotal: number;
}

export interface SpendPlan {
  readonly meterId: MeterId;
  readonly remainingPercent: number;
  readonly horizonHours: number;
  readonly effectiveHorizonHours: number;
  readonly surpriseHazardPerDay: number;
  readonly pSurpriseBeforeScheduledReset: number;
  readonly percentPerHour: number;
  readonly naivePercentPerHour: number;
  /** Only the classes whose tokens-per-percent is calibrated. Empty means
   * the rate is known but nothing can price it in tokens yet. */
  readonly tokensPerHourByClass: Readonly<Record<UsageClassId, number>>;
  readonly dailyPercentSchedule: readonly number[];
}

export type PlanError = {
  readonly reason: "unknown-meter" | "no-reading" | "no-reset-schedule" | "stale-reading";
};

export interface CalibratorConfig {
  /** Minimum accumulated integer-percent delta before a segment becomes an observation. */
  readonly minObservationPercent: number;
  /** Segments older than this close regardless of delta (anchors zero/slow drain). */
  readonly maxSegmentMs: number;
  /** A reading arriving after this long without recorded usage closes the
   * pending segment at the idle boundary, isolating the gap as its own
   * observation and feeding the idle-drain alarm. */
  readonly idleSplitMs: number;
  /** Percent drop deeper than this, absent a crossed resetAt, is a surprise reset. */
  readonly resetTolerancePercent: number;
  /** Per-window signal required before a window participates in plan-change detection. */
  readonly changeSignalPercent: number;
  /** tokens-per-percent ratio between windows that declares a plan-size change. */
  readonly changeDetectRatio: number;
  /** Recency weight applied per window step back when blending calibration windows. */
  readonly windowDecay: number;
  /** Ridge weight pulling the unattributed-leak coefficient toward zero. */
  readonly leakRidge: number;
}
