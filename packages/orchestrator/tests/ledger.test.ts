import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccountCalibrator } from "../src/calibrator/calibrator.js";
import type { MeterSpec } from "../src/calibrator/types.js";
import { Ledger } from "../src/ledger/ledger.js";
import { DAY, HOUR, mix, mulberry32 } from "./harness.js";

const SPECS: MeterSpec[] = [
  { id: "codex-weekly", drainedBy: ["sol"], nominalWindowMs: 7 * DAY },
];

interface HistoryEntry {
  at: number;
  kind: "reading" | "usage";
  usedPercent?: number;
  resetAt?: number;
  tokens?: number;
}

/** Deterministic account history: 1M tokens/percent truth, day/night usage
 * cycle, one scheduled rollover at day 7, one surprise reset at day 10,
 * hourly readings. Night lulls decorrelate tokens from elapsed time, which
 * is what pins the leak estimate to zero (cf. calibrator scenario S14). */
function generateHistory(days: number, seed: number): HistoryEntry[] {
  const rng = mulberry32(seed);
  const start = Date.UTC(2026, 7, 3, 8);
  const out: HistoryEntry[] = [];
  let used = 0;
  let resetAt = start + 7 * DAY;
  const surpriseAt = start + 10 * DAY + 5 * HOUR;
  let surprised = false;
  for (let h = 0; h < days * 24; h++) {
    const t = start + h * HOUR;
    if (t >= resetAt) {
      used = 0;
      resetAt += 7 * DAY;
    }
    if (!surprised && t >= surpriseAt) {
      used = 0;
      resetAt = t + 7 * DAY;
      surprised = true;
    }
    out.push({ at: t, kind: "reading", usedPercent: Math.floor(used), resetAt });
    const daytime = h % 24 >= 8;
    if (rng() < (daytime ? 0.5 : 0.1)) {
      const tokens = 1.2e6 * (0.5 + rng());
      used += tokens * 1e-6;
      out.push({ at: t + 20 * 60_000, kind: "usage", tokens });
    }
  }
  return out;
}

function feedLive(history: HistoryEntry[]): AccountCalibrator {
  const cal = new AccountCalibrator(SPECS);
  for (const e of history) {
    if (e.kind === "reading") {
      cal.recordReading("codex-weekly", {
        at: e.at,
        usedPercent: e.usedPercent ?? 0,
        resetAt: e.resetAt,
      });
    } else {
      cal.recordUsage({ at: e.at, classId: "sol", tokens: e.tokens ?? 0, source: "orchestrator" });
    }
  }
  return cal;
}

function feedLedger(ledger: Ledger, accountId: string, history: HistoryEntry[]): void {
  ledger.upsertAccount({ id: accountId, provider: "openai-codex" });
  for (const e of history) {
    if (e.kind === "reading") {
      ledger.recordReading(accountId, "codex-weekly", {
        at: e.at,
        usedPercent: e.usedPercent ?? 0,
        resetAt: e.resetAt,
      });
    } else {
      ledger.recordUsage(accountId, {
        at: e.at,
        classId: "sol",
        tokens: e.tokens ?? 0,
        source: "orchestrator",
      });
    }
  }
}

describe("ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-ledger-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("replayed calibrator is identical to one that lived through the events", () => {
    const history = generateHistory(12, 7);
    const live = feedLive(history);
    const ledger = Ledger.open(join(dir, "replay.sqlite3"));
    feedLedger(ledger, "codex-a", history);
    const replayed = ledger.replayCalibrator("codex-a", SPECS);
    expect(replayed.stats("codex-weekly")).toEqual(live.stats("codex-weekly"));
    expect(replayed.resetStats("codex-weekly")).toEqual(live.resetStats("codex-weekly"));
    const s = replayed.stats("codex-weekly").classes[0];
    expect(s.tokensPerPercent).toBeGreaterThan(0.9e6);
    expect(s.tokensPerPercent).toBeLessThan(1.1e6);
    const rs = replayed.resetStats("codex-weekly");
    expect(rs.scheduledResets).toBe(1);
    expect(rs.surpriseResets).toBe(1);
    ledger.close();
  });

  it("stores idle high-frequency readings verbatim without corrupting calibration", () => {
    const ledger = Ledger.open(join(dir, "idle.sqlite3"));
    const history = generateHistory(3, 11);
    feedLedger(ledger, "codex-b", history);
    const idleStart = Date.UTC(2026, 7, 6, 9);
    const lastPercent = history.filter((e) => e.kind === "reading").at(-1)?.usedPercent ?? 0;
    for (let m = 0; m < 2 * 24 * 12; m++) {
      ledger.recordReading("codex-b", "codex-weekly", {
        at: idleStart + m * 5 * 60_000,
        usedPercent: lastPercent,
        resetAt: Date.UTC(2026, 7, 10, 8),
      });
    }
    const cal = ledger.replayCalibrator("codex-b", SPECS);
    const stats = cal.stats("codex-weekly");
    expect(Math.abs(stats.leakPercentPerDay)).toBeLessThan(0.7);
    expect(stats.classes[0].tokensPerPercent).toBeGreaterThan(0.85e6);
    expect(stats.classes[0].tokensPerPercent).toBeLessThan(1.2e6);
    ledger.close();
  });

  it("persists across close and reopen, including account rows", () => {
    const path = join(dir, "reopen.sqlite3");
    const history = generateHistory(9, 13);
    const first = Ledger.open(path);
    first.upsertAccount({ id: "codex-c", provider: "openai-codex", label: "work" });
    feedLedger(first, "codex-c", history);
    first.upsertAccount({ id: "codex-c", provider: "openai-codex", label: "work", accessUntil: 123 });
    const before = first.replayCalibrator("codex-c", SPECS).stats("codex-weekly");
    first.close();
    const second = Ledger.open(path);
    expect(second.replayCalibrator("codex-c", SPECS).stats("codex-weekly")).toEqual(before);
    const account = second.accounts().find((a) => a.id === "codex-c");
    expect(account?.label).toBe("work");
    expect(account?.accessUntil).toBe(123);
    second.close();
  });

  it("usage-attribution upserts never reset custody facts", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-2", provider: "openai-codex", shared: true });
    ledger.syncFleetCredentials(new Set(["codex-2"]));
    // The usage-logger extension upserts without custody fields on every session.
    ledger.upsertAccount({ id: "codex-2", provider: "openai-codex" });
    expect(ledger.accounts()[0]?.shared).toBe(true);
    expect(ledger.accounts()[0]?.fleetCredentialed).toBe(true);
  });

  it("fleet credential custody follows the observed stores, both directions", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anthropic-2", provider: "anthropic" });
    ledger.upsertAccount({ id: "anthropic-9", provider: "anthropic" });
    ledger.upsertAccount({ id: "codex-2", provider: "openai-codex", shared: true });
    ledger.syncFleetCredentials(new Set(["anthropic-2"]));
    const custody = () =>
      Object.fromEntries(ledger.accounts().map((a) => [a.id, a.fleetCredentialed]));
    // Shared accounts are central-store credentialed whatever the id set says.
    expect(custody()).toEqual({ "anthropic-2": true, "anthropic-9": false, "codex-2": true });
    // The credential moved away: the next observation withdraws the account.
    ledger.syncFleetCredentials(new Set());
    expect(custody()).toEqual({ "anthropic-2": false, "anthropic-9": false, "codex-2": true });
  });

  it("interactive leases contribute live capacity and bounded historical session-hours", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-2", provider: "openai-codex", shared: true });
    const lease = ledger.beginSessionLease("codex-2", 1000);
    ledger.heartbeatSessionLease(lease, 31_000);
    expect(ledger.activeSessionLeaseCount("codex-2", 40_000, 20_000)).toBe(1);
    expect(ledger.activeSessionLeaseCount("codex-2", 60_000, 20_000)).toBe(0);
    expect(ledger.sessionHours("codex-2", 0, 100_000, 20_000)).toBeCloseTo(50_000 / HOUR);
    ledger.close();
  });

  it("prune keeps recent windows calibratable", () => {
    const ledger = Ledger.open(join(dir, "prune.sqlite3"));
    const history = generateHistory(12, 17);
    feedLedger(ledger, "codex-d", history);
    const deleted = ledger.prune(Date.UTC(2026, 7, 3, 8) + 8 * DAY);
    expect(deleted.readings).toBeGreaterThan(0);
    expect(deleted.usageEvents).toBeGreaterThan(0);
    const s = ledger.replayCalibrator("codex-d", SPECS).stats("codex-weekly").classes[0];
    expect(s.confidence).not.toBe("none");
    expect(s.tokensPerPercent).toBeGreaterThan(0.85e6);
    expect(s.tokensPerPercent).toBeLessThan(1.2e6);
    ledger.close();
  });

  it("rejects out-of-order readings loudly", () => {
    const ledger = Ledger.open(join(dir, "order.sqlite3"));
    ledger.upsertAccount({ id: "codex-e", provider: "openai-codex" });
    const at = Date.UTC(2026, 7, 3, 8);
    ledger.recordReading("codex-e", "codex-weekly", { at, usedPercent: 5 });
    expect(() =>
      ledger.recordReading("codex-e", "codex-weekly", { at: at - 1, usedPercent: 6 }),
    ).toThrow(/out-of-order/);
    ledger.close();
  });
});

describe("account metadata custody", () => {
  it("a bare usage-attribution upsert never erases label or access_until", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-6", provider: "openai-codex", label: "apple.village", accessUntil: 500 });
    ledger.upsertAccount({ id: "codex-6", provider: "openai-codex" });
    const account = ledger.accounts().find((a) => a.id === "codex-6");
    expect(account?.label).toBe("apple.village");
    expect(account?.accessUntil).toBe(500);
  });

  it("reactivation clears the deadline explicitly", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-6", provider: "openai-codex", accessUntil: 500 });
    ledger.setAccountAccessUntil("codex-6", undefined);
    expect(ledger.accounts().find((a) => a.id === "codex-6")?.accessUntil).toBeUndefined();
  });

  it("an account that moved to another machine leaves with its facts", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-7", provider: "openai-codex" });
    ledger.upsertAccount({ id: "codex-8", provider: "openai-codex" });
    ledger.recordReading("codex-7", "codex-weekly", { at: 10, usedPercent: 4 });
    ledger.recordUsage("codex-7", { at: 20, classId: "sol", tokens: 100, source: "machine" });
    ledger.recordReading("codex-8", "codex-weekly", { at: 30, usedPercent: 9 });

    const removed = ledger.removeAccount("codex-7");

    expect(removed).toEqual({ usageEvents: 1, meterReadings: 1 });
    expect(ledger.accounts().map((a) => a.id)).toEqual(["codex-8"]);
    // The machine that kept its account keeps everything calibration needs.
    expect(ledger.counts("codex-8")).toEqual({ readings: 1, usageEvents: 0 });
    expect(() => ledger.removeAccount("codex-7")).toThrow(/unknown account/);
  });

  it("resolves runs by unique id prefix and rejects ambiguity", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-7", provider: "openai-codex" });
    ledger.upsertTask({ id: "lane", tiers: mix("standard"), demandConstant: 1, prompt: "go" });
    const spec = {
      taskId: "lane",
      tier: "standard",
      accountId: "codex-7",
      model: "gpt",
      provider: "openai-codex",
      at: 1,
    } as const;
    const ids = [ledger.createRun(spec), ledger.createRun(spec)];
    const target = ids[0]!;

    expect(ledger.run(target)?.id).toBe(target);
    // status prints 8-char prefixes; operators paste them back in.
    expect(ledger.run(target.slice(0, 8))?.id).toBe(target);
    expect(ledger.run("no-such-run")).toBeUndefined();
    expect(() => ledger.run("")).toThrow(/ambiguous/);
  });

  it("refuses to remove an account with work still on it", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-7", provider: "openai-codex" });
    ledger.upsertTask({ id: "lane", tiers: mix("standard"), demandConstant: 1, prompt: "go" });
    ledger.createRun({
      taskId: "lane",
      tier: "standard",
      accountId: "codex-7",
      model: "gpt",
      provider: "openai-codex",
      at: 1,
    });

    expect(() => ledger.removeAccount("codex-7")).toThrow(/in-flight/);
    expect(ledger.accounts().map((a) => a.id)).toEqual(["codex-7"]);
  });

  it("attributes fleet burn to its lane and leaves interactive burn on the machine", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "codex-7", provider: "openai-codex" });
    ledger.upsertTask({ id: "frontier", tiers: mix("standard"), demandConstant: 1, prompt: "go" });
    const at = Date.now();
    const run = ledger.createRun({
      taskId: "frontier",
      tier: "standard",
      accountId: "codex-7",
      model: "gpt",
      provider: "openai-codex",
      at,
    });
    ledger.linkRunSession(run, "fleet-session");
    ledger.recordUsage("codex-7", {
      at,
      classId: "gpt:input",
      tokens: 300,
      source: "orchestrator",
      sessionId: "fleet-session",
    });
    // The same shared account, spent by an operator's own session.
    ledger.recordUsage("codex-7", {
      at,
      classId: "gpt:input",
      tokens: 100,
      source: "machine",
      sessionId: "operator-session",
    });

    const b = ledger.usageBreakdown(at - HOUR);
    expect(b.total).toBe(400);
    expect(b.bySource).toEqual({ orchestrator: 300, machine: 100 });
    expect(b.byLane).toEqual([{ key: "frontier", tokens: 300, sessions: 1 }]);
    expect(b.byAccount).toEqual([{ key: "codex-7", tokens: 400, sessions: 2 }]);
    expect(b.topSessions.map((s) => s.key)).toEqual([
      "fleet-session  frontier",
      "operator-session  codex-7",
    ]);
  });
});

describe("fleet presence", () => {
  const HOUR_MS = 60 * 60_000;

  it("counts live sessions whole and lets ended ones fade across the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-"));
    const ledger = Ledger.open(join(dir, "l.sqlite3"));
    ledger.upsertAccount({ id: "a1", provider: "anthropic" });
    const now = 10 * HOUR_MS;
    const since = now - HOUR_MS;

    // A live session, whatever its age.
    ledger.createRun({ taskId: "lane", tier: "light", accountId: "a1", model: "m", provider: "anthropic", at: now - 5 * HOUR_MS });
    // A session that ended a moment ago still counts as one: a lane whose
    // sessions are short must not read as idle, or a weighted mix could never
    // hold across single-slot cycles.
    const justEnded = ledger.createRun({ taskId: "lane", tier: "light", accountId: "a1", model: "m", provider: "anthropic", at: now - HOUR_MS });
    ledger.finishRun(justEnded, { state: "done" }, now - 36_000);
    // Half a window ago: half weight.
    const half = ledger.createRun({ taskId: "lane", tier: "standard", accountId: "a1", model: "m", provider: "anthropic", at: now - HOUR_MS });
    ledger.finishRun(half, { state: "done" }, now - HOUR_MS / 2);
    // Older than the window: gone, not a phantom hold on the machine.
    const old = ledger.createRun({ taskId: "lane", tier: "standard", accountId: "a1", model: "m", provider: "anthropic", at: now - 4 * HOUR_MS });
    ledger.finishRun(old, { state: "done" }, now - 2 * HOUR_MS);

    const held = ledger.fleetPresenceByTier("lane", since, now);
    expect(held.light).toBeCloseTo(1.99, 2);
    expect(held.standard).toBeCloseTo(0.5, 2);
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
