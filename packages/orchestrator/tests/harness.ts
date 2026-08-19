import { AccountCalibrator } from "../src/calibrator/calibrator.js";
import type {
  MeterId,
  MeterSpec,
  ResetEvent,
  UsageClassId,
  UsageSource,
} from "../src/calibrator/types.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimMeterConfig {
  spec: MeterSpec;
  windowMs: number;
  percentPerToken: Record<UsageClassId, number>;
  leakPercentPerHour?: number;
}

interface SimMeter {
  cfg: SimMeterConfig;
  used: number;
  resetAt: number;
  ppt: Map<UsageClassId, number>;
  leak: number;
}

/**
 * Simulates one provider account with hidden true rates; the calibrator only
 * ever sees floored integer percents and the usage events the scenario logs.
 */
export class SimAccount {
  readonly cal: AccountCalibrator;
  now: number;
  private readonly meters = new Map<MeterId, SimMeter>();
  private readonly jitterProb: number;
  private readonly rng: () => number;

  constructor(
    cfgs: SimMeterConfig[],
    opts: { startAt?: number; jitterProb?: number; seed?: number } = {},
  ) {
    this.now = opts.startAt ?? Date.UTC(2026, 7, 3, 8);
    this.jitterProb = opts.jitterProb ?? 0;
    this.rng = mulberry32(opts.seed ?? 0xbeef);
    this.cal = new AccountCalibrator(cfgs.map((c) => c.spec));
    for (const c of cfgs) {
      this.meters.set(c.spec.id, {
        cfg: c,
        used: 0,
        resetAt: this.now + c.windowMs,
        ppt: new Map(Object.entries(c.percentPerToken)),
        leak: c.leakPercentPerHour ?? 0,
      });
    }
    this.readAll();
  }

  advanceHours(h: number): void {
    let remaining = h * HOUR;
    while (remaining > 0) {
      const dt = Math.min(remaining, 15 * 60_000);
      this.now += dt;
      remaining -= dt;
      for (const m of this.meters.values()) {
        m.used += (m.leak * dt) / HOUR;
        if (this.now >= m.resetAt) {
          m.used = 0;
          m.resetAt += m.cfg.windowMs;
        }
      }
    }
  }

  consume(
    classId: UsageClassId,
    tokens: number,
    opts: { log?: boolean; source?: UsageSource } = {},
  ): void {
    for (const m of this.meters.values()) {
      const p = m.ppt.get(classId);
      if (p === undefined) continue;
      m.used += tokens * p;
      if (m.used > 99) throw new Error(`sim meter ${m.cfg.spec.id} above 99%: scenario bug`);
    }
    if (opts.log !== false) {
      this.cal.recordUsage({
        at: this.now,
        classId,
        tokens,
        source: opts.source ?? "orchestrator",
      });
    }
  }

  read(meterId: MeterId): ResetEvent | undefined {
    const m = this.meter(meterId);
    let p = Math.floor(Math.min(100, m.used));
    if (this.jitterProb > 0 && this.rng() < this.jitterProb) p = Math.max(0, p - 1);
    return this.cal.recordReading(meterId, { at: this.now, usedPercent: p, resetAt: m.resetAt });
  }

  readAll(): ResetEvent[] {
    const events: ResetEvent[] = [];
    for (const id of this.meters.keys()) {
      const ev = this.read(id);
      if (ev) events.push(ev);
    }
    return events;
  }

  surprise(meterId: MeterId): void {
    const m = this.meter(meterId);
    m.used = 0;
    m.resetAt = this.now + m.cfg.windowMs;
  }

  setPercentPerToken(meterId: MeterId, classId: UsageClassId, v: number): void {
    this.meter(meterId).ppt.set(classId, v);
  }

  usedPercent(meterId: MeterId): number {
    return this.meter(meterId).used;
  }

  private meter(meterId: MeterId): SimMeter {
    const m = this.meters.get(meterId);
    if (!m) throw new Error(`unknown sim meter ${meterId}`);
    return m;
  }
}

export function classStat(sim: SimAccount, meterId: MeterId, classId: UsageClassId) {
  const s = sim.cal.stats(meterId).classes.find((c) => c.classId === classId);
  if (!s) throw new Error(`no stats for ${meterId}/${classId}`);
  return s;
}

export function codexWeekly(tokensPerPercent = 1e6): SimMeterConfig {
  return {
    spec: { id: "codex-weekly", drainedBy: ["sol"], nominalWindowMs: 7 * DAY },
    windowMs: 7 * DAY,
    percentPerToken: { sol: 1 / tokensPerPercent },
  };
}
