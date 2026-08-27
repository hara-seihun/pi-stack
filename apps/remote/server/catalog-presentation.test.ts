import { describe, expect, test } from "bun:test";
import { ORCHESTRATOR_CATALOG, catalogAgentType } from "pi-orchestrator/api";
import { planCards } from "./catalog-presentation";

describe("orchestrator catalog presentation", () => {

  test("owns model labels and ordering", () => {
    expect(catalogAgentType("cursor/grok-4.6")).toEqual({ key: "grok", label: "GROK" });
    expect(catalogAgentType("anthropic-3/claude-opus-5")).toEqual({ key: "opus", label: "OPUS" });
    expect(ORCHESTRATOR_CATALOG.agentOrder).toContain("grok");
  });

  test("renders catalog plan cards and signed pace", () => {
    const cards = planCards({
      updatedAt: "2026-08-21T00:00:00.000Z",
      plans: {
        openai: { state: "ready", metrics: { remaining: { percentLeft: 64, expectedPercentLeft: 61, paceDelta: 3 } }, planCount: 2, checkedCount: 2 },
        anthropic: { state: "ready", metrics: {
          fable: { percentLeft: 70, expectedPercentLeft: 72, paceDelta: -2 },
          weekly: { percentLeft: 55, expectedPercentLeft: 51, paceDelta: 4 },
        }, planCount: 3, checkedCount: 3 },
        cursor: { state: "ready", metrics: { remaining: { percentLeft: 99, expectedPercentLeft: 99, paceDelta: 0 } }, planCount: 1, checkedCount: 1 },
      },
    });
    expect(cards.map((card) => card.id)).toEqual(["openai", "anthropic", "cursor"]);
    expect(cards.find((card) => card.id === "openai")?.text).toBe("64% (+3%)");
    expect(cards.find((card) => card.id === "anthropic")?.text).toBe("F 70% (-2%) · W 55% (+4%)");
    expect(cards.find((card) => card.id === "cursor")?.text).toBe("99% (+0%)");
    expect(cards.flatMap((card) => card.metrics).map((metric) => [metric.model, metric.modelLabel, metric.text])).toEqual([
      ["sol", "SOL", "64% (+3%)"],
      ["fable", "FABLE", "70% (-2%)"],
      ["opus", "OPUS", "55% (+4%)"],
      ["grok", "GROK", "99% (+0%)"],
    ]);
  });

  test("marks a figure that covers only some of the plans", () => {
    const cards = planCards({
      updatedAt: "2026-08-21T00:00:00.000Z",
      plans: {
        anthropic: { state: "partial", metrics: {
          fable: { percentLeft: 100, expectedPercentLeft: null, paceDelta: null },
          weekly: { percentLeft: 100, expectedPercentLeft: null, paceDelta: null },
        }, planCount: 3, checkedCount: 1 },
      },
    });
    const card = cards.find((entry) => entry.id === "anthropic");
    expect(card?.text).toBe("F 100% · W 100%*");
    expect(card?.description).toContain("measured on 1 of 3 plans");
  });
});
