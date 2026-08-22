export const MAX_TIMEOUT_SECONDS = 1800;
export const ORCHESTRATOR_MAX_TIMEOUT_SECONDS = 300;

export function timeoutPolicy(environment = process.env) {
  const orchestrator = environment.PI_ORCHESTRATOR_ASSIGNED === "1";
  const maxTimeoutSeconds = orchestrator
    ? ORCHESTRATOR_MAX_TIMEOUT_SECONDS
    : MAX_TIMEOUT_SECONDS;
  const duration = orchestrator ? "5 minutes" : "30 minutes";
  const scope = orchestrator ? " in this orchestrator-hosted session" : "";
  const aim = orchestrator
    ? " Five minutes is the ceiling, not the target: aim to keep commands under a minute by " +
      "shrinking the instance, pruning the search space, or making the code faster, rather than " +
      "waiting out a census that was written to run long."
    : "";
  const rule =
    `Every bash tool call${scope} must pass an explicit \`timeout\` of at most ` +
    `${maxTimeoutSeconds} seconds (${duration}); calls with no timeout or a larger one are ` +
    "blocked before they run. Work that genuinely runs longer belongs in the background. " +
    "Start it detached (`systemd-run --user --unit=<name>`, or `nohup … > log 2>&1 &`) and " +
    `poll its log or status with short bounded calls.${aim}`;
  return { maxTimeoutSeconds, rule };
}

export const RULE = timeoutPolicy({}).rule;

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

export function registerGuard(pi, environment = process.env) {
  const policy = timeoutPolicy(environment);

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    const reason = checkBashTimeout(event.input?.timeout, policy);
    return reason === null ? undefined : { block: true, reason };
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(policy.rule)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${policy.rule}` };
  });
}

export default function (pi) {
  registerGuard(pi);
}
