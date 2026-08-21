export const MAX_TIMEOUT_SECONDS = 1800;

export const RULE =
  "Every bash tool call must pass an explicit `timeout` of at most 1800 seconds (30 minutes); " +
  "calls with no timeout or a larger one are blocked before they run. " +
  "Work that genuinely runs longer belongs in the background — start it detached " +
  "(`systemd-run --user --unit=<name>`, or `nohup … > log 2>&1 &`) and poll its log or status " +
  "with short bounded calls.";

/** Reason this timeout is refused, or null when it is acceptable. */
export function checkBashTimeout(timeout) {
  if (timeout === undefined || timeout === null) {
    return `bash was called without a timeout. ${RULE}`;
  }
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return `bash was called with an invalid timeout (${timeout}). ${RULE}`;
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    return `bash was called with a ${timeout}s timeout, past the ${MAX_TIMEOUT_SECONDS}s cap. ${RULE}`;
  }
  return null;
}

export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    const reason = checkBashTimeout(event.input?.timeout);
    return reason === null ? undefined : { block: true, reason };
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(RULE)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${RULE}` };
  });
}
