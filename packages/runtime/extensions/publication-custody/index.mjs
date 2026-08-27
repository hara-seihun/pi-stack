const GH_PR_CHECKS_WATCH = /\bgh\s+pr\s+checks\b[^\n;&|]*(?:--watch(?:\s|=|$)|--watch-interval(?:\s|=|$))/iu;
const GH_RUN_WATCH = /\bgh\s+run\s+watch(?:\s|$)/iu;
const SHELL_WATCH = /(?:^|[;&|\n]\s*)watch(?:\s+-(?:n|d|g|t|x|b|e)\s*\S+)*\s+[^\n;&|]*\bgh\s+(?:pr\s+checks|run\s+(?:list|view))/iu;
const GH_STATUS = /\bgh\s+(?:pr\s+checks|run\s+(?:list|view)|api\b[^\n]*(?:actions\/runs|check-runs|check-suites))/iu;
const POLLING_LOOP = /\b(?:while|until)\b[\s\S]{0,1500}\bgh\s+(?:pr\s+checks|run\s+(?:list|view)|api\b[^\n]*(?:actions\/runs|check-runs|check-suites))[\s\S]{0,1500}\bsleep\b/iu;
const DELAYED_RECHECK = /\bsleep\s+(?:\d+|\$\{?\w+\}?)[^\n;]*(?:;|&&|\n)[\s\S]{0,500}\bgh\s+(?:pr\s+checks|run\s+(?:list|view)|api\b[^\n]*(?:actions\/runs|check-runs|check-suites))/iu;

export const PUBLICATION_CUSTODY_RULE =
  "After a repository's durable publication handoff acknowledges an immutable commit, stop the originating run. " +
  "Do not poll CI, watch pull-request checks, wait for merge or deployment, or repeat receipt checks. " +
  "The publication worker owns those phases and creates repair work with diagnostics if they fail.";

export function publicationPollingReason(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  const polling =
    GH_PR_CHECKS_WATCH.test(command) ||
    GH_RUN_WATCH.test(command) ||
    SHELL_WATCH.test(command) ||
    POLLING_LOOP.test(command) ||
    (GH_STATUS.test(command) && DELAYED_RECHECK.test(command));
  return polling
    ? `This command keeps the model session alive to poll publication. ${PUBLICATION_CUSTODY_RULE}`
    : null;
}

export function registerPublicationCustody(pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    const reason = publicationPollingReason(event.input?.command);
    return reason === null ? undefined : { block: true, reason };
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(PUBLICATION_CUSTODY_RULE)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${PUBLICATION_CUSTODY_RULE}` };
  });
}

export default function (pi) {
  registerPublicationCustody(pi);
}
