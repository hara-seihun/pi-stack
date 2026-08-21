import { describe, expect, it } from "vitest";
import { hazardPacedPercentPerHour } from "../src/calibrator/planner.js";
import type { ResetEvent, UsageClassId } from "../src/calibrator/types.js";
import { classStat, codexWeekly, DAY, mulberry32, SimAccount, type SimMeterConfig } from "./harness.js";

interface SteadyOpts {
  days: number;
  classId?: UsageClassId;
  probPerHour: number;
  meanTokens: number;
  readEveryHours?: number;
  machineShare?: number;
  logProb?: number;
  rng: () => number;
}

function steady(sim: SimAccount, o: SteadyOpts): ResetEvent[] {
  const events: ResetEvent[] = [];
  const hours = Math.round(o.days * 24);
  for (let h = 0; h < hours; h++) {
    if (o.rng() < o.probPerHour) {
      const tokens = o.meanTokens * (0.5 + o.rng());
      const source =
        o.machineShare !== undefined && o.rng() < o.machineShare ? "machine" : "orchestrator";
      const log = o.logProb === undefined ? true : o.rng() < o.logProb;
      sim.consume(o.classId ?? "sol", tokens, { log, source });
    }
    sim.advanceHours(1);
    if (h % (o.readEveryHours ?? 1) === 0) events.push(...sim.readAll());
  }
  return events;
}

function anthropicMeters(): SimMeterConfig[] {
  return [
    {
      spec: { id: "anthropic-weekly", drainedBy: ["opus", "fable"], nominalWindowMs: 7 * DAY },
      windowMs: 7 * DAY,
      percentPerToken: { opus: 2e-6, fable: 4.2e-6 },
    },
    {
      spec: { id: "anthropic-fable-weekly", drainedBy: ["fable"], nominalWindowMs: 7 * DAY },
      windowMs: 7 * DAY,
      percentPerToken: { fable: 8.4e-6 },
    },
  ];
}

describe("core calibrator scenarios", () => {
  it("S1 steady orchestrator-only usage calibrates tokens-per-percent within 10%", () => {
    const rng = mulberry32(11);
    const sim = new SimAccount([codexWeekly(1e6)]);
    steady(sim, { days: 14, probPerHour: 0.35, meanTokens: 1.05e6, rng });
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.confidence).toBe("high");
    expect(s.tokensPerPercent).toBeGreaterThan(0.9e6);
    expect(s.tokensPerPercent).toBeLessThan(1.1e6);
    expect(s.planTokens).toBeCloseTo(100 * (s.tokensPerPercent ?? 0), 5);
  });

  it("S2 integer percent reporting blocks short-timescale calibration, long horizon recovers", () => {
    const rng = mulberry32(22);
    const sim = new SimAccount([codexWeekly(1e6)]);
    const tinyBurstPhase = (hours: number) => {
      for (let step = 0; step < hours * 6; step++) {
        if (rng() < 0.6) sim.consume("sol", 2e4);
        sim.advanceHours(1 / 6);
        sim.readAll();
      }
    };
    tinyBurstPhase(6);
    expect(classStat(sim, "codex-weekly", "sol").confidence).toBe("none");
    // The rate is still known this early — it is remaining percent over the
    // hazard-discounted horizon, which the provider's own reading supplies.
    // What is missing is the token price of that rate, and the plan says so
    // by pricing no class at all rather than by refusing to exist.
    const early = sim.cal.plan("codex-weekly", sim.now);
    expect(early.ok).toBe(true);
    if (early.ok) {
      expect(early.value.percentPerHour).toBeGreaterThan(0);
      expect(early.value.tokensPerHourByClass).toEqual({});
    }
    tinyBurstPhase(6 * 24);
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.confidence).not.toBe("none");
    expect(s.tokensPerPercent).toBeGreaterThan(0.5e6);
    expect(s.tokensPerPercent).toBeLessThan(2e6);
  });

  it("S3 disentangles opus and fable coefficients on the shared anthropic weekly meter", () => {
    const rng = mulberry32(33);
    const sim = new SimAccount(anthropicMeters());
    for (let h = 0; h < 12 * 24; h++) {
      const hourOfDay = h % 24;
      if (hourOfDay >= 8 && hourOfDay < 14 && rng() < 0.5) {
        sim.consume("opus", 6e5 * (0.5 + rng()));
      }
      if (hourOfDay >= 14 && hourOfDay < 20 && rng() < 0.5) {
        sim.consume("fable", 3e5 * (0.5 + rng()));
      }
      sim.advanceHours(1);
      sim.readAll();
    }
    const opus = classStat(sim, "anthropic-weekly", "opus");
    const fable = classStat(sim, "anthropic-weekly", "fable");
    expect(opus.tokensPerPercent).toBeGreaterThan(420e3);
    expect(opus.tokensPerPercent).toBeLessThan(580e3);
    expect(fable.tokensPerPercent).toBeGreaterThan(200e3);
    expect(fable.tokensPerPercent).toBeLessThan(276e3);
    const measuredCostRatio = (opus.tokensPerPercent ?? 0) / (fable.tokensPerPercent ?? 1);
    expect(measuredCostRatio).toBeGreaterThan(1.75);
    expect(measuredCostRatio).toBeLessThan(2.5);
  });

  it("S4 measures the fable budget as half the weekly budget from drain rates", () => {
    const rng = mulberry32(44);
    const sim = new SimAccount(anthropicMeters());
    steady(sim, { days: 6, classId: "fable", probPerHour: 0.3, meanTokens: 2e5, rng });
    const weeklyFable = classStat(sim, "anthropic-weekly", "fable");
    const fableMeter = classStat(sim, "anthropic-fable-weekly", "fable");
    const budgetRatio = (fableMeter.planTokens ?? 0) / (weeklyFable.planTokens ?? 1);
    expect(budgetRatio).toBeGreaterThan(0.44);
    expect(budgetRatio).toBeLessThan(0.57);
  });

  it("S5 merges orchestrator and machine-logged pi usage into one calibration", () => {
    const rng = mulberry32(55);
    const sim = new SimAccount([codexWeekly(1e6)]);
    steady(sim, { days: 10, probPerHour: 0.3, meanTokens: 1.05e6, machineShare: 0.4, rng });
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.tokensPerPercent).toBeGreaterThan(0.88e6);
    expect(s.tokensPerPercent).toBeLessThan(1.13e6);
    const src = sim.cal.stats("codex-weekly").tokensBySource;
    const machineFraction = src.machine / (src.machine + src.orchestrator);
    expect(machineFraction).toBeGreaterThan(0.3);
    expect(machineFraction).toBeLessThan(0.5);
  });

  it("S6 estimates unlogged off-machine drain as a leak without corrupting token rates", () => {
    const rng = mulberry32(66);
    const cfg = codexWeekly(1e6);
    cfg.leakPercentPerHour = 0.25;
    const sim = new SimAccount([cfg]);
    steady(sim, { days: 6, probPerHour: 0.25, meanTokens: 8e5, rng });
    const stats = sim.cal.stats("codex-weekly");
    expect(stats.leakPercentPerDay).toBeGreaterThan(3.5);
    expect(stats.leakPercentPerDay).toBeLessThan(8.5);
    expect(stats.leakConfidence).not.toBe("none");
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.tokensPerPercent).toBeGreaterThan(0.75e6);
    expect(s.tokensPerPercent).toBeLessThan(1.35e6);
  });

  it("S7 recognises scheduled weekly rollovers and keeps hazard at zero", () => {
    const rng = mulberry32(77);
    const sim = new SimAccount([codexWeekly(1e6)]);
    steady(sim, { days: 16, probPerHour: 0.35, meanTokens: 1.05e6, rng });
    const rs = sim.cal.resetStats("codex-weekly");
    expect(rs.scheduledResets).toBeGreaterThanOrEqual(2);
    expect(rs.surpriseResets).toBe(0);
    expect(rs.surpriseHazardPerDay).toBe(0);
    expect(rs.meanWindowDays).toBeGreaterThan(6.5);
    expect(rs.meanWindowDays).toBeLessThan(7.5);
  });

  it("S8 classifies a mid-window OpenAI-style reset as surprise and records the wasted budget", () => {
    const rng = mulberry32(88);
    const sim = new SimAccount([codexWeekly(1e6)]);
    steady(sim, { days: 3, probPerHour: 0.5, meanTokens: 1.7e6, rng });
    sim.surprise("codex-weekly");
    sim.advanceHours(1);
    const events = sim.readAll();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("surprise");
    expect(events[0].unspentPercent).toBeGreaterThan(30);
    expect(events[0].unspentPercent).toBeLessThan(50);
    steady(sim, { days: 2, probPerHour: 0.3, meanTokens: 1e6, rng });
    const rs = sim.cal.resetStats("codex-weekly");
    expect(rs.surpriseResets).toBe(1);
    expect(rs.wastedSurprisePercentTotal).toBeGreaterThan(30);
    expect(rs.surpriseHazardPerDay).toBeGreaterThan(0.1);
    expect(rs.surpriseHazardPerDay).toBeLessThan(0.35);
  });

  it("S9 front-loads the spend plan in proportion to the measured surprise hazard", () => {
    const rng = mulberry32(99);
    const sim = new SimAccount([codexWeekly(1e6)]);
    for (let cycle = 0; cycle < 3; cycle++) {
      steady(sim, { days: 7.05, probPerHour: 0.3, meanTokens: 1.25e6, rng });
      steady(sim, { days: 3, probPerHour: 0.3, meanTokens: 1.25e6, rng });
      sim.surprise("codex-weekly");
      sim.advanceHours(1);
      sim.readAll();
    }
    steady(sim, { days: 1, probPerHour: 0.3, meanTokens: 1.25e6, rng });
    const plan = sim.cal.plan("codex-weekly", sim.now);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const p = plan.value;
    expect(p.surpriseHazardPerDay).toBeGreaterThan(0.05);
    expect(p.percentPerHour).toBeGreaterThan(p.naivePercentPerHour * 1.15);
    expect(p.pSurpriseBeforeScheduledReset).toBeGreaterThan(0.3);
    expect(p.pSurpriseBeforeScheduledReset).toBeLessThan(0.65);
    const sched = p.dailyPercentSchedule;
    expect(sched.length).toBeGreaterThanOrEqual(5);
    expect(sched[0]).toBeGreaterThan(sched[sched.length - 1] * 1.15);
    const total = sched.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - p.remainingPercent)).toBeLessThan(1.5);
    const solRate = p.tokensPerHourByClass["sol"];
    expect(solRate).toBeGreaterThan(p.percentPerHour * 0.8e6);
    expect(solRate).toBeLessThan(p.percentPerHour * 1.25e6);
  });

  it("S9b Monte Carlo: hazard pacing cuts waste vs naive while never starving the late window", () => {
    const rng = mulberry32(4242);
    const horizon = 168;
    const hazardPerDay = 1 / 14;
    const hazardPerHour = hazardPerDay / 24;
    const bingeRate = 100 / 48;
    let wasteNaive = 0;
    let wasteHazard = 0;
    let wasteBinge = 0;
    const trials = 500;
    for (let t = 0; t < trials; t++) {
      const surpriseAt = -Math.log(1 - rng()) / hazardPerHour;
      if (surpriseAt < horizon) {
        wasteNaive += 100 - surpriseAt * (100 / horizon);
        wasteBinge += Math.max(0, 100 - surpriseAt * bingeRate);
      }
      let rem = 100;
      for (let h = 0; h < horizon; h++) {
        if (h >= surpriseAt) {
          wasteHazard += rem;
          break;
        }
        rem -= Math.min(rem, hazardPacedPercentPerHour(rem, horizon - h, hazardPerDay));
      }
    }
    expect(wasteHazard).toBeLessThan(wasteNaive * 0.95);
    expect(wasteBinge).toBeLessThan(wasteHazard);

    // Coverage in a surprise-free window: binge exhausts days early, hazard never does.
    let rem = 100;
    let hazardStarvedHours = 0;
    for (let h = 0; h < horizon; h++) {
      if (rem <= 0.01) hazardStarvedHours++;
      rem -= Math.min(rem, hazardPacedPercentPerHour(rem, horizon - h, hazardPerDay));
    }
    const bingeStarvedHours = horizon - 100 / bingeRate;
    expect(hazardStarvedHours).toBe(0);
    expect(rem).toBeLessThan(0.1);
    expect(bingeStarvedHours).toBeGreaterThan(100);
  });

  it("S10 discards the segment spanning a surprise reset instead of misattributing in-flight burn", () => {
    const rng = mulberry32(1010);
    const sim = new SimAccount([codexWeekly(1e6)]);
    steady(sim, { days: 5, probPerHour: 0.3, meanTokens: 1.4e6, rng });
    sim.consume("sol", 8e6);
    sim.surprise("codex-weekly");
    sim.advanceHours(1);
    const events = sim.readAll();
    expect(events[0]?.kind).toBe("surprise");
    steady(sim, { days: 4, probPerHour: 0.3, meanTokens: 1.4e6, rng });
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.tokensPerPercent).toBeGreaterThan(0.85e6);
    expect(s.tokensPerPercent).toBeLessThan(1.18e6);
    expect(sim.cal.resetStats("codex-weekly").surpriseResets).toBe(1);
  });

  it("S11 calibrates a fast 5h meter through many rollovers without disturbing the weekly meter", () => {
    const rng = mulberry32(1111);
    const meters: SimMeterConfig[] = [
      {
        spec: { id: "codex-5h", drainedBy: ["sol"], nominalWindowMs: 5 * 3_600_000 },
        windowMs: 5 * 3_600_000,
        percentPerToken: { sol: 2e-5 },
      },
      codexWeekly(1e6),
    ];
    const sim = new SimAccount(meters);
    steady(sim, { days: 4, probPerHour: 0.4, meanTokens: 6e5, rng });
    const fiveHour = sim.cal.resetStats("codex-5h");
    expect(fiveHour.windowsCompleted).toBeGreaterThanOrEqual(12);
    expect(fiveHour.surpriseResets).toBe(0);
    const weeklyResets = sim.cal.resetStats("codex-weekly");
    expect(weeklyResets.windowsCompleted).toBe(0);
    const weekly = classStat(sim, "codex-weekly", "sol");
    expect(weekly.tokensPerPercent).toBeGreaterThan(0.8e6);
    expect(weekly.tokensPerPercent).toBeLessThan(1.25e6);
    const fast = classStat(sim, "codex-5h", "sol");
    expect(fast.tokensPerPercent).toBeGreaterThan(40e3);
    expect(fast.tokensPerPercent).toBeLessThan(62.5e3);
  });

  it("S12 tolerates provider percent jitter without inventing resets", () => {
    const rng = mulberry32(1212);
    const sim = new SimAccount([codexWeekly(1e6)], { jitterProb: 0.2, seed: 777 });
    steady(sim, { days: 10, probPerHour: 0.3, meanTokens: 1.2e6, rng });
    const rs = sim.cal.resetStats("codex-weekly");
    expect(rs.surpriseResets).toBe(0);
    expect(rs.scheduledResets).toBe(1);
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.tokensPerPercent).toBeGreaterThan(0.8e6);
    expect(s.tokensPerPercent).toBeLessThan(1.25e6);
  });

  it("S13 keeps per-account calibrations independent and exposes plan-size differences", () => {
    const rng = mulberry32(1313);
    const plus = new SimAccount([
      {
        spec: { id: "codex-weekly", drainedBy: ["sol"], nominalWindowMs: 7 * DAY },
        windowMs: 7 * DAY,
        percentPerToken: { sol: 5e-6 },
      },
    ]);
    const pro = new SimAccount([
      {
        spec: { id: "codex-weekly", drainedBy: ["sol"], nominalWindowMs: 7 * DAY },
        windowMs: 7 * DAY,
        percentPerToken: { sol: 2.5e-7 },
      },
    ]);
    steady(plus, { days: 6, probPerHour: 0.3, meanTokens: 3e5, rng });
    steady(pro, { days: 6, probPerHour: 0.3, meanTokens: 2.5e6, rng });
    const plusStat = classStat(plus, "codex-weekly", "sol");
    const proStat = classStat(pro, "codex-weekly", "sol");
    expect(proStat.confidence).not.toBe("none");
    const ratio = (proStat.planTokens ?? 0) / (plusStat.planTokens ?? 1);
    expect(ratio).toBeGreaterThan(13);
    expect(ratio).toBeLessThan(28);
  });

  it("S14 long idle periods anchor leak near zero and leave calibration intact", () => {
    const rng = mulberry32(1414);
    const sim = new SimAccount([codexWeekly(1e6)]);
    steady(sim, { days: 3, probPerHour: 0.3, meanTokens: 1.4e6, rng });
    for (let h = 0; h < 3 * 24; h++) {
      sim.advanceHours(1);
      sim.readAll();
    }
    const stats = sim.cal.stats("codex-weekly");
    expect(Math.abs(stats.leakPercentPerDay)).toBeLessThan(0.7);
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.tokensPerPercent).toBeGreaterThan(0.85e6);
    expect(s.tokensPerPercent).toBeLessThan(1.2e6);
    expect(sim.cal.resetStats("codex-weekly").surpriseResets).toBe(0);
  });

  it("S15 detects a plan-size cut at a window boundary and recalibrates to the new plan", () => {
    const rng = mulberry32(1515);
    const sim = new SimAccount([codexWeekly(1e6)]);
    steady(sim, { days: 14.05, probPerHour: 0.25, meanTokens: 1.33e6, rng });
    sim.setPercentPerToken("codex-weekly", "sol", 1 / 350e3);
    steady(sim, { days: 6.5, probPerHour: 0.15, meanTokens: 1e6, rng });
    const stats = sim.cal.stats("codex-weekly");
    expect(stats.planShift).toBeDefined();
    expect(stats.planShift?.tokensPerPercentRatio).toBeGreaterThan(0.25);
    expect(stats.planShift?.tokensPerPercentRatio).toBeLessThan(0.47);
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.tokensPerPercent).toBeGreaterThan(280e3);
    expect(s.tokensPerPercent).toBeLessThan(420e3);
  });

  it("S16 survives extremely variable usage: spikes, droughts, lognormal-ish bursts", () => {
    const rng = mulberry32(1616);
    const sim = new SimAccount([codexWeekly(1e6)]);
    for (let h = 0; h < 14 * 24; h++) {
      const day = Math.floor(h / 24);
      const drought = day === 6 || day === 7;
      if (!drought && rng() < 0.1) sim.consume("sol", 1.5e6 * (0.25 + 1.5 * rng()));
      if (day === 4 && h % 24 === 10) sim.consume("sol", 15e6);
      if (day === 9 && h % 24 === 15) sim.consume("sol", 12e6);
      sim.advanceHours(1);
      sim.readAll();
    }
    const s = classStat(sim, "codex-weekly", "sol");
    expect(s.confidence).toBe("high");
    expect(s.tokensPerPercent).toBeGreaterThan(0.82e6);
    expect(s.tokensPerPercent).toBeLessThan(1.22e6);
  });
});
