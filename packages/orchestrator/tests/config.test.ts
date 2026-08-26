import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  brokerConfig,
  cooldownPolicy,
  costTransform,
  loadConfig,
  type OrchestratorConfig,
} from "../src/config.js";

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
        // The scoped weekly meter is Fable's alone; Opus never touches it.
        { id: "anthropic-7d_oi", drainedBy: ["fable:cost"], windowHours: 168 },
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
    // Machine limits are deployment facts, and a config that names none
    // leaves the broker's own defaults in place rather than passing zero.
    expect(wired.maxConcurrentSessions).toBeUndefined();
    expect(brokerConfig({ ...CONFIG, maxConcurrentSessions: 24 }).maxConcurrentSessions).toBe(24);
  });

  it("resolves shared catalog ids while preserving private model definitions", () => {
    const dir = mkdtempSync(join(tmpdir(), "po-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      ...CONFIG,
      taskManifest: "tasks.json",
      providers: {
        ...CONFIG.providers,
        anthropic: {
          meters: ["anthropic-5h"],
          costWeights: CONFIG.providers.anthropic.costWeights,
        },
      },
      tiers: {
        light: ["luna"],
        standard: [{ id: "opus", thinking: "high" }],
        expert: [{ provider: "openai-codex", model: "private-preview" }],
      },
    }));
    const loaded = loadConfig(path);
    expect(loaded.taskManifest).toBe(join(dir, "tasks.json"));
    expect(loaded.providers.anthropic.meters[0]).toEqual({
      id: "anthropic-5h",
      drainedBy: ["default:cost", "opus:cost", "fable:cost"],
      windowHours: 5,
    });
    expect(loaded.providers.anthropic.modelClasses).toMatchObject({
      "claude-fable-5": "fable",
      "claude-opus-5": "opus",
    });
    expect(loaded.tiers).toEqual({
      light: [{ provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max" }],
      standard: [{ provider: "anthropic", model: "claude-opus-5", thinking: "high" }],
      expert: [{ provider: "openai-codex", model: "private-preview" }],
    });
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

  it("a meterless provider is only legal when it declares its own concurrency", () => {
    const dir = mkdtempSync(join(tmpdir(), "po-config-"));
    const path = join(dir, "config.json");
    const unmetered = (extra: Record<string, unknown>) => ({
      tiers: { light: [], standard: [{ provider: "openrouter", model: "stealth/ox-alpha" }], expert: [] },
      providers: { openrouter: { meters: [], ...extra } },
    });
    writeFileSync(path, JSON.stringify(unmetered({})));
    expect(() => loadConfig(path)).toThrow(/sessionCapacity/);
    writeFileSync(path, JSON.stringify(unmetered({ sessionCapacity: 0 })));
    expect(() => loadConfig(path)).toThrow(/positive integer/);
    writeFileSync(path, JSON.stringify(unmetered({ sessionCapacity: 2 })));
    expect(brokerConfig(loadConfig(path)).declaredCapacity).toEqual({ openrouter: 2 });
  });

  it("a burst-throttled family sits out seconds where a metered one sits out minutes", () => {
    const cooldown = cooldownPolicy({
      ...CONFIG,
      providers: { ...CONFIG.providers, nvidia: { meters: [], sessionCapacity: 2, throttleCooldownMs: 30_000 } },
    });
    expect(cooldown("nvidia", '{"status":429,"title":"Too Many Requests"}')).toBe(30_000);
    expect(cooldown("anthropic", "429 too many requests")).toBe(10 * 60_000);
    expect(cooldown(undefined, "429 too many requests")).toBe(10 * 60_000);
    // A named window is the provider reporting an empty plan, whatever its
    // ordinary 429s mean, so it outranks the declared throttle class.
    expect(cooldown("nvidia", "monthly spend limit reached")).toBe(24 * 60 * 60_000);
  });
});
