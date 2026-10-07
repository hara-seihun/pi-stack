import { expect, test } from "bun:test";
import { capturedContextUsage } from "./context-usage";

function capture(contextUsage: unknown, contextModel = "sol") {
  return { document: JSON.stringify({ contextUsage, contextModel }) };
}

test("current-context usage includes cached prompt tokens without summing history", () => {
  const usage = { tokens: 123456, contextWindow: 272000, percent: 45.38823529411765 };
  expect(capturedContextUsage(capture(usage), "openai-codex/sol")).toEqual(usage);
  expect(capturedContextUsage(capture(usage), "openai-codex-2/sol")).toEqual(usage);
  expect(capturedContextUsage(capture(usage), "anthropic/opus")).toBeUndefined();
});

test("unknown post-compaction count remains unknown, while genuine zero is preserved", () => {
  const unknown = { tokens: null, contextWindow: 272000, percent: null };
  expect(capturedContextUsage(capture(unknown), "openai-codex/sol")).toEqual(unknown);
  const empty = { tokens: 0, contextWindow: 272000, percent: 0 };
  expect(capturedContextUsage(capture(empty), "openai-codex/sol")).toEqual(empty);
  expect(capturedContextUsage(null, "openai-codex/sol")).toBeUndefined();
  expect(capturedContextUsage({ document: "{}" }, "openai-codex/sol")).toBeUndefined();
});

test("invalid native metrics never display a fabricated count", () => {
  for (const usage of [
    { tokens: -1, contextWindow: 272000, percent: 0 },
    { tokens: "42", contextWindow: 272000, percent: 0 },
    { tokens: 42, contextWindow: 0, percent: 0 },
    { tokens: null, contextWindow: 272000, percent: 1 },
    { tokens: 42, contextWindow: 272000, percent: null },
  ]) expect(capturedContextUsage(capture(usage), "openai-codex/sol")).toBeUndefined();
});

test("each immutable capture is decoded once, not on every streamed update", () => {
  let reads = 0;
  const stored = { get document() {
    reads++;
    return JSON.stringify({ contextModel: "sol", contextUsage: { tokens: 42, contextWindow: 272000, percent: 0.015 } });
  } };
  capturedContextUsage(stored, "openai-codex/sol");
  capturedContextUsage(stored, "openai-codex/sol");
  expect(reads).toBe(1);
});
