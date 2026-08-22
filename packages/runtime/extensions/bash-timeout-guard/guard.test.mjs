import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TIMEOUT_SECONDS,
  ORCHESTRATOR_MAX_TIMEOUT_SECONDS,
  RULE,
  checkBashTimeout,
  registerGuard,
  timeoutPolicy,
} from "./index.mjs";

function load(environment = {}) {
  const handlers = new Map();
  registerGuard({ on: (event, handler) => handlers.set(event, handler) }, environment);
  return handlers;
}

const bashCall = (input) => ({ toolName: "bash", input });

test("the environment selects the fleet or interactive cap", () => {
  assert.equal(timeoutPolicy({}).maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  assert.equal(timeoutPolicy({ PI_ORCHESTRATOR_ASSIGNED: "0" }).maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  assert.equal(
    timeoutPolicy({ PI_ORCHESTRATOR_ASSIGNED: "1" }).maxTimeoutSeconds,
    ORCHESTRATOR_MAX_TIMEOUT_SECONDS,
  );
});

test("only bounded positive timeouts are accepted", () => {
  const policy = timeoutPolicy({});
  assert.equal(checkBashTimeout(1, policy), null);
  assert.equal(checkBashTimeout(MAX_TIMEOUT_SECONDS, policy), null);
  for (const bad of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", MAX_TIMEOUT_SECONDS + 1]) {
    assert.match(checkBashTimeout(bad, policy) ?? "", /timeout/, `expected ${String(bad)} to be refused`);
  }
});

test("orchestrator calls are capped at five minutes", () => {
  const onToolCall = load({ PI_ORCHESTRATOR_ASSIGNED: "1" }).get("tool_call");
  assert.equal(
    onToolCall(bashCall({ command: "ls", timeout: ORCHESTRATOR_MAX_TIMEOUT_SECONDS })),
    undefined,
  );
  const blocked = onToolCall(bashCall({ command: "ls", timeout: ORCHESTRATOR_MAX_TIMEOUT_SECONDS + 1 }));
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /300s cap/);
  assert.match(blocked.reason, /5 minutes/);
});

test("bash calls without an acceptable timeout are blocked, others run", () => {
  const onToolCall = load().get("tool_call");
  assert.deepEqual(onToolCall(bashCall({ command: "ls", timeout: 60 })), undefined);
  assert.equal(onToolCall(bashCall({ command: "ls" })).block, true);
  assert.equal(onToolCall(bashCall({ command: "ls", timeout: 3600 })).block, true);
  assert.equal(onToolCall({ toolName: "read", input: { path: "x" } }), undefined);
});

test("the matching rule is stated once in the system prompt", () => {
  const interactiveHandler = load().get("before_agent_start");
  const interactivePrompt = interactiveHandler({ systemPrompt: "base" }).systemPrompt;
  assert.ok(interactivePrompt.includes(RULE));
  assert.equal(interactiveHandler({ systemPrompt: interactivePrompt }), undefined);

  const orchestratorHandler = load({ PI_ORCHESTRATOR_ASSIGNED: "1" }).get("before_agent_start");
  const orchestratorPrompt = orchestratorHandler({ systemPrompt: "base" }).systemPrompt;
  assert.match(orchestratorPrompt, /300 seconds \(5 minutes\)/);
  assert.match(orchestratorPrompt, /ceiling, not the target/);
  assert.doesNotMatch(interactivePrompt, /ceiling, not the target/);
  assert.equal(orchestratorHandler({ systemPrompt: orchestratorPrompt }), undefined);
});
