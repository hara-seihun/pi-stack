import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccountCalibrator } from "../src/calibrator/calibrator.js";
import type { MeterSpec } from "../src/calibrator/types.js";
import { Ledger } from "../src/ledger/ledger.js";
import { DAY, HOUR, mulberry32 } from "./harness.js";

/**
 * Simulates the data a fully instrumented machine has: every pi turn logs
 * exact token components (usage-logger extension) and every provider response
 * carries an integer-percent meter reading (rate-limit headers). The only
 * remaining noise is the provider's 1% reporting granularity.
 *
 * Design under test: component price ratios are known facts from provider
 * pricing, so calibration maps raw component facts onto cost units at replay
 * time and estimates a single scale (cost units per percent) per meter.
 * Estimating free per-component weights from integer-quantized aggregate
 * segments is deliberately not attempted: it is under-identified.
 */

/** Published price ratios (cache read = 10% of input, output = 5x input). */
const PRICE = { cache: 0.02, input: 0.2, output: 1 } as const;
/** Hidden truth: cost units per 1% of plan. */
const TRUE_COST_TPP = 1.2e6;

interface Turn {
  at: number;
  session: number;
  cache: number;
  input: number;
  output: number;
}

function costUnits(t: Turn): number {
  return t.cache * PRICE.cache + t.input * PRICE.input + t.output * PRICE.output;
}

function turnDrain(t: Turn): number {
  return costUnits(t) / TRUE_COST_TPP;
}

/**
 * 14 days of fleet traffic with the structure real fleets have: day/night
 * cycle, day-to-day intensity variation, heterogeneous session types whose
 * mix varies by day. From day 11 the workload shifts hard from long agent and
 * batch sessions to many short interactive reviews -- a very different token
 * mix, and the holdout regime for prediction.
 */
function generateTurns(rng: () => number): Turn[] {
  const start = Date.UTC(2026, 7, 3);
  const turns: Turn[] = [];
  let session = 0;
  for (let d = 0; d < 14; d++) {
    const shifted = d >= 11;
    const pBatch = shifted ? 0.05 : 0.25 + 0.5 * rng();
    const pAgent = shifted ? 0.15 : 0.2;
    const intensity = 0.7 + 0.4 * rng();
    const sessions = Math.round((shifted ? 60 : 28) * intensity);
    for (let s = 0; s < sessions; s++) {
      session++;
      const sessionStart = start + d * DAY + Math.floor((7 + rng() * 15) * HOUR);
      const draw = rng();
      const type = draw < pBatch ? "batch" : draw < pBatch + pAgent ? "agent" : "interactive";
      const turnCount = type === "batch" ? 36 : type === "agent" ? 20 : 8;
      for (let i = 0; i < turnCount; i++) {
        const shape =
          type === "batch"
            ? { cache: 350_000 + 15_000 * i, input: 1_500 + 2_000 * rng(), output: 2_000 + 4_000 * rng() }
            : type === "agent"
              ? { cache: 200_000 + 25_000 * i * (0.7 + 0.6 * rng()), input: 3_000 + 6_000 * rng(), output: 800 + 3_000 * rng() }
              : { cache: 80_000 + 40_000 * rng(), input: 2_000 + 8_000 * rng(), output: 500 + 2_000 * rng() };
        turns.push({
          at: sessionStart + i * 2 * 60_000 + Math.floor(rng() * 1000),
          session,
          cache: Math.round(shape.cache),
          input: Math.round(shape.input),
          output: Math.round(shape.output),
        });
      }
    }
  }
  turns.sort((a, b) => a.at - b.at);
  return turns;
}

const COST_SPEC: MeterSpec[] = [
  { id: "codex-weekly", drainedBy: ["sol:cost"], nominalWindowMs: 7 * DAY },
];
const SCALAR_SPEC: MeterSpec[] = [
  { id: "codex-weekly", drainedBy: ["sol"], nominalWindowMs: 7 * DAY },
];
const CFG = { minObservationPercent: 5 };

/** The replay-time mapping from stored component facts to cost units. */
function toCostUnits(classId: string, tokens: number): { classId: string; tokens: number } {
  const component = classId.split(":")[1] as keyof typeof PRICE;
  return { classId: "sol:cost", tokens: tokens * PRICE[component] };
}

describe("fully instrumented machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-instr-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("I1 cost-normalized calibration is mix-shift invariant; raw-token calibration is not", () => {
    const rng = mulberry32(2026);
    const turns = generateTurns(rng);
    const cutoff = Date.UTC(2026, 7, 3) + 11 * DAY;

    const ledger = Ledger.open(join(dir, "instrumented.sqlite3"));
    ledger.upsertAccount({ id: "codex", provider: "openai-codex" });
    const scalar = new AccountCalibrator(SCALAR_SPEC, CFG);

    let used = 0;
    let resetAt = Date.UTC(2026, 7, 3) + 7 * DAY;
    let lastReadingAt = 0;
    const holdout = { cost: 0, raw: 0, trueDrain: 0 };

    for (const turn of turns) {
      if (turn.at >= cutoff) {
        holdout.cost += costUnits(turn);
        holdout.raw += turn.cache + turn.input + turn.output;
        holdout.trueDrain += turnDrain(turn);
        continue;
      }
      if (turn.at >= resetAt) {
        used = 0;
        resetAt += 7 * DAY;
      }
      const at = Math.max(turn.at, lastReadingAt + 1);
      lastReadingAt = at;
      const reading = { at, usedPercent: Math.floor(used), resetAt };
      ledger.recordReading("codex", "codex-weekly", reading);
      scalar.recordReading("codex-weekly", reading);
      used += turnDrain(turn);
      const usageAt = at + 500;
      ledger.recordUsageBatch("codex", [
        { at: usageAt, classId: "sol:cache", tokens: turn.cache, source: "machine" },
        { at: usageAt, classId: "sol:input", tokens: turn.input, source: "machine" },
        { at: usageAt, classId: "sol:output", tokens: turn.output, source: "machine" },
      ]);
      scalar.recordUsage({
        at: usageAt,
        classId: "sol",
        tokens: turn.cache + turn.input + turn.output,
        source: "machine",
      });
    }

    const stats = ledger
      .replayCalibrator("codex", COST_SPEC, CFG, toCostUnits)
      .stats("codex-weekly");
    const cost = stats.classes[0];
    expect(cost.confidence).toBe("high");
    expect(cost.tokensPerPercent).toBeGreaterThan(TRUE_COST_TPP * 0.95);
    expect(cost.tokensPerPercent).toBeLessThan(TRUE_COST_TPP * 1.05);
    expect(Math.abs(stats.leakPercentPerDay)).toBeLessThan(0.25);
    // Fully instrumented: essentially nothing drains across idle gaps.
    expect(stats.idleDrain.observations).toBeGreaterThan(5);
    expect(stats.idleDrain.percent).toBeLessThan(3);

    const costPrediction = holdout.cost / (cost.tokensPerPercent ?? NaN);
    const costError = Math.abs(costPrediction - holdout.trueDrain) / holdout.trueDrain;
    expect(costError).toBeLessThan(0.05);

    const scalarTpp = scalar.stats("codex-weekly").classes[0].tokensPerPercent ?? NaN;
    const scalarError = Math.abs(holdout.raw / scalarTpp - holdout.trueDrain) / holdout.trueDrain;
    expect(scalarError).toBeGreaterThan(0.1);
    expect(costError).toBeLessThan(scalarError / 2);
    ledger.close();
  });

  it("I2 leak becomes an alarm: an un-instrumented nightly job is detected, not absorbed", () => {
    const rng = mulberry32(2027);
    const turns = generateTurns(rng);
    // An un-instrumented 3am batch job: drains the meter, logs nothing.
    const start = Date.UTC(2026, 7, 3);
    for (let d = 0; d < 14; d++) {
      for (let s = 0; s < 3; s++) {
        const sessionStart = start + d * DAY + 3 * HOUR + Math.floor(rng() * 2 * HOUR);
        for (let i = 0; i < 20; i++) {
          turns.push({
            at: sessionStart + i * 2 * 60_000,
            session: -1,
            cache: Math.round(200_000 + 25_000 * i * (0.7 + 0.6 * rng())),
            input: Math.round(3_000 + 6_000 * rng()),
            output: Math.round(800 + 3_000 * rng()),
          });
        }
      }
    }
    turns.sort((a, b) => a.at - b.at);
    const cal = new AccountCalibrator(COST_SPEC, CFG);
    let used = 0;
    let resetAt = start + 7 * DAY;
    let lastReadingAt = 0;
    let unloggedDrain = 0;
    for (const turn of turns) {
      if (turn.at >= resetAt) {
        used = 0;
        resetAt += 7 * DAY;
      }
      if (turn.session === -1) {
        used += turnDrain(turn);
        unloggedDrain += turnDrain(turn);
        continue;
      }
      const at = Math.max(turn.at, lastReadingAt + 1);
      lastReadingAt = at;
      cal.recordReading("codex-weekly", { at, usedPercent: Math.floor(used), resetAt });
      used += turnDrain(turn);
      cal.recordUsage({ at: at + 500, classId: "sol:cost", tokens: costUnits(turn), source: "machine" });
    }
    const stats = cal.stats("codex-weekly");
    // The idle-drain alarm accounts the nightly job directly and model-free:
    // percent drained across zero-usage gaps matches the unlogged burn.
    expect(stats.idleDrain.percent).toBeGreaterThan(unloggedDrain * 0.6);
    expect(stats.idleDrain.percent).toBeLessThan(unloggedDrain * 1.5);
    // And the tokens recorded inside those gaps explain almost none of it.
    const gapTokenPercent = stats.idleDrain.tokens / TRUE_COST_TPP;
    expect(gapTokenPercent).toBeLessThan(stats.idleDrain.percent * 0.15);
  });
});
