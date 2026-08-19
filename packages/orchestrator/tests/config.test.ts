import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokerConfig, costTransform, loadConfig, type OrchestratorConfig } from "../src/config.js";

const CONFIG: OrchestratorConfig = {
  tiers: {
    light: [{ provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max" }],
    standard: [{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh" }],
    expert: [{ provider: "anthropic", model: "claude-fable-5", thinking: "high" }],
  },
  providers: {
    anthropic: {
      meters: [
        { id: "anthropic-5h", drainedBy: ["default:cost", "opus:cost", "fable:cost"], windowHours: 5 },
        { id: "anthropic-7d_oi", drainedBy: ["opus:cost", "fable:cost"], windowHours: 168 },
      ],
      costWeights: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      modelClasses: { "claude-fable-5": "fable", "claude-opus-5": "opus" },
    },
    "openai-codex": {
      meters: [{ id: "codex-7d", drainedBy: ["default:cost"], windowHours: 168 }],
      costWeights: { input: 1, output: 8, cacheRead: 0.1 },
    },
  },
};

describe("operator config", () => {
  it("cost transform prices components and buckets coupled models", () => {
    const t = costTransform(CONFIG, "anthropic");
    // Fable output: fable bucket, 5x price weight.
    expect(t("claude-fable-5:output", 100)).toEqual({ classId: "fable:cost", tokens: 500 });
    // Unlisted model classes as default; cacheRead heavily discounted.
    expect(t("claude-sonnet-5:cacheRead", 1000)).toEqual({ classId: "default:cost", tokens: 100 });
    // Unknown component keeps its tokens (weight 1) rather than failing.
    expect(t("claude-sonnet-5:mystery", 7)).toEqual({ classId: "default:cost", tokens: 7 });
  });

  it("broker wiring dispatches transform per family", () => {
    const wired = brokerConfig(CONFIG);
    expect(wired.transform!("anthropic", "claude-fable-5:output", 10).tokens).toBe(50);
    expect(wired.transform!("openai-codex", "gpt-5.6-sol:output", 10).tokens).toBe(80);
    expect(wired.meters["anthropic"].map((m) => m.id)).toEqual(["anthropic-5h", "anthropic-7d_oi"]);
    expect(wired.meters["anthropic"][1].nominalWindowMs).toBe(168 * 3_600_000);
  });

  it("rejects a tier referencing an unconfigured provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "po-config-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        tiers: { light: [{ provider: "ghost", model: "m" }], standard: [], expert: [] },
        providers: {},
      }),
    );
    expect(() => loadConfig(path)).toThrow(/unknown provider ghost/);
    writeFileSync(path, JSON.stringify(CONFIG));
    expect(loadConfig(path).tiers.standard[0].thinking).toBe("xhigh");
  });
});
