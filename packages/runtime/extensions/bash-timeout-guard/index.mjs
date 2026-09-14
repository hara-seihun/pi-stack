export const MAX_TIMEOUT_SECONDS = 55;
export const INTERACTIVE_MAX_TIMEOUT_SECONDS = 1800;

function positiveSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function describeSeconds(seconds) {
  return seconds % 60 === 0 && seconds > 60 ? `${seconds} seconds (${seconds / 60} minutes)` : `${seconds} seconds`;
}

function policyRule(maxTimeoutSeconds, context) {
  const reason = context ? ` ${context.trim()}` : "";
  return `Every bash tool call must pass an explicit timeout of at most ${describeSeconds(maxTimeoutSeconds)}. Commands that detach work from the session are blocked; keep the work in the foreground.${reason}`;
}

const detachmentRefusal = (found, policy) =>
  `That command detaches work from the session (${found}), while this installation requires foreground work. ` +
  `Keep the operation inside the bounded tool call, split it into checkpoints, or report that it does not fit. ` +
  policy.rule;

/**
 * A session with a UI attached defaults to thirty minutes. Autonomous sessions
 * default to 55 seconds. Either host setting replaces that default, so operators
 * can raise or lower the limit without changing this extension.
 */
export function timeoutPolicy(environment = process.env, interactive = false) {
  const fallback = interactive ? INTERACTIVE_MAX_TIMEOUT_SECONDS : MAX_TIMEOUT_SECONDS;
  const configured = environment.PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS
    ?? environment.PI_BASH_TIMEOUT_MAX_SECONDS;
  const maxTimeoutSeconds = positiveSeconds(configured, fallback);
  return {
    maxTimeoutSeconds,
    foregroundOnly: true,
    rule: policyRule(maxTimeoutSeconds, environment.PI_BASH_TIMEOUT_CONTEXT),
  };
}

export const RULE = policyRule(MAX_TIMEOUT_SECONDS);

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

/**
 * Heredoc bodies are data, not shell text: a C loop written through `<<EOF` can contain `&`,
 * `nohup`, or anything else without any of it being a command in this session.
 */
function stripHeredocs(command) {
  const lines = command.split("\n");
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    out.push(line);
    const opener = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?(\w+))/.exec(line);
    if (opener === null) continue;
    const delimiter = opener[1] ?? opener[2] ?? opener[3];
    const dashed = line.slice(opener.index).startsWith("<<-");
    index += 1;
    while (index < lines.length) {
      const body = dashed ? lines[index].replace(/^\t+/, "") : lines[index];
      if (body.trimEnd() === delimiter) break;
      index += 1;
    }
  }
  return out.join("\n");
}

/** `$(( … ))` is arithmetic, where `&` is bitwise AND rather than a background operator. */
function stripArithmetic(command) {
  return command.replace(/\$\(\([\s\S]*?\)\)/g, "0");
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
    if (text[index - 1] === ">" || text[index - 1] === "|" || text[index - 1] === "&") continue;
    if (text[index + 1] === ">") {
      index += 1;
      continue;
    }
    // A real background operator terminates a command, so it is followed by end of input,
    // whitespace, or another operator. `e&1` and `x&y` are somebody else's language.
    const next = text[index + 1];
    if (next !== undefined && !/[\s;()|&]/.test(next)) continue;
    return "a trailing `&`";
  }
  return null;
}

/** `bash -c '…'` hides its payload from the scan above, so the payload is scanned too. */
const NESTED_SHELL = /\b(?:ba|z|k|da)?sh\b[^'"\n]*?-[A-Za-z]*c\s+(?:'([^']*)'|"([^"]*)")/g;

export function findDetachment(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const text = unquoted(stripArithmetic(stripHeredocs(command)));
  for (const match of text.matchAll(new RegExp(`${START}systemd-run\\s+([^;|&\\n]*)`, "g"))) {
    const flags = match[1].match(/^(?:--[\w-]+(?:=\S+)?(?:\s+|$))*/)?.[0] ?? "";
    if (!/(?:^|\s)--scope(?:\s|$)/.test(flags) || /(?:^|\s)--no-block(?:\s|$)/.test(flags)) return "`systemd-run`";
  }
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
  return found === null ? null : detachmentRefusal(found, policy);
}

export function registerGuard(pi, environment = process.env) {
  const policyFor = (ctx) => timeoutPolicy(environment, ctx?.hasUI === true);

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const policy = policyFor(ctx);
    const reason =
      checkBashTimeout(event.input?.timeout, policy) ?? checkBashCommand(event.input?.command, policy);
    return reason === null || reason === undefined ? undefined : { block: true, reason };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const policy = policyFor(ctx);
    if (event.systemPrompt.includes(policy.rule)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${policy.rule}` };
  });
}

export default function (pi) {
  registerGuard(pi, globalThis[Symbol.for("pi-stack.session-environment")]?.getStore() ?? process.env);
}
