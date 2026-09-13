import { expect, it } from "vitest";
import { anthropicCodexModels, anthropicModels, codexProviderFamily } from "../src/cores/codex-models.js";

it("resolves pooled provider families without admitting unrelated OpenAI-named providers", () => {
  for (const provider of ["openai", "openai-codex", "openai-codex-12"]) expect(codexProviderFamily(provider)).toBe("openai-codex");
  for (const provider of ["anthropic", "anthropic-3"]) expect(codexProviderFamily(provider)).toBe("anthropic");
  for (const provider of ["openai-other", "anthropic-other", "openrouter", ""]) expect(codexProviderFamily(provider)).toBeUndefined();
});

it("uses the Anthropic model catalog and preserves deployed Fable limits and reasoning levels", () => {
  const native = anthropicCodexModels();
  const fable = anthropicModels().find(model => model.id === "claude-fable-5-1")!;
  expect(fable).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000 });
  expect(new Set(native.map(model => model.model)).size).toBe(native.length);
  const efforts = native.find(model => model.model === fable.id)!.supportedReasoningEfforts.map(option => option.reasoningEffort);
  expect(efforts).toEqual(expect.arrayContaining(["high", "xhigh", "max"]));
  expect(efforts).not.toContain("none");
  expect(native.some(model => model.model === "claude-opus-5")).toBe(true);
  expect(native.some(model => model.model.startsWith("gpt-"))).toBe(false);
});
