import { describe, expect, test } from "bun:test";
import { loadProviderManifest, manifestAgentType, manifestPlanCards } from "./provider-manifest";

describe("provider manifest", () => {
  const manifest = loadProviderManifest();

  test("owns model labels and ordering", () => {
    expect(manifestAgentType(manifest, "cursor/grok-4.6")).toEqual({ key: "grok", label: "GROK" });
    expect(manifestAgentType(manifest, "anthropic-3/claude-opus-5")).toEqual({ key: "opus", label: "OPUS" });
    expect(manifest.agentOrder).toContain("grok");
  });

  test("renders arbitrary plan cards and signed pace from manifest metrics", () => {
    const cards = manifestPlanCards(manifest, {
      openai: { state: "ready", percentLeft: 64, paceDelta: 3, planCount: 2 },
      anthropic: { state: "ready", fablePercentLeft: 70, fablePaceDelta: -2, weeklyPercentLeft: 55, weeklyPaceDelta: 4, planCount: 3, checkedCount: 3 },
      cursor: { state: "ready", percentLeft: 99.4, paceDelta: -0.3, planCount: 1, checkedCount: 1 },
    });
    expect(cards.map((card) => card.id)).toEqual(["openai", "anthropic", "cursor"]);
    expect(cards.find((card) => card.id === "openai")?.text).toBe("64% (+3%)");
    expect(cards.find((card) => card.id === "anthropic")?.text).toBe("F 70% (-2%) · W 55% (+4%)");
    expect(cards.find((card) => card.id === "cursor")?.text).toBe("99.4% (-0.3%)");
  });

  test("marks a figure that covers only some of the plans", () => {
    const cards = manifestPlanCards(manifest, {
      anthropic: { state: "partial", fablePercentLeft: 100, weeklyPercentLeft: 100, planCount: 3, checkedCount: 1 },
    });
    const card = cards.find((entry) => entry.id === "anthropic");
    expect(card?.text).toBe("F 100% · W 100%*");
    expect(card?.description).toContain("measured on 1 of 3 plans");
  });
});
