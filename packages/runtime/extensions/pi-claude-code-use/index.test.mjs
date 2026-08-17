import assert from "node:assert/strict";
import test from "node:test";

import { isAnthropicProvider } from "./extensions/provider.js";

test("Anthropic OAuth adaptation recognizes Multi-Pass account providers", () => {
  assert.equal(isAnthropicProvider("anthropic"), true);
  assert.equal(isAnthropicProvider("anthropic-2"), true);
  assert.equal(isAnthropicProvider("anthropic-3"), true);
  assert.equal(isAnthropicProvider("anthropic-12"), true);
});

test("Anthropic OAuth adaptation rejects unrelated and ambiguous providers", () => {
  assert.equal(isAnthropicProvider(undefined), false);
  assert.equal(isAnthropicProvider("anthropic-proxy"), false);
  assert.equal(isAnthropicProvider("anthropic-3-extra"), false);
  assert.equal(isAnthropicProvider("openai-codex-3"), false);
});
