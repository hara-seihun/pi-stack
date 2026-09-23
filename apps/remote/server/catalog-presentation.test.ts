import { describe, expect, test } from "bun:test";
import type { PlanAccountUsage, PlanUsageSnapshot } from "pi-orchestrator/api";
import { planCards } from "./catalog-presentation";

type Metric = { percentLeft: number | null; cachePercent: number | null; paceDelta?: number | null; accounts?: PlanAccountUsage[] };

function snapshot(metrics: Record<string, Metric>, state: "ready" | "partial" = "ready"): PlanUsageSnapshot {
  return {
    plans: {
      anthropic: {
        state,
        planCount: state === "partial" ? 2 : 1,
        checkedCount: 1,
        metrics: Object.fromEntries(Object.entries(metrics).map(([id, value]) => [id, {
          percentLeft: value.percentLeft, expectedPercentLeft: null, paceDelta: value.paceDelta ?? null, cachePercent: value.cachePercent, accounts: value.accounts ?? [],
        }])),
      },
    },
    updatedAt: new Date(0).toISOString(),
  };
}

describe("plan cards", () => {
  test("carries cache share once and names each quota window", () => {
    const cards = planCards(snapshot({ weekly: { percentLeft: 62, cachePercent: 91 }, fable: { percentLeft: 40, cachePercent: null } }));
    const anthropic = cards.find((card) => card.id === "anthropic");
    const weekly = anthropic?.metrics.find((metric) => metric.id === "weekly");
    const fable = anthropic?.metrics.find((metric) => metric.id === "fable");
    expect(weekly).toMatchObject({ cacheText: "91%", description: "7-day quota · all models" });
    expect(fable).toMatchObject({ cacheText: "", description: "7-day quota" });
    expect(weekly?.description).not.toContain("91%");
  });

  test("keeps the exact remaining amount and pace in one value", () => {
    const cards = planCards(snapshot({ weekly: { percentLeft: 62.5, paceDelta: -3.2, cachePercent: null } }, "partial"));
    const anthropic = cards.find((card) => card.id === "anthropic");
    expect(anthropic?.metrics.find((metric) => metric.id === "weekly")?.text).toBe("62.5% remaining · 3.2% behind pace");
    expect(anthropic?.description).toBe("1 of 2 plans measured");
  });

  test("carries account quota detail to the dashboard", () => {
    const account: PlanAccountUsage = { accountId: "anthropic-1", accountLabel: "Primary", state: "ready", percentLeft: 62, usedPercent: 38, meterId: "anthropic-7d", windowHours: 168, readingAt: "2026-09-20T12:00:00.000Z", resetAt: "2026-09-25T12:00:00.000Z", bankedResets: 3, bankedResetsAt: "2026-09-20T12:00:00.000Z", bankedResetExpiresAt: "2026-10-20T12:00:00.000Z" };
    const cards = planCards(snapshot({ weekly: { percentLeft: 62, cachePercent: null, accounts: [account] } }));
    expect(cards.find((card) => card.id === "anthropic")?.metrics.find((metric) => metric.id === "weekly")?.accounts).toEqual([account]);
  });

  test("says nothing about caching when plan usage has not loaded", () => {
    const [card] = planCards(null);
    expect(card.metrics.every((metric) => metric.cacheText === "")).toBe(true);
  });
});
