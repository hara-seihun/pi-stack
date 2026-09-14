import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_CATALOG, catalogAgentType, catalogModel } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";

const openaiModels = ["astra", "sol", "terra", "luna"];

describe("shared model selection", () => {
  it("resolves all four OpenAI choices through the provider and shared quota meters", () => {
    const provider = builtinProviders().find(provider => provider.id === "openai-codex")!;
    const available = provider.getModels();
    expect(ORCHESTRATOR_CATALOG.agentOrder.slice(0, 4)).toEqual(openaiModels);
    for (const id of openaiModels) {
      const model = catalogModel(id)!;
      expect(model).toBeDefined();
      const physical = available.find(candidate => candidate.id === model.model);
      expect(physical).toBeDefined();
      expect(getSupportedThinkingLevels(physical!)).toContain(model.thinking);
      expect(catalogAgentType(`openai-codex-12/${model.model}:high`).key).toBe(id);
      expect(catalogAgentType(id.toUpperCase()).key).toBe(id);
      for (const meter of ORCHESTRATOR_CATALOG.meters.filter(meter => meter.provider === model.provider)) {
        expect(meter.drainedBy).toContain(`${model.meterClass}:cost`);
      }
    }
  });

  it("does not mistake an unrelated model's name for the short Sol alias", () => {
    expect(catalogAgentType("custom/console-model").key).toBe("console-model");
    expect(catalogAgentType("anthropic/claude-sonnet-4-6").key).toBe("sonnet");
  });

  it("offers single-model profiles independently of host lane preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-model-config-"));
    const path = join(root, "config.json");
    const hostProfiles = {
      standard: [{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }],
      review: [{ provider: "openai-codex", model: "gpt-6-astra", thinking: "max" }],
    };
    try {
      const defaults = loadConfig(path).profiles;
      writeFileSync(path, JSON.stringify({ profiles: {
        ...hostProfiles,
        sol: [{ provider: "anthropic", model: "claude-opus-5" }],
      } }));
      const configured = loadConfig(path).profiles;
      expect(configured.standard).toEqual(hostProfiles.standard);
      expect(configured.review).toEqual([{ provider: "openai-codex", model: "gpt-6-astra", thinking: "high" }]);
      expect(configured.expert).toBeUndefined();
      for (const id of [...openaiModels, "opus"]) {
        const { provider, model, thinking } = catalogModel(id)!;
        expect(defaults[id]).toEqual([{ provider, model, thinking }]);
        expect(configured[id]).toEqual(defaults[id]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
