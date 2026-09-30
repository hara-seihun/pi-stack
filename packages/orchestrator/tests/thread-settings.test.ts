import { expect, test } from "vitest";
import { resolveThreadSettings } from "../src/threads/settings.js";
import { isModelConfigurationError } from "../src/provider-errors.js";

test.each(["openai-codex/missing-model", "openai-codex-8/missing-model", "openai/gpt-6-soul", "anthropic/missing-model"])("rejects nonexistent installed-provider model %s", model => {
  expect(resolveThreadSettings({ model })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});

test.each(["sol", "gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "openai-codex-8/gpt-6.1-sol"])("resolves current Sol %s", model => {
  expect(resolveThreadSettings({ model })).toMatchObject({ ok: true, value: { model: "openai-codex/gpt-6.1-sol" } });
});

test.each(["openai-codex/gpt-6-sol", "openai-codex-8/gpt-6-sol"])("preserves explicit Sol 6 %s", model => {
  expect(resolveThreadSettings({ model })).toMatchObject({ ok: true, value: { model } });
});

test.each(["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna", "anthropic/claude-fable-5-1", "anthropic/claude-sonnet-4-5", "private/local-model"])("retains supported additions and explicit private providers: %s", model => {
  expect(resolveThreadSettings({ model })).toMatchObject({ ok: true, value: { model } });
});

test.each(["cerebras/gpt-oss-120b", "cerebras/qwen-3.8-27b"])("Cerebras %s admits standard only, never silently ignores requested speed", model => {
  expect(resolveThreadSettings({ model, speed: "standard" })).toMatchObject({ ok: true, value: { model, speed: "standard" } });
  for (const speed of ["priority", "ultrafast"] as const) {
    expect(resolveThreadSettings({ model, speed })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("speed") } });
  }
});

test("missing-model startup is a configuration error, account admission and transport are not", () => {
  expect(isModelConfigurationError("Error: Model not found: openai-codex/gpt-6-sol")).toBe(true);
  expect(isModelConfigurationError("Model not found through model broker: openai-codex/gpt-6-sol")).toBe(true);
  expect(isModelConfigurationError("No eligible pooled account for openai-codex/gpt-6-astra.")).toBe(false);
  expect(isModelConfigurationError("Thread runner control timed out")).toBe(false);
});
