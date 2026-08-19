import { describe, expect, it } from "vitest";
import { anthropicMeterReadings, baseProvider } from "../src/extension/usage-logger.js";

/** Header fixture copied verbatim from recorded production traffic. */
const PRODUCTION_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-5h-reset": "1787190600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.0",
  "anthropic-ratelimit-unified-7d-reset": "1787209200",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.56",
  "anthropic-ratelimit-unified-7d_oi-reset": "1787209200",
  "anthropic-ratelimit-unified-7d_oi-status": "allowed",
  "anthropic-ratelimit-unified-7d_oi-utilization": "0.46",
  "anthropic-ratelimit-unified-status": "allowed",
  "request-id": "req_011CeCmVRNoVLKHXzTpXyv1t",
};

describe("usage-logger extension", () => {
  it("parses all three anthropic meters from production response headers", () => {
    const readings = anthropicMeterReadings(PRODUCTION_HEADERS, 1_787_000_000_000);
    expect(readings).toEqual([
      {
        meterId: "anthropic-5h",
        reading: { at: 1_787_000_000_000, usedPercent: 0, resetAt: 1_787_190_600_000 },
      },
      {
        meterId: "anthropic-7d",
        reading: { at: 1_787_000_000_000, usedPercent: 56, resetAt: 1_787_209_200_000 },
      },
      {
        meterId: "anthropic-7d_oi",
        reading: { at: 1_787_000_000_000, usedPercent: 46, resetAt: 1_787_209_200_000 },
      },
    ]);
  });

  it("ignores responses without rate-limit headers", () => {
    expect(anthropicMeterReadings({ "request-id": "abc" }, 0)).toEqual([]);
  });

  it("maps provider aliases to base providers for account rows", () => {
    expect(baseProvider("anthropic-3")).toBe("anthropic");
    expect(baseProvider("anthropic")).toBe("anthropic");
    expect(baseProvider("openai-codex")).toBe("openai-codex");
  });
});
