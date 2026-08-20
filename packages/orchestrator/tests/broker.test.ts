import { describe, expect, it } from "vitest";
import { Broker, type BrokerConfig } from "../src/broker/broker.js";
import { Ledger } from "../src/ledger/ledger.js";
import type { MeterSpec } from "../src/calibrator/types.js";

const HOUR = 3_600_000;
const METERS: MeterSpec[] = [{ id: "weekly", drainedBy: ["cost"], nominalWindowMs: 7 * 24 * HOUR }];

const CONFIG: Partial<BrokerConfig> & Pick<BrokerConfig, "tiers" | "meters"> = {
  tiers: {
    light: [{ provider: "openai-codex", model: "gpt-5.6-luna" }],
    standard: [
      { provider: "anthropic", model: "claude-opus" },
      { provider: "openai-codex", model: "gpt-5.6-sol" },
    ],
    expert: [{ provider: "anthropic", model: "claude-fable" }],
  },
  meters: { "openai-codex": METERS, anthropic: METERS },
};

/** Feeds enough clean history that calibration is high-confidence: steady
 * drain of `percentPerHour` for `hours` hours with matching usage events. */
function feedHistory(
  ledger: Ledger,
  accountId: string,
  opts: { percentPerHour: number; hours: number; tokensPerPercent?: number; start?: number },
): number {
  const tpp = opts.tokensPerPercent ?? 1e6;
  const start = opts.start ?? 0;
  let used = 5;
  ledger.recordReading(accountId, "weekly", {
    at: start,
    usedPercent: used,
    resetAt: start + 7 * 24 * HOUR,
  });
  for (let h = 1; h <= opts.hours; h++) {
    const at = start + h * HOUR;
    ledger.recordUsage(accountId, {
      at: at - HOUR / 2,
      classId: "cost",
      tokens: opts.percentPerHour * tpp,
      source: "machine",
    });
    used += opts.percentPerHour;
    ledger.recordReading(accountId, "weekly", {
      at,
      usedPercent: Math.floor(used),
      resetAt: start + 7 * 24 * HOUR,
    });
  }
  return start + opts.hours * HOUR;
}

/** Records finished run history so sessionBurn has session-hours to divide by. */
function feedRuns(
  ledger: Ledger,
  accountId: string,
  opts: { count: number; hoursEach: number; endAt: number },
): void {
  for (let i = 0; i < opts.count; i++) {
    const started = opts.endAt - (i + 1) * opts.hoursEach * HOUR;
    const id = ledger.createRun({
      taskId: "t",
      tier: "standard",
      accountId,
      model: "m",
      provider: "anthropic",
      at: started,
    });
    ledger.finishRun(id, { state: "done" }, started + opts.hoursEach * HOUR);
  }
}

function openLedger(): Ledger {
  const ledger = Ledger.open(":memory:");
  ledger.upsertAccount({ id: "anth-1", provider: "anthropic", domain: "orchestrator" });
  ledger.upsertAccount({ id: "codex-1", provider: "openai-codex", domain: "orchestrator" });
  return ledger;
}

describe("broker admission", () => {
  it("bootstrap: an uncalibrated account gets exactly one concurrent session", () => {
    const ledger = openLedger();
    const broker = new Broker(ledger, CONFIG);
    const first = broker.admit("standard", 0);
    expect(first).toEqual({ accountId: "anth-1", provider: "anthropic", model: "claude-opus" });
    ledger.createRun({ taskId: "t", tier: "standard", at: 0, ...first! });
    // anth-1 is full; preference order falls through to codex-1.
    const second = broker.admit("standard", 0);
    expect(second?.accountId).toBe("codex-1");
    ledger.createRun({ taskId: "t", tier: "standard", at: 0, ...second! });
    expect(broker.admit("standard", 0)).toBeUndefined();
  });

  it("calibrated capacity: measured burn earns measured concurrency", () => {
    const ledger = openLedger();
    // 0.2%/h drain across 48h, produced by continuous single-session run
    // history: session burn ≈ 0.2 %/h against a plan rate several times
    // that, so measurement earns real multi-session concurrency.
    const now = feedHistory(ledger, "anth-1", { percentPerHour: 0.2, hours: 48 });
    feedRuns(ledger, "anth-1", { count: 6, hoursEach: 8, endAt: now });
    const broker = new Broker(ledger, CONFIG);
    const sustainable = broker.sustainableRate("anth-1", "anthropic", now)!;
    const burn = broker.sessionBurn("anth-1", now);
    expect(burn).toBeGreaterThan(0.12);
    expect(burn).toBeLessThan(0.3);
    expect(sustainable / burn).toBeGreaterThan(1);
    const capacity = Math.floor(sustainable / burn);
    let admitted = 0;
    for (;;) {
      const a = broker.admit("standard", now);
      if (a === undefined || a.accountId !== "anth-1") break;
      ledger.createRun({ taskId: "t", tier: "standard", at: now, ...a });
      admitted++;
    }
    expect(admitted).toBe(capacity);
    expect(capacity).toBeGreaterThan(0);
  });

  it("over-drained account: burn above the sustainable rate admits nothing", () => {
    const ledger = openLedger();
    // 1%/h continuous drain for 48h leaves the hazard-paced plan rate well
    // below one session's measured burn: the broker must refuse rather than
    // keep burning at a rate that exhausts the plan early.
    const now = feedHistory(ledger, "anth-1", { percentPerHour: 1, hours: 48 });
    feedRuns(ledger, "anth-1", { count: 6, hoursEach: 8, endAt: now });
    const broker = new Broker(ledger, CONFIG);
    const sustainable = broker.sustainableRate("anth-1", "anthropic", now)!;
    const burn = broker.sessionBurn("anth-1", now);
    expect(sustainable).toBeLessThan(burn);
    expect(broker.admit("expert", now)).toBeUndefined();
  });

  it("expired accounts are never admitted", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic", accessUntil: 100, domain: "orchestrator" });
    const broker = new Broker(ledger, CONFIG);
    expect(broker.admit("expert", 200)).toBeUndefined();
    expect(broker.admit("expert", 50)?.accountId).toBe("anth-1");
  });

  it("interactive-custody accounts are never admitted unless shared", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic" });
    const broker = new Broker(ledger, CONFIG);
    expect(broker.admit("expert", 0)).toBeUndefined();
    ledger.setAccountShared("anth-1", true);
    expect(broker.admit("expert", 0)?.accountId).toBe("anth-1");
  });

  it("an active interactive lease consumes shared broker capacity", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic", shared: true });
    const broker = new Broker(ledger, CONFIG);
    const lease = ledger.beginSessionLease("anth-1", 1000);
    expect(broker.admit("expert", 1000)).toBeUndefined();
    ledger.endSessionLease(lease, 2000);
    expect(broker.admit("expert", 2000)?.accountId).toBe("anth-1");
  });

  it("tier restriction: a light launch never lands on a provider outside its tier", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic", domain: "orchestrator" });
    const broker = new Broker(ledger, CONFIG);
    // Only an anthropic account exists but light maps only to openai-codex.
    expect(broker.admit("light", 0)).toBeUndefined();
  });
});

describe("broker slots", () => {
  it("shared accounts are not double-counted across tiers; scarce tiers reserve first", () => {
    const ledger = openLedger();
    const broker = new Broker(ledger, CONFIG);
    const slots = broker.slotsByTier(0);
    // Two bootstrap accounts, one session each. Expert (anthropic only)
    // reserves anth-1 first; standard gets codex-1; light finds codex full.
    expect(slots.expert).toBe(1);
    expect(slots.standard).toBe(1);
    expect(slots.light).toBe(0);
    expect(slots.expert + slots.standard + slots.light).toBe(2);
  });

  it("slot advertisement is bounded per tier", () => {
    const ledger = Ledger.open(":memory:");
    const now = 48 * HOUR;
    for (let i = 0; i < 4; i++) {
      const id = `anth-${i}`;
      ledger.upsertAccount({ id, provider: "anthropic", domain: "orchestrator" });
      feedHistory(ledger, id, { percentPerHour: 0.2, hours: 48 });
      feedRuns(ledger, id, { count: 6, hoursEach: 8, endAt: now });
    }
    const broker = new Broker(ledger, { ...CONFIG, maxSlotsPerTier: 3 });
    const slots = broker.slotsByTier(now);
    expect(slots.expert).toBeLessThanOrEqual(3);
    expect(slots.standard).toBeLessThanOrEqual(3);
  });
});

describe("broker failover", () => {
  it("moves a failing run to another account and cools the old one down", () => {
    const ledger = openLedger();
    const broker = new Broker(ledger, { ...CONFIG, cooldownMs: 10 * 60_000 });
    const first = broker.admit("standard", 0)!;
    const runId = ledger.createRun({ taskId: "t", tier: "standard", at: 0, ...first });
    ledger.claimRuns("r1", 1, 500); // failover applies to live, claimed sessions
    const moved = broker.failover(runId, 1000);
    expect(moved?.accountId).toBe("codex-1");
    expect(ledger.run(runId)?.accountId).toBe("codex-1");
    // The cooled account refuses new admissions until the deadline passes.
    expect(broker.admit("expert", 1000)).toBeUndefined();
    expect(broker.admit("expert", 1000 + 10 * 60_000)?.accountId).toBe("anth-1");
  });

  it("failover with no alternative reports undefined and keeps the run assignment", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic", domain: "orchestrator" });
    const broker = new Broker(ledger, CONFIG);
    const a = broker.admit("expert", 0)!;
    const runId = ledger.createRun({ taskId: "t", tier: "expert", at: 0, ...a });
    ledger.claimRuns("r1", 1, 500);
    expect(broker.failover(runId, 1000)).toBeUndefined();
    expect(ledger.run(runId)?.accountId).toBe("anth-1");
  });
});

describe("operator boost", () => {
  it("scales measured capacity for one family and leaves the others alone", () => {
    const ledger = openLedger();
    const now = feedHistory(ledger, "anth-1", { percentPerHour: 0.2, hours: 48 });
    feedRuns(ledger, "anth-1", { count: 6, hoursEach: 8, endAt: now });
    const broker = new Broker(ledger, CONFIG);
    const normal = broker.sustainableRate("anth-1", "anthropic", now)!;

    ledger.setBoost("anthropic", 5);
    expect(broker.sustainableRate("anth-1", "anthropic", now)).toBeCloseTo(normal * 5, 9);
    expect(ledger.boosts()).toEqual([{ provider: "anthropic", multiplier: 5 }]);
    // A boosted family admits proportionally more concurrent sessions.
    let boosted = 0;
    for (;;) {
      const a = broker.admit("standard", now);
      if (a === undefined || a.accountId !== "anth-1") break;
      ledger.createRun({ taskId: "t", tier: "standard", at: now, ...a });
      boosted++;
    }
    expect(boosted).toBeGreaterThan(Math.floor(normal / broker.sessionBurn("anth-1", now)));

    ledger.setBoost("anthropic", 1);
    expect(broker.sustainableRate("anth-1", "anthropic", now)).toBeCloseTo(normal, 9);
    expect(ledger.boosts()).toEqual([]);
  });

  it("never invents capacity for an uncalibrated account", () => {
    const ledger = openLedger();
    ledger.setBoost("anthropic", 5);
    const broker = new Broker(ledger, CONFIG);
    expect(broker.sustainableRate("anth-1", "anthropic", 0)).toBeUndefined();
    const first = broker.admit("standard", 0)!;
    ledger.createRun({ taskId: "t", tier: "standard", at: 0, ...first });
    // Bootstrap is still exactly one session: measurement earns concurrency.
    expect(broker.admit("standard", 0)?.accountId).toBe("codex-1");
  });

  it("refuses a multiplier below one", () => {
    const ledger = openLedger();
    expect(() => ledger.setBoost("anthropic", 0)).toThrow();
  });
});
