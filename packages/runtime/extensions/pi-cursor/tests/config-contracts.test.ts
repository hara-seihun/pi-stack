import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { buildEffortMap, modelConfig, processModels } from "../src/index.js";
import {
  formatCursorUsage,
  getCursorUsageSummary,
  parseConnectPeriodUsage,
  parseCursorUsageSummary,
} from "../src/usage.js";

describe("provider configuration contracts", () => {
  it("maps the thinking levels Cursor actually offers", () => {
    expect(buildEffortMap(new Set(["none", "low", "medium", "high", "xhigh"]))).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });

    const [model] = processModels([
      {
        id: "gpt-5.4-low",
        name: "GPT 5.4 Low",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: "gpt-5.4-high",
        name: "GPT 5.4 High",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: "gpt-5.4-max",
        name: "GPT 5.4 Max",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ]);
    expect(model).toBeDefined();
    if (model === undefined) throw new Error("processModels returned no model");
    const config = modelConfig(model);
    expect(config.reasoning).toBe(true);
    expect(config.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
    expect(
      getSupportedThinkingLevels({
        ...config,
        api: "cursor-native",
        provider: "cursor",
        baseUrl: "https://agent.cursor.sh",
      }),
    ).toEqual(["low", "high", "max"]);
  });

  it("parses and formats dashboard and Connect usage", async () => {
    const summary = parseCursorUsageSummary({
      billingCycleStart: "2026-04-02T14:11:55.000Z",
      billingCycleEnd: "2026-05-02T14:11:55.000Z",
      membershipType: "Pro",
      limitType: "individual",
      individualUsage: {
        plan: {
          enabled: true,
          used: 40,
          limit: 100,
          remaining: 60,
          totalPercentUsed: 40,
          autoPercentUsed: 35,
          apiPercentUsed: 45,
        },
        onDemand: { enabled: true, used: 1234 },
      },
    });
    const output = formatCursorUsage(summary);
    expect(output).toMatch(/Usage • Pro/);
    expect(output).toMatch(/Category\s+Current\s+Usage/);
    expect(output).toMatch(/Included\s+40% used/);
    expect(output).toMatch(/Auto\s+35% used/);
    expect(output).toMatch(/API\s+45% used/);
    expect(output).toMatch(/View in dashboard: cursor\.com\/dashboard\?tab=usage/);
    expect(() => parseCursorUsageSummary(null)).toThrow(/invalid response/);

    const connectSummary = parseConnectPeriodUsage({
      billingCycleStart: "1783190438000",
      billingCycleEnd: "1785868838000",
      planUsage: {
        includedSpend: 2000,
        limit: 2000,
        totalPercentUsed: 12.72,
        autoPercentUsed: 12,
        apiPercentUsed: 14,
      },
      spendLimitUsage: { limitType: "user" },
    });
    const connectOutput = formatCursorUsage(connectSummary);
    expect(connectOutput).toMatch(/Usage • Pro/);
    expect(connectOutput).toMatch(/Included\s+13% used/);
    expect(connectOutput).toMatch(/Auto\s+12% used/);
    expect(connectOutput).toMatch(/API\s+14% used/);
    await expect(getCursorUsageSummary(undefined, "")).rejects.toThrow(
      /Not logged in to Cursor\. Please log in with Cursor CLI/,
    );
  });
});
