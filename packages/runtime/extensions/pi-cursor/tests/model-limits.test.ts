import { describe, expect, it } from "vitest";
import {
  inferCursorContextWindow,
  inferCursorMaxOutputTokens,
} from "../src/models/limits.js";
import { FALLBACK_MODELS } from "../src/models/parameterized.js";

describe("bundled fallback catalog", () => {
  // The catalog is a snapshot of a live discovery response and had drifted: every
  // "1M" Claude row claimed a 200K window. Both columns are derived now, so this
  // guards the derivation rather than the file.
  it("derives both limit columns from the model id and name", () => {
    for (const model of FALLBACK_MODELS) {
      expect(model.contextWindow).toBe(inferCursorContextWindow(model.id, model.name));
      expect(model.maxTokens).toBe(inferCursorMaxOutputTokens(model.id, model.name));
    }
  });

  it("reports the full window for the 1M Claude rows", () => {
    const oneMillion = FALLBACK_MODELS.filter((m) => /\b1M\b/.test(m.name));
    expect(oneMillion.length).toBeGreaterThan(0);
    for (const model of oneMillion) expect(model.contextWindow).toBe(1_000_000);
  });
});
