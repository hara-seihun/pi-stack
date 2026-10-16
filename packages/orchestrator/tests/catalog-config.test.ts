import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_CATALOG, catalogAgentType, catalogModel } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { nativeModels, nativeProviders } from "../src/models.js";
import { resolveThreadSettings } from "../src/threads/settings.js";

const openaiModels = ["astra", "sol", "luna"];

describe("shared model selection", () => {
  it("resolves every catalog choice to a native model with its selected thinking level", () => {
    for (const choice of ORCHESTRATOR_CATALOG.models) {
      const model = nativeModels.find(model => model.provider === choice.provider && model.id === choice.model);
      expect(model, `${choice.provider}/${choice.model}`).toBeDefined();
      expect(getSupportedThinkingLevels(model!)).toContain(choice.thinking);
    }
  });
  it("excludes the removed model from upstream catalogues and explicit selections", () => {
    expect(nativeModels.some(model => /terra/i.test(model.id))).toBe(false);
    for (const model of ["terra", "openai-codex/gpt-5.6-terra", "openai-codex-8/gpt-5.6-terra", "private/terra"]) {
      expect(resolveThreadSettings({ model })).toMatchObject({ ok: false });
    }
  });
  it("uses the model glyphs shown by thread pickers", () => {
    expect(Object.fromEntries(["sol", "astra", "fable", "opus"].map(id => [id, catalogModel(id)?.icon]))).toEqual({
      sol: "☀️",
      astra: "⭐",
      fable: "🪶",
      opus: "🎨",
    });
  });

  it("resolves all three OpenAI choices through the provider and shared quota meters", () => {
    const provider = nativeProviders.find(provider => provider.id === "openai-codex")!;
    const available = provider.getModels();
    expect(ORCHESTRATOR_CATALOG.agentOrder.slice(0, 3)).toEqual(openaiModels);
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

});
