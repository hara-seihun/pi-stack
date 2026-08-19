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
  readonly tokensPerPercent: number | undefined;
  readonly planTokens: number | undefined;
  readonly confidence: Confidence;
  readonly attributedPercent: number;
}

export interface PlanShift {
  readonly windowIndex: number;
  readonly tokensPerPercentRatio: number;
}

export interface MeterStats {
  readonly meterId: MeterId;
  readonly classes: readonly ClassStats[];
  readonly leakPercentPerDay: number;
  readonly leakConfidence: Confidence;
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
  readonly tokensPerHourByClass: Readonly<Record<UsageClassId, number>>;
  readonly dailyPercentSchedule: readonly number[];
}

export type PlanError = {
  readonly reason:
    | "unknown-meter"
    | "no-reading"
    | "no-reset-schedule"
    | "insufficient-calibration";
};

export interface CalibratorConfig {
  /** Minimum accumulated integer-percent delta before a segment becomes an observation. */
  readonly minObservationPercent: number;
  /** Segments older than this close regardless of delta (anchors zero/slow drain). */
  readonly maxSegmentMs: number;
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
