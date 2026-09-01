import assert from "node:assert/strict";
import test from "node:test";

import {
  applyClaudeCodeHeaders,
  CLAUDE_CODE_USER_AGENT,
  CLAUDE_CODE_VERSION,
  isAnthropicProvider,
} from "./extensions/provider.js";

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

test("Anthropic OAuth requests advertise a supported Claude Code version", () => {
  assert.match(CLAUDE_CODE_VERSION, /^2\.1\.\d+$/);
  assert.equal(CLAUDE_CODE_USER_AGENT, `claude-cli/${CLAUDE_CODE_VERSION}`);

  const headers = {
    authorization: "Bearer test",
    "User-Agent": "claude-cli/2.1.75",
    "user-agent": "claude-cli/2.1.75",
    "x-app": "cli",
  };
  applyClaudeCodeHeaders(headers);

  assert.deepEqual(headers, {
    authorization: "Bearer test",
    "User-Agent": null,
    "user-agent": "claude-cli/2.1.257",
    "x-app": "cli",
  });
});
