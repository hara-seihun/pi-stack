import { describe, expect, test } from "bun:test";
import type { PlanUsageSnapshot } from "pi-orchestrator/api";
import { planCards } from "./catalog-presentation";

function snapshot(metrics: Record<string, { percentLeft: number | null; cachePercent: number | null }>): PlanUsageSnapshot {
  return {
    plans: {
      anthropic: {
        state: "ready",
        planCount: 1,
        checkedCount: 1,
        metrics: Object.fromEntries(Object.entries(metrics).map(([id, value]) => [id, {
          percentLeft: value.percentLeft, expectedPercentLeft: null, paceDelta: null, cachePercent: value.cachePercent,
        }])),
      },
    },
    updatedAt: new Date(0).toISOString(),
  };
}

describe("plan cards", () => {
  test("carries each row's 24-hour cache share", () => {
    const cards = planCards(snapshot({ weekly: { percentLeft: 62, cachePercent: 91 }, fable: { percentLeft: 40, cachePercent: null } }));
    const anthropic = cards.find((card) => card.id === "anthropic");
    const weekly = anthropic?.metrics.find((metric) => metric.id === "weekly");
    const fable = anthropic?.metrics.find((metric) => metric.id === "fable");
    expect(weekly?.cacheText).toBe("91%");
    expect(weekly?.description).toContain("91% of prompt tokens read from cache over the last 24 hours");
    expect(fable?.cacheText).toBe("");
    expect(fable?.description).toContain("no calls in the last 24 hours");
  });

  test("says nothing about caching when plan usage has not loaded", () => {
    const [card] = planCards(null);
    expect(card.metrics.every((metric) => metric.cacheText === "")).toBe(true);
  });
});
