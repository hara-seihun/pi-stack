import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccountCalibrator } from "../src/calibrator/calibrator.js";
import type { MeterSpec } from "../src/calibrator/types.js";
import { Ledger } from "../src/ledger/ledger.js";
import { DAY, HOUR, mulberry32 } from "./harness.js";

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

  it("dedupes idle high-frequency readings to hourly anchors without losing semantics", () => {
    const ledger = Ledger.open(join(dir, "dedupe.sqlite3"));
    const history = generateHistory(3, 11);
    feedLedger(ledger, "codex-b", history);
    const activeReadings = ledger.counts("codex-b").readings;
    const idleStart = Date.UTC(2026, 7, 6, 9);
    let offered = 0;
    let stored = 0;
    const lastPercent = history.filter((e) => e.kind === "reading").at(-1)?.usedPercent ?? 0;
    for (let m = 0; m < 2 * 24 * 12; m++) {
      offered++;
      const r = ledger.recordReading("codex-b", "codex-weekly", {
        at: idleStart + m * 5 * 60_000,
        usedPercent: lastPercent,
        resetAt: Date.UTC(2026, 7, 10, 8),
      });
      if (r.stored) stored++;
    }
    expect(stored).toBeLessThanOrEqual(offered / 10);
    const cal = ledger.replayCalibrator("codex-b", SPECS);
    const stats = cal.stats("codex-weekly");
    expect(Math.abs(stats.leakPercentPerDay)).toBeLessThan(0.7);
    expect(stats.classes[0].tokensPerPercent).toBeGreaterThan(0.85e6);
    expect(stats.classes[0].tokensPerPercent).toBeLessThan(1.2e6);
    expect(activeReadings).toBeGreaterThan(0);
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
