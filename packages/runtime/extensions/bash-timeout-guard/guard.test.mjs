import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TIMEOUT_SECONDS,
  ORCHESTRATOR_MAX_TIMEOUT_SECONDS,
  RULE,
  checkBashCommand,
  checkBashTimeout,
  findDetachment,
  registerGuard,
  timeoutPolicy,
} from "./index.mjs";

function load(environment = {}) {
  const handlers = new Map();
  registerGuard({ on: (event, handler) => handlers.set(event, handler) }, environment);
  return handlers;
}

const bashCall = (input) => ({ toolName: "bash", input });
const fleet = { PI_ORCHESTRATOR_ASSIGNED: "1" };

test("the environment selects the fleet or interactive cap", () => {
  assert.equal(timeoutPolicy({}).maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  assert.equal(timeoutPolicy({ PI_ORCHESTRATOR_ASSIGNED: "0" }).maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  assert.equal(timeoutPolicy(fleet).maxTimeoutSeconds, ORCHESTRATOR_MAX_TIMEOUT_SECONDS);
  assert.equal(timeoutPolicy(fleet).foregroundOnly, true);
  assert.equal(timeoutPolicy({}).foregroundOnly, false);
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
  const onToolCall = load(fleet).get("tool_call");
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

test("every way of outliving the session is recognised", () => {
  const detached = [
    "nohup ./census > out.log 2>&1 &",
    "OMP_NUM_THREADS=32 nohup ./search --all > out 2>err",
    "setsid ./search --all",
    "./search & disown",
    "systemd-run --user --unit=census ./census",
    "tmux new -d -s census ./census",
    "screen -dmS census ./census",
    "echo ./census | at now + 1 minute",
    "crontab -e",
    "./census &",
    "cd /tmp/work && ./census --batch masks.txt &",
    "python3 solve.py > log 2>&1 & echo started",
    "bash -lc './census --batch masks.txt > out 2>err &'",
    'bash -c "nohup ./census > out 2>&1"',
  ];
  for (const command of detached) {
    assert.notEqual(findDetachment(command), null, `expected detachment in: ${command}`);
  }
});

test("ordinary shell punctuation is not mistaken for detachment", () => {
  const foreground = [
    "./census --batch masks.txt > out 2>&1",
    "make -j32 && ./census",
    "grep -c . out || echo empty",
    "sed 's/x/&y/' in > out",
    "ls | grep tmux",
    "echo 'run it with nohup later' > note.txt",
    "python3 -c 'print(1 & 2)'",
    "ls /tmp/at",
    "cat report.md",
    "git commit -m 'batch the census'",
  ];
  for (const command of foreground) {
    assert.equal(findDetachment(command), null, `expected no detachment in: ${command}`);
  }
});

test("detachment is refused only in fleet sessions, and refused kindly", () => {
  const interactivePolicy = timeoutPolicy({});
  assert.equal(checkBashCommand("nohup ./census &", interactivePolicy), null);

  const reason = checkBashCommand("nohup ./census &", timeoutPolicy(fleet));
  assert.match(reason, /`nohup`/);
  assert.match(reason, /sharing|shared with dozens/);
  assert.match(reason, /task_complete/);
  assert.doesNotMatch(reason, /forbidden|violation|punish/i);

  const onToolCall = load(fleet).get("tool_call");
  const blocked = onToolCall(bashCall({ command: "./census &", timeout: 60 }));
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /foreground/);
});

test("the matching rule is stated once in the system prompt", () => {
  const interactiveHandler = load().get("before_agent_start");
  const interactivePrompt = interactiveHandler({ systemPrompt: "base" }).systemPrompt;
  assert.ok(interactivePrompt.includes(RULE));
  assert.equal(interactiveHandler({ systemPrompt: interactivePrompt }), undefined);

  const orchestratorHandler = load(fleet).get("before_agent_start");
  const orchestratorPrompt = orchestratorHandler({ systemPrompt: "base" }).systemPrompt;
  assert.match(orchestratorPrompt, /300 seconds \(5 minutes\)/);
  assert.match(orchestratorPrompt, /ceiling/);
  assert.match(orchestratorPrompt, /nohup/);
  assert.doesNotMatch(interactivePrompt, /ceiling/);
  assert.equal(orchestratorHandler({ systemPrompt: orchestratorPrompt }), undefined);
});
