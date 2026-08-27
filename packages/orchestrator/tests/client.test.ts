import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorClient, tailRange } from "../src/client.js";
import type { PlanDefinition } from "../src/catalog.js";
import { Ledger } from "../src/ledger/ledger.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(): { path: string; runsRoot: string; ledger: Ledger } {
  const root = mkdtempSync(join(tmpdir(), "pi-orchestrator-client-"));
  roots.push(root);
  const path = join(root, "ledger.sqlite3");
  return { path, runsRoot: join(root, "runs"), ledger: Ledger.open(path) };
}

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const PLAN: PlanDefinition = {
  id: "provider",
  label: "Provider",
  icon: "provider",
  provider: "provider",
  maxReadingAgeMs: 60 * 60_000,
  metrics: [
    { id: "binding", model: "sol", meters: ["codex-5h", "codex-7d"] },
    { id: "weekly", model: "sol", meters: ["codex-7d"] },
  ],
};

describe("orchestrator client", () => {
  it("projects every plan card from canonical accounts and meter facts", () => {
    const { path, runsRoot, ledger } = workspace();
    ledger.upsertAccount({ id: "provider-1", provider: "provider" });
    ledger.upsertAccount({ id: "provider-2", provider: "provider", capacityWeight: 2 });
    ledger.upsertAccount({ id: "ended", provider: "provider", accessUntil: NOW - 1 });
    ledger.recordReading("provider-1", "codex-5h", { at: NOW, usedPercent: 10, resetAt: NOW + 2.5 * 3_600_000 });
    ledger.recordReading("provider-1", "codex-7d", { at: NOW, usedPercent: 60, resetAt: NOW + 84 * 3_600_000 });
    ledger.recordReading("provider-2", "codex-5h", { at: NOW, usedPercent: 20, resetAt: NOW + 2.5 * 3_600_000 });
    ledger.recordReading("provider-2", "codex-7d", { at: NOW, usedPercent: 40, resetAt: NOW + 84 * 3_600_000 });
    ledger.close();

    const client = new OrchestratorClient({ ledgerPath: path, runsRoot });
    expect(client.plans([PLAN], NOW)).toEqual({
      updatedAt: "2026-08-21T12:00:00.000Z",
      plans: {
        provider: {
          state: "ready",
          metrics: {
            // The weekly window binds both accounts. Account two represents
            // twice the allowance, so 40% and 60% combine to 53%, not 50%.
            binding: { percentLeft: 53, expectedPercentLeft: 50, paceDelta: 3 },
            weekly: { percentLeft: 53, expectedPercentLeft: 50, paceDelta: 3 },
          },
          planCount: 2,
          checkedCount: 2,
        },
      },
    });
    client.close();
  });

  it("reports incomplete coverage and rejects stale evidence", () => {
    const { path, runsRoot, ledger } = workspace();
    ledger.upsertAccount({ id: "provider-1", provider: "provider" });
    ledger.upsertAccount({ id: "provider-2", provider: "provider" });
    ledger.recordReading("provider-1", "codex-7d", { at: NOW, usedPercent: 25 });
    ledger.recordReading("provider-2", "codex-7d", { at: NOW - 2 * 60 * 60_000, usedPercent: 5 });
    ledger.close();

    const client = new OrchestratorClient({ ledgerPath: path, runsRoot });
    expect(client.plans([PLAN], NOW).plans.provider).toEqual({
      state: "partial",
      metrics: {
        binding: { percentLeft: 75, expectedPercentLeft: null, paceDelta: null },
        weekly: { percentLeft: 75, expectedPercentLeft: null, paceDelta: null },
      },
      planCount: 2,
      checkedCount: 1,
    });
    client.close();
  });

  it("rolls a finished meter window to empty and owns account and boost access", () => {
    const { path, runsRoot, ledger } = workspace();
    ledger.upsertAccount({ id: "provider-1", provider: "provider", label: "One" });
    ledger.recordReading("provider-1", "codex-7d", { at: NOW, usedPercent: 100, resetAt: NOW });
    ledger.close();

    const client = new OrchestratorClient({ ledgerPath: path, runsRoot });
    expect(client.accounts("provider").map((account) => account.id)).toEqual(["provider-1"]);
    expect(client.plans([PLAN], NOW).plans.provider.metrics.weekly).toEqual({
      percentLeft: 100,
      expectedPercentLeft: null,
      paceDelta: null,
    });
    expect(client.boost("provider")).toBe(1);
    client.setBoost("provider", 3);
    expect(client.boost("provider")).toBe(3);
    client.close();
  });
});

describe("transcript range", () => {
  it("joins a fresh long transcript at its tail and restarts after rotation", () => {
    expect(tailRange(5_000, -1, 1_000)).toEqual({ start: 4_000, end: 5_000, fresh: true });
    expect(tailRange(500, -1, 1_000)).toEqual({ start: 0, end: 500, fresh: true });
    expect(tailRange(5_000, 4_800, 1_000)).toEqual({ start: 4_800, end: 5_000, fresh: false });
    expect(tailRange(100, 4_800, 1_000)).toEqual({ start: 0, end: 100, fresh: true });
  });
});
