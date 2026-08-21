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

  it("paces on the most binding meter, and runs one session until burn is measured", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anth-1", provider: "anthropic", domain: "orchestrator" });
    const fast = { id: "fast", drainedBy: ["cost"], nominalWindowMs: 5 * HOUR };
    const weekly = { id: "weekly", drainedBy: ["cost"], nominalWindowMs: 7 * 24 * HOUR };
    const now = 6 * HOUR;
    ledger.recordReading("anth-1", "fast", { at: 0, usedPercent: 0, resetAt: 10 * HOUR });
    ledger.recordReading("anth-1", "weekly", { at: 0, usedPercent: 80, resetAt: 48 * HOUR });
    for (let hour = 1; hour <= 6; hour++) {
      ledger.recordUsage("anth-1", { at: hour * HOUR - HOUR / 2, classId: "cost", tokens: 1e6, source: "machine" });
      ledger.recordReading("anth-1", "fast", { at: hour * HOUR, usedPercent: hour, resetAt: 10 * HOUR });
    }
    ledger.recordReading("anth-1", "weekly", { at: now, usedPercent: 81, resetAt: 48 * HOUR });
    const broker = new Broker(ledger, {
      ...CONFIG,
      meters: { ...CONFIG.meters, anthropic: [fast, weekly] },
    });

    // The nearly-spent weekly meter binds (19% over 42h), not the fresh
    // five-hour one, even though neither has calibrated token coefficients:
    // pacing is percent-space arithmetic and needs none.
    const rate = broker.sustainableRate("anth-1", "anthropic", now)!;
    expect(rate).toBeGreaterThan(0.4);
    expect(rate).toBeLessThan(0.5);
    // Concurrency is still one, because the other half of the quotient — what
    // a session costs — has not been measured on this account yet.
    const first = broker.admit("standard", now)!;
    ledger.createRun({ taskId: "t", tier: "standard", at: now, ...first });
    expect(broker.admit("expert", now)).toBeUndefined();
  });

  it("a metered account with no token calibration still earns real concurrency", () => {
    // The Codex case, and the bug this rules out. Codex publishes no meter
    // headers to pi's transport, so its usage classes never calibrate; the
    // broker used to read that as bootstrap and run one session per account
    // on a subscription with a week of headroom. Percent readings alone are
    // enough to pace, and with burn measured the account carries a fleet.
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-1", provider: "openai-codex", domain: "orchestrator" });
    const now = 48 * HOUR;
    // A week's plan, 10% spent, no usage events at all to attribute it to.
    ledger.recordReading("codex-1", "weekly", {
      at: now - 24 * HOUR,
      usedPercent: 9,
      resetAt: now + 5 * 24 * HOUR,
    });
    ledger.recordReading("codex-1", "weekly", {
      at: now,
      usedPercent: 10,
      resetAt: now + 5 * 24 * HOUR,
    });
    for (let i = 0; i < 6; i++) {
      const started = now - (i + 1) * 4 * HOUR;
      const id = ledger.createRun({
        taskId: "t",
        tier: "light",
        accountId: "codex-1",
        model: "gpt-5.6-luna",
        provider: "openai-codex",
        at: started,
      });
      ledger.finishRun(id, { state: "done" }, started + 4 * HOUR);
    }
    const broker = new Broker(ledger, CONFIG);

    expect(broker.sustainableRate("codex-1", "openai-codex", now)).toBeGreaterThan(0);
    let admitted = 0;
    for (;;) {
      const a = broker.admit("light", now);
      if (a === undefined) break;
      ledger.createRun({ taskId: "t", tier: "light", at: now, ...a });
      admitted++;
    }
    expect(admitted).toBeGreaterThan(1);
  });

  it("stops at the machine's session ceiling however much quota is left", () => {
    // Provider quota is not the only finite resource: sessions live in the
    // runner's own process, and 24 of them once reached 22.8 GiB and were
    // OOM-killed. A plan with room for hundreds must not be allowed to ask
    // for them.
    const ledger = openLedger();
    const now = feedHistory(ledger, "anth-1", { percentPerHour: 0.1, hours: 48 });
    feedRuns(ledger, "anth-1", { count: 6, hoursEach: 8, endAt: now });
    const broker = new Broker(ledger, { ...CONFIG, maxConcurrentSessions: 3 });
    let admitted = 0;
    for (;;) {
      const a = broker.admit("standard", now);
      if (a === undefined) break;
      ledger.createRun({ taskId: "t", tier: "standard", at: now, ...a });
      admitted++;
    }
    expect(admitted).toBe(3);
    // The same ceiling bounds what a cycle advertises, across all tiers.
    const ledger2 = openLedger();
    const now2 = feedHistory(ledger2, "anth-1", { percentPerHour: 0.1, hours: 48 });
    feedRuns(ledger2, "anth-1", { count: 6, hoursEach: 8, endAt: now2 });
    const broker2 = new Broker(ledger2, { ...CONFIG, maxConcurrentSessions: 3 });
    const slots = broker2.slotsByTier(now2, { light: 10, standard: 10, expert: 10 });
    expect(slots.light + slots.standard + slots.expert).toBe(3);
  });

  it("refuses calibration from a reading whose reset already passed", () => {
    const ledger = openLedger();
    feedHistory(ledger, "anth-1", { percentPerHour: 0.2, hours: 48 });
    const broker = new Broker(ledger, CONFIG);
    expect(broker.sustainableRate("anth-1", "anthropic", 8 * 24 * HOUR)).toBeUndefined();
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

  it("advertises slots in proportion to demand, not scarcest tier first", () => {
    // Tiers share accounts: light and standard both draw on Codex here.
    // Draining the scarcer tier first took every account every cycle, so a
    // light-heavy machine was advertised no light slots at all.
    const ledger = openLedger();
    const broker = new Broker(ledger, CONFIG);
    const slots = broker.slotsByTier(0, { light: 40, standard: 2, expert: 0 });
    expect(slots.expert).toBe(0); // nothing wants it, so it reserves nothing
    expect(slots.light).toBe(1);
    expect(slots.standard).toBe(1);

    // Demand still caps each tier: two accounts, but only one wants a slot.
    expect(broker.slotsByTier(0, { light: 1, standard: 0, expert: 0 })).toEqual({
      light: 1,
      standard: 0,
      expert: 0,
    });
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

describe("broker external capacity", () => {
  it("reports eligible accounts with active counts and the machine ceiling", () => {
    const ledger = openLedger();
    ledger.upsertAccount({ id: "codex-cooling", provider: "openai-codex", domain: "orchestrator" });
    ledger.setAccountCooldown("codex-cooling", 5000);
    const broker = new Broker(ledger, CONFIG);
    const external = broker.externalCapacity(1000);
    // The cooling account is not an eligible view; the two healthy bootstrap
    // accounts each advertise one session.
    expect(external.accounts.map((a) => a.id).sort()).toEqual(["anth-1", "codex-1"]);
    for (const account of external.accounts) {
      expect(account.capacity).toBe(1);
      expect(account.active).toBe(0);
    }
    expect(external.machineCeiling).toBeGreaterThan(0);
    expect(external.totalActive).toBe(0);

    // An interactive lease appears as active capacity, exactly as admission
    // would count it.
    ledger.beginSessionLease("codex-1", 1000);
    const withLease = broker.externalCapacity(1000);
    expect(withLease.accounts.find((a) => a.id === "codex-1")?.active).toBe(1);
    expect(withLease.totalActive).toBe(1);
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
