export const MAX_TIMEOUT_SECONDS = 1800;
export const ORCHESTRATOR_MAX_TIMEOUT_SECONDS = 300;

const FLEET_RULE =
  "Every bash tool call in this orchestrator-hosted session must pass an explicit `timeout` of at " +
  "most 300 seconds (5 minutes), and must run in the foreground: calls with no timeout, a larger " +
  "one, or a way of detaching the work (`nohup`, `setsid`, `disown`, `systemd-run`, `tmux`, a " +
  "trailing `&`) are blocked before they run. You are sharing this machine with dozens of other " +
  "agent sessions, so five minutes is the ceiling and under a minute is the target: shrink the " +
  "instance, prune the search space, or make the code faster rather than waiting out a census " +
  "that was written to run long. If the computation genuinely does not fit, that is a fine thing " +
  "to report in `task_complete` rather than something to route around.";

const INTERACTIVE_RULE =
  "Every bash tool call must pass an explicit `timeout` of at most 1800 seconds (30 minutes); " +
  "calls with no timeout or a larger one are blocked before they run. Work that genuinely runs " +
  "longer belongs in the background. Start it detached (`systemd-run --user --unit=<name>`, or " +
  "`nohup … > log 2>&1 &`) and poll its log or status with short bounded calls.";

const FLEET_DETACHMENT_REFUSAL = (found) =>
  `That command detaches work from the session (${found}), and fleet sessions run in the ` +
  "foreground only.\n\n" +
  "I know a five-minute ceiling feels restrictive when the computation is the interesting part " +
  "of the problem. The reason is that this machine genuinely cannot carry long computations: it " +
  "is one small box shared with dozens of other agents working right now, and a detached job " +
  "takes cores away from all of them for as long as it lives. It also outlives the session that " +
  "started it, so by the time it finishes there is usually nobody left holding the question — " +
  "the answer lands in a file in /tmp that no one ever reads.\n\n" +
  "What works instead:\n" +
  "- Make it fit. Shrink the instance, prune the search space, quotient by a symmetry, or make " +
  "the inner loop faster. The order of magnitude is almost always in the algorithm rather than " +
  "in the hardware.\n" +
  "- Take a smaller bite. A partial census, one hard case, or a bound instead of an exhaustive " +
  "check is real progress that the next session can build on.\n" +
  "- Checkpoint. If the search splits, do one chunk per call and write the frontier to a file so " +
  "the next call resumes from it instead of starting over.\n\n" +
  "And if the computation really does need more than a session can hold, say so in your " +
  "`task_complete` report along with what you would run given more room. That is a useful " +
  "result, not a failure.";

export function timeoutPolicy(environment = process.env) {
  const fleet = environment.PI_ORCHESTRATOR_ASSIGNED === "1";
  return {
    maxTimeoutSeconds: fleet ? ORCHESTRATOR_MAX_TIMEOUT_SECONDS : MAX_TIMEOUT_SECONDS,
    foregroundOnly: fleet,
    rule: fleet ? FLEET_RULE : INTERACTIVE_RULE,
  };
}

export const RULE = INTERACTIVE_RULE;

export function checkBashTimeout(timeout, policy = timeoutPolicy()) {
  if (timeout === undefined || timeout === null) {
    return `bash was called without a timeout. ${policy.rule}`;
  }
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return `bash was called with an invalid timeout (${timeout}). ${policy.rule}`;
  }
  if (timeout > policy.maxTimeoutSeconds) {
    return `bash was called with a ${timeout}s timeout, past the ${policy.maxTimeoutSeconds}s cap. ${policy.rule}`;
  }
  return null;
}

/** Quoted spans are removed so a `&` inside `sed 's/x/&/'` is not read as an operator. */
function unquoted(command) {
  let out = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === null) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      out += character;
      continue;
    }
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) quote = null;
  }
  return out;
}

const START = String.raw`(?:^|[;&|(){}\n]|\bthen\b|\bdo\b|\belse\b)\s*(?:\w+=\S*\s+)*(?:(?:env|command|exec|time|xargs)\s+)*`;
const inCommandPosition = (name) => new RegExp(`${START}${name}(?:\\s|$)`);

const DETACHERS = [
  { found: "`nohup`", pattern: inCommandPosition("nohup") },
  { found: "`setsid`", pattern: inCommandPosition("setsid") },
  { found: "`disown`", pattern: inCommandPosition("disown") },
  { found: "`systemd-run`", pattern: inCommandPosition("systemd-run") },
  { found: "`daemonize`", pattern: inCommandPosition("daemonize") },
  { found: "`screen`", pattern: inCommandPosition("screen") },
  { found: "`tmux`", pattern: inCommandPosition("tmux") },
  { found: "`crontab`", pattern: inCommandPosition("crontab") },
  { found: "`batch`", pattern: inCommandPosition("batch") },
  { found: "an `at` job", pattern: new RegExp(`${START}at\\s+(?:now|-f|\\d)`) },
];

function backgroundOperator(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "&") continue;
    if (text[index + 1] === "&") {
      index += 1;
      continue;
    }
    if (text[index - 1] === ">" || text[index - 1] === "|") continue;
    if (text[index + 1] === ">") {
      index += 1;
      continue;
    }
    return "a trailing `&`";
  }
  return null;
}

/** `bash -c '…'` hides its payload from the scan above, so the payload is scanned too. */
const NESTED_SHELL = /\b(?:ba|z|k|da)?sh\b[^'"\n]*?-[A-Za-z]*c\s+(?:'([^']*)'|"([^"]*)")/g;

export function findDetachment(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const text = unquoted(command);
  for (const { found, pattern } of DETACHERS) {
    if (pattern.test(text)) return found;
  }
  // `./part $i & … wait` is parallelism inside the call, not an escape from
  // it: the call still blocks, the cap still applies, and running 32 shards
  // at once is the answer to a job that does not fit, not a way around it.
  const background = /\bwait\b/.test(text) ? null : backgroundOperator(text);
  if (background !== null) return background;
  for (const match of command.matchAll(NESTED_SHELL)) {
    const nested = findDetachment(match[1] ?? match[2] ?? "");
    if (nested !== null) return nested;
  }
  return null;
}

export function checkBashCommand(command, policy = timeoutPolicy()) {
  if (!policy.foregroundOnly) return null;
  const found = findDetachment(command);
  return found === null ? null : FLEET_DETACHMENT_REFUSAL(found);
}

export function registerGuard(pi, environment = process.env) {
  const policy = timeoutPolicy(environment);

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    const reason =
      checkBashTimeout(event.input?.timeout, policy) ?? checkBashCommand(event.input?.command, policy);
    return reason === null || reason === undefined ? undefined : { block: true, reason };
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(policy.rule)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${policy.rule}` };
  });
}

export default function (pi) {
  registerGuard(pi);
}
