import assert from "node:assert/strict";
import test from "node:test";
import register, { MAX_TIMEOUT_SECONDS, RULE, checkBashTimeout } from "./index.mjs";

function load() {
  const handlers = new Map();
  register({ on: (event, handler) => handlers.set(event, handler) });
  return handlers;
}

const bashCall = (input) => ({ toolName: "bash", input });

test("only bounded positive timeouts are accepted", () => {
  assert.equal(checkBashTimeout(1), null);
  assert.equal(checkBashTimeout(MAX_TIMEOUT_SECONDS), null);
  for (const bad of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", MAX_TIMEOUT_SECONDS + 1]) {
    assert.match(checkBashTimeout(bad) ?? "", /timeout/, `expected ${String(bad)} to be refused`);
  }
});

test("bash calls without an acceptable timeout are blocked, others run", () => {
  const onToolCall = load().get("tool_call");
  assert.deepEqual(onToolCall(bashCall({ command: "ls", timeout: 60 })), undefined);
  assert.equal(onToolCall(bashCall({ command: "ls" })).block, true);
  assert.equal(onToolCall(bashCall({ command: "ls", timeout: 3600 })).block, true);
  assert.equal(onToolCall({ toolName: "read", input: { path: "x" } }), undefined);
});

test("the rule is stated once in the system prompt", () => {
  const onBeforeAgentStart = load().get("before_agent_start");
  const first = onBeforeAgentStart({ systemPrompt: "base" }).systemPrompt;
  assert.ok(first.includes(RULE));
  assert.equal(onBeforeAgentStart({ systemPrompt: first }), undefined);
});
