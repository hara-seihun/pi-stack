import {
  dailyPercentSchedule,
  effectiveHorizonHours,
  hazardPacedPercentPerHour,
} from "./planner.js";
import { err, ok, type Result } from "./result.js";
import type {
  CalibratorConfig,
  ClassStats,
  Confidence,
  MeterId,
  MeterReading,
  MeterSpec,
  MeterStats,
  PlanError,
  PlanShift,
  ResetEvent,
  ResetStats,
  SpendPlan,
  UsageClassId,
  UsageEvent,
  UsageSource,
} from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const defaultConfig: CalibratorConfig = {
  minObservationPercent: 2,
  maxSegmentMs: 12 * HOUR,
  resetTolerancePercent: 1,
  changeSignalPercent: 10,
  changeDetectRatio: 1.6,
  windowDecay: 0.6,
  leakRidge: 50,
};

interface Segment {
  startAt: number;
  startPercent: number;
  tokens: number[];
}

interface WindowAccum {
  xtx: number[][];
  xty: number[];
  observations: number;
  totalPercent: number;
  totalHours: number;
  tokensByClass: number[];
}

interface MeterState {
  spec: MeterSpec;
  classIndex: Map<UsageClassId, number>;
  lastReading: MeterReading | undefined;
  seg: Segment | undefined;
  windowStartAt: number | undefined;
  observedStartAt: number | undefined;
  lastObservedAt: number | undefined;
  windows: WindowAccum[];
  resets: ResetEvent[];
  tokensBySource: { orchestrator: number; machine: number };
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function newAccum(cols: number, classes: number): WindowAccum {
  return {
    xtx: Array.from({ length: cols }, () => zeros(cols)),
    xty: zeros(cols),
    observations: 0,
    totalPercent: 0,
    totalHours: 0,
    tokensByClass: zeros(classes),
  };
}

function addWeighted(target: WindowAccum, source: WindowAccum, w: number): void {
  const cols = target.xty.length;
  for (let i = 0; i < cols; i++) {
    target.xty[i] += w * source.xty[i];
    for (let j = 0; j < cols; j++) target.xtx[i][j] += w * source.xtx[i][j];
  }
  target.observations += source.observations;
  target.totalPercent += w * source.totalPercent;
  target.totalHours += w * source.totalHours;
  for (let i = 0; i < target.tokensByClass.length; i++) {
    target.tokensByClass[i] += w * source.tokensByClass[i];
  }
}

/** Solve g * beta = b over columns with signal; absent columns yield undefined. */
function solveReduced(
  g: number[][],
  b: number[],
  leakCol: number,
  leakRidge: number,
): (number | undefined)[] {
  const n = b.length;
  const active: number[] = [];
  for (let i = 0; i < n; i++) if (g[i][i] > 0) active.push(i);
  const m = active.length;
  const out: (number | undefined)[] = new Array(n).fill(undefined);
  if (m === 0) return out;
  const a: number[][] = active.map((ri) => {
    const row = active.map((ci) => g[ri][ci]);
    row.push(b[ri]);
    return row;
  });
  for (let k = 0; k < m; k++) {
    const ri = active[k];
    a[k][k] += ri === leakCol ? leakRidge : g[ri][ri] * 1e-8;
  }
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < 1e-12) return out;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= m; c++) a[r][c] -= f * a[col][c];
    }
  }
  for (let k = 0; k < m; k++) out[active[k]] = a[k][m] / a[k][k];
  return out;
}

export class AccountCalibrator {
  private readonly cfg: CalibratorConfig;
  private readonly meters = new Map<MeterId, MeterState>();
  private readonly byClass = new Map<UsageClassId, MeterState[]>();

  constructor(specs: readonly MeterSpec[], cfg: Partial<CalibratorConfig> = {}) {
    this.cfg = { ...defaultConfig, ...cfg };
    for (const spec of specs) {
      const classIndex = new Map(spec.drainedBy.map((c, i) => [c, i]));
      const st: MeterState = {
        spec,
        classIndex,
        lastReading: undefined,
        seg: undefined,
        windowStartAt: undefined,
        observedStartAt: undefined,
        lastObservedAt: undefined,
        windows: [],
        resets: [],
        tokensBySource: { orchestrator: 0, machine: 0 },
      };
      this.meters.set(spec.id, st);
      for (const c of spec.drainedBy) {
        const list = this.byClass.get(c) ?? [];
        list.push(st);
        this.byClass.set(c, list);
      }
    }
  }

  recordUsage(e: UsageEvent): void {
    for (const st of this.byClass.get(e.classId) ?? []) {
      if (!st.seg) continue;
      const idx = st.classIndex.get(e.classId);
      if (idx === undefined) continue;
      st.seg.tokens[idx] += e.tokens;
      st.tokensBySource[e.source] += e.tokens;
    }
  }

  recordReading(meterId: MeterId, r: MeterReading): ResetEvent | undefined {
    const st = this.state(meterId);
    st.lastObservedAt = r.at;
    const cols = st.spec.drainedBy.length + 1;
    if (!st.lastReading) {
      st.lastReading = r;
      st.observedStartAt = r.at;
      st.windowStartAt = r.at;
      st.seg = this.freshSeg(st, r);
      st.windows.push(newAccum(cols, st.spec.drainedBy.length));
      return undefined;
    }
    const prev = st.lastReading;
    const dp = r.usedPercent - prev.usedPercent;
    const crossed = prev.resetAt !== undefined && r.at >= prev.resetAt;
    if (dp < -this.cfg.resetTolerancePercent || crossed) {
      const boundaryAt = crossed && prev.resetAt !== undefined ? prev.resetAt : r.at;
      const ev: ResetEvent = {
        meterId,
        at: r.at,
        kind: crossed ? "scheduled" : "surprise",
        windowMs: Math.max(0, boundaryAt - (st.windowStartAt ?? boundaryAt)),
        unspentPercent: Math.max(0, 100 - prev.usedPercent),
      };
      st.resets.push(ev);
      st.windows.push(newAccum(cols, st.spec.drainedBy.length));
      st.windowStartAt = boundaryAt;
      // The segment spanning the boundary is discarded: its tokens cannot be
      // attributed to either window's percent scale.
      st.seg = this.freshSeg(st, r);
      st.lastReading = r;
      return ev;
    }
    const seg = st.seg;
    if (seg) {
      const eff = r.usedPercent - seg.startPercent;
      const elapsed = r.at - seg.startAt;
      if (eff >= this.cfg.minObservationPercent || elapsed >= this.cfg.maxSegmentMs) {
        this.finalize(st, Math.max(0, eff), elapsed / HOUR, seg.tokens);
        st.seg = this.freshSeg(st, r);
      }
    }
    st.lastReading = r;
    return undefined;
  }

  stats(meterId: MeterId): MeterStats {
    const st = this.state(meterId);
    const n = st.spec.drainedBy.length;
    const leakCol = n;
    const windows = st.windows;
    const empty: MeterStats = {
      meterId,
      classes: st.spec.drainedBy.map((classId) => ({
        classId,
        tokensPerPercent: undefined,
        planTokens: undefined,
        confidence: "none",
        attributedPercent: 0,
      })),
      leakPercentPerDay: 0,
      leakConfidence: "none",
      windowsObserved: windows.length,
      totalObservedPercent: 0,
      tokensBySource: { ...st.tokensBySource },
      planShift: undefined,
    };
    if (windows.length === 0) return empty;

    const domIdx = this.dominantClass(st);
    const solveDom = (ws: WindowAccum[]): number | undefined => {
      const acc = newAccum(n + 1, n);
      for (const w of ws) addWeighted(acc, w, 1);
      const beta = solveReduced(acc.xtx, acc.xty, leakCol, this.cfg.leakRidge);
      return beta[domIdx];
    };

    let accepted: WindowAccum[] = [];
    let planShift: PlanShift | undefined;
    const hasSignal = (w: WindowAccum) => w.totalPercent >= this.cfg.changeSignalPercent;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (accepted.some(hasSignal) && hasSignal(w)) {
        const prevBeta = solveDom(accepted);
        const curBeta = solveDom([w]);
        if (prevBeta !== undefined && curBeta !== undefined && prevBeta > 0 && curBeta > 0) {
          const ratio = curBeta / prevBeta;
          if (ratio > this.cfg.changeDetectRatio || ratio < 1 / this.cfg.changeDetectRatio) {
            planShift = { windowIndex: i, tokensPerPercentRatio: prevBeta / curBeta };
            accepted = [w];
            continue;
          }
        }
      }
      accepted.push(w);
    }

    const blended = newAccum(n + 1, n);
    for (let i = 0; i < accepted.length; i++) {
      addWeighted(blended, accepted[i], Math.pow(this.cfg.windowDecay, accepted.length - 1 - i));
    }
    const beta = solveReduced(blended.xtx, blended.xty, leakCol, this.cfg.leakRidge);

    const classes: ClassStats[] = st.spec.drainedBy.map((classId, i) => {
      const b = beta[i];
      const tokens = blended.tokensByClass[i];
      if (b === undefined || b <= 1e-15 || tokens <= 0) {
        return {
          classId,
          tokensPerPercent: undefined,
          planTokens: undefined,
          confidence: "none" as Confidence,
          attributedPercent: 0,
        };
      }
      const attributed = b * tokens;
      const confidence: Confidence = attributed < 4 ? "none" : attributed < 15 ? "low" : "high";
      const tpp = 1 / b;
      return {
        classId,
        tokensPerPercent: confidence === "none" ? undefined : tpp,
        planTokens: confidence === "none" ? undefined : 100 * tpp,
        confidence,
        attributedPercent: attributed,
      };
    });

    const leakBeta = beta[leakCol] ?? 0;
    const leakConfidence: Confidence =
      blended.totalHours >= 120 ? "high" : blended.totalHours >= 48 ? "low" : "none";
    return {
      meterId,
      classes,
      leakPercentPerDay: leakBeta * 24,
      leakConfidence,
      windowsObserved: windows.length,
      totalObservedPercent: windows.reduce((s, w) => s + w.totalPercent, 0),
      tokensBySource: { ...st.tokensBySource },
      planShift,
    };
  }

  resetStats(meterId: MeterId): ResetStats {
    const st = this.state(meterId);
    const scheduled = st.resets.filter((r) => r.kind === "scheduled");
    const surprise = st.resets.filter((r) => r.kind === "surprise");
    const observedMs =
      st.observedStartAt !== undefined && st.lastObservedAt !== undefined
        ? st.lastObservedAt - st.observedStartAt
        : 0;
    const completed = st.resets.filter((r) => r.windowMs > 0);
    return {
      meterId,
      windowsCompleted: st.resets.length,
      scheduledResets: scheduled.length,
      surpriseResets: surprise.length,
      surpriseHazardPerDay: observedMs > 0 ? surprise.length / (observedMs / DAY) : 0,
      meanWindowDays:
        completed.length > 0
          ? completed.reduce((s, r) => s + r.windowMs, 0) / completed.length / DAY
          : undefined,
      wastedSurprisePercentTotal: surprise.reduce((s, r) => s + r.unspentPercent, 0),
      unspentScheduledPercentTotal: scheduled.reduce((s, r) => s + r.unspentPercent, 0),
    };
  }

  plan(meterId: MeterId, now: number): Result<SpendPlan, PlanError> {
    const st = this.meters.get(meterId);
    if (!st) return err({ reason: "unknown-meter" });
    const r = st.lastReading;
    if (!r) return err({ reason: "no-reading" });
    if (r.resetAt === undefined) return err({ reason: "no-reset-schedule" });
    const stats = this.stats(meterId);
    const usable = stats.classes.filter(
      (c) => c.confidence !== "none" && c.tokensPerPercent !== undefined,
    );
    if (usable.length === 0) return err({ reason: "insufficient-calibration" });
    const rs = this.resetStats(meterId);
    const remaining = Math.min(100, Math.max(0, 100 - r.usedPercent));
    const horizonHours = Math.max((r.resetAt - now) / HOUR, 1 / 60);
    const hazardPerDay = rs.surpriseHazardPerDay;
    const teff = effectiveHorizonHours(horizonHours, hazardPerDay / 24);
    const percentPerHour = hazardPacedPercentPerHour(remaining, horizonHours, hazardPerDay);
    const tokensPerHourByClass: Record<UsageClassId, number> = {};
    for (const c of usable) {
      tokensPerHourByClass[c.classId] = percentPerHour * (c.tokensPerPercent ?? 0);
    }
    return ok({
      meterId,
      remainingPercent: remaining,
      horizonHours,
      effectiveHorizonHours: teff,
      surpriseHazardPerDay: hazardPerDay,
      pSurpriseBeforeScheduledReset: 1 - Math.exp(-(hazardPerDay / 24) * horizonHours),
      percentPerHour,
      naivePercentPerHour: remaining / horizonHours,
      tokensPerHourByClass,
      dailyPercentSchedule: dailyPercentSchedule(remaining, horizonHours, hazardPerDay),
    });
  }

  private state(meterId: MeterId): MeterState {
    const st = this.meters.get(meterId);
    if (!st) throw new Error(`unknown meter: ${meterId}`);
    return st;
  }

  private freshSeg(st: MeterState, r: MeterReading): Segment {
    return { startAt: r.at, startPercent: r.usedPercent, tokens: zeros(st.spec.drainedBy.length) };
  }

  private finalize(st: MeterState, y: number, hours: number, tokens: number[]): void {
    const w = st.windows[st.windows.length - 1];
    if (!w) return;
    const x = [...tokens, hours];
    for (let i = 0; i < x.length; i++) {
      w.xty[i] += x[i] * y;
      for (let j = 0; j < x.length; j++) w.xtx[i][j] += x[i] * x[j];
    }
    w.observations += 1;
    w.totalPercent += y;
    w.totalHours += hours;
    for (let i = 0; i < tokens.length; i++) w.tokensByClass[i] += tokens[i];
  }

  private dominantClass(st: MeterState): number {
    let best = 0;
    let bestTokens = -1;
    for (let i = 0; i < st.spec.drainedBy.length; i++) {
      const total = st.windows.reduce((s, w) => s + w.tokensByClass[i], 0);
      if (total > bestTokens) {
        bestTokens = total;
        best = i;
      }
    }
    return best;
  }
}
