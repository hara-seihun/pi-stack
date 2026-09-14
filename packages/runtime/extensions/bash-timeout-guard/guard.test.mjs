import assert from "node:assert/strict";
import test from "node:test";
import {
  INTERACTIVE_MAX_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
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
const ui = { hasUI: true };
const fleet = {
  PI_BASH_TIMEOUT_MAX_SECONDS: "55",
  PI_BASH_TIMEOUT_CONTEXT: "This shared runner has the same ceiling.",
};

test("the environment selects the timeout and foreground policy", () => {
  assert.equal(timeoutPolicy({}).maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  assert.equal(timeoutPolicy({ PI_BASH_TIMEOUT_MAX_SECONDS: "bad" }).maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
  assert.equal(timeoutPolicy(fleet).maxTimeoutSeconds, 55);
  assert.equal(timeoutPolicy({ PI_BASH_TIMEOUT_MAX_SECONDS: "300" }).maxTimeoutSeconds, 300);
  assert.equal(timeoutPolicy({ PI_BASH_TIMEOUT_MAX_SECONDS: "7200" }).maxTimeoutSeconds, 7200);
  assert.equal(timeoutPolicy(fleet).foregroundOnly, true);
  assert.equal(timeoutPolicy({}).foregroundOnly, true);
});

test("interactive sessions default to thirty minutes and remote settings take precedence", () => {
  assert.equal(timeoutPolicy({}, true).maxTimeoutSeconds, INTERACTIVE_MAX_TIMEOUT_SECONDS);
  assert.equal(timeoutPolicy({ PI_BASH_TIMEOUT_MAX_SECONDS: "7200" }, true).maxTimeoutSeconds, 7200);
  assert.equal(timeoutPolicy(fleet, true).maxTimeoutSeconds, 55);

  const remote = { PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS: "300" };
  assert.equal(timeoutPolicy(remote).maxTimeoutSeconds, 300);
  assert.equal(timeoutPolicy(remote, true).maxTimeoutSeconds, 300);
  assert.equal(timeoutPolicy({ ...remote, PI_BASH_TIMEOUT_MAX_SECONDS: "120" }).maxTimeoutSeconds, 300);

  const onToolCall = load().get("tool_call");
  assert.equal(onToolCall(bashCall({ command: "ls", timeout: 1800 }), ui), undefined);
  const blocked = onToolCall(bashCall({ command: "ls", timeout: 1801 }), ui);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /1800s cap/);
  assert.equal(onToolCall(bashCall({ command: "ls", timeout: 1800 }), { hasUI: false }).block, true);
  assert.equal(onToolCall(bashCall({ command: "./census &", timeout: 1800 }), ui).block, true);

  const prompt = load().get("before_agent_start")({ systemPrompt: "base" }, ui).systemPrompt;
  assert.match(prompt, /1800 seconds \(30 minutes\)/);
});

test("only bounded positive timeouts are accepted", () => {
  const policy = timeoutPolicy({});
  assert.equal(checkBashTimeout(1, policy), null);
  assert.equal(checkBashTimeout(MAX_TIMEOUT_SECONDS, policy), null);
  for (const bad of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60", MAX_TIMEOUT_SECONDS + 1]) {
    assert.match(checkBashTimeout(bad, policy) ?? "", /timeout/, `expected ${String(bad)} to be refused`);
  }
});

test("fleet sessions have a hard ceiling below one minute", () => {
  const onToolCall = load(fleet).get("tool_call");
  assert.equal(
    onToolCall(bashCall({ command: "ls", timeout: 55 })),
    undefined,
  );
  const blocked = onToolCall(bashCall({ command: "ls", timeout: 56 }));
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /55s cap/);
  assert.match(blocked.reason, /same ceiling/);
});

test("bash calls without an acceptable timeout are blocked, others run", () => {
  const onToolCall = load().get("tool_call");
  assert.deepEqual(onToolCall(bashCall({ command: "ls", timeout: 55 })), undefined);
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
    "nohup ./shards & wait",
    'bash -c "nohup ./census > out 2>&1"',
    "cat <<EOF > note\nplain text\nEOF\n./census &",
    "./census &\n",
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
    "for i in $(seq 8); do ./shard $i & done; wait",
    "./left & ./right & wait; cat left.out right.out",
    "cat report.md",
    "git commit -m 'batch the census'",
    // Heredoc bodies are data: source written through them is not shell in this session.
    "cat > sub.c <<EOF\nfor (int e = P - 2; e; e >>= 1) { if (e & 1) r = r * b % P; }\nEOF\ngcc sub.c",
    "cat <<'PY' > s.py\nos.system('nohup ./census &')\nPY",
    "cat <<-EOF > f\n\ta & b\n\tEOF",
    // `&` as bitwise AND, in arithmetic or in another language's syntax.
    "x=$((mask & 1)); echo $x",
    "awk '{ print $1 }' f | python3 -c 'import sys; print(sum(int(v)&3 for v in sys.stdin))'",
  ];
  for (const command of foreground) {
    assert.equal(findDetachment(command), null, `expected no detachment in: ${command}`);
  }
});

test("detachment is refused in every session, and refused kindly", () => {
  const interactivePolicy = timeoutPolicy({});
  assert.match(checkBashCommand("nohup ./census &", interactivePolicy), /`nohup`/);

  const reason = checkBashCommand("nohup ./census &", timeoutPolicy(fleet));
  assert.match(reason, /`nohup`/);
  assert.match(reason, /shared runner/);
  assert.match(reason, /checkpoints/);
  assert.doesNotMatch(reason, /forbidden|violation|punish/i);

  const onToolCall = load(fleet).get("tool_call");
  const blocked = onToolCall(bashCall({ command: "./census &", timeout: 55 }));
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
  assert.match(orchestratorPrompt, /55 seconds/);
  assert.match(orchestratorPrompt, /same ceiling/);
  assert.match(orchestratorPrompt, /foreground/);
  assert.match(interactivePrompt, /55 seconds/);
  assert.equal(orchestratorHandler({ systemPrompt: orchestratorPrompt }), undefined);
});

test("systemd scopes stay foreground but service launches and no-block still detach", () => {
  assert.equal(findDetachment("systemd-run --user --scope --quiet --unit=proof true"), null);
  assert.equal(findDetachment("systemd-run --user --unit=proof true"), "`systemd-run`");
  assert.equal(findDetachment("systemd-run --scope --no-block true"), "`systemd-run`");
  assert.equal(findDetachment("systemd-run echo --scope"), "`systemd-run`");
});
