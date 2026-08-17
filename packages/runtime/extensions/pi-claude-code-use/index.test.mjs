import assert from "node:assert/strict";
import test from "node:test";

import { _test } from "./extensions/index.ts";

test("Anthropic OAuth adaptation recognizes Multi-Pass account providers", () => {
  assert.equal(_test.isAnthropicProvider("anthropic"), true);
  assert.equal(_test.isAnthropicProvider("anthropic-2"), true);
  assert.equal(_test.isAnthropicProvider("anthropic-3"), true);
  assert.equal(_test.isAnthropicProvider("anthropic-12"), true);
});

test("Anthropic OAuth adaptation rejects unrelated and ambiguous providers", () => {
  assert.equal(_test.isAnthropicProvider(undefined), false);
  assert.equal(_test.isAnthropicProvider("anthropic-proxy"), false);
  assert.equal(_test.isAnthropicProvider("anthropic-3-extra"), false);
  assert.equal(_test.isAnthropicProvider("openai-codex-3"), false);
});
