/**
 * One vocabulary for provider failure across every surface that sees one:
 * interactive routing failover, runner-side classification of orchestrator
 * runs, and the host deciding whether a session waits out a bad turn or
 * dies of it. Three questions are asked of an error message here — is the
 * account out of capacity, is its credential broken, and is this condition
 * ever going to clear — and each answer has exactly one implementation.
 */

const RATE_LIMIT_PATTERNS = [
  /usage.?limit/i,
  /rate.?limit/i,
  /limit.*reached/i,
  /too many requests/i,
  /overloaded/i,
  /capacity/i,
  /\b429\b/,
  /quota/i,
  // Anthropic bills third-party API traffic against a purchased extra-usage
  // balance rather than the plan windows its meters report, and refuses with
  // a 400 once that balance is empty ("You're out of extra usage", "Third-party
  // apps now draw from your extra usage"). Nothing is wrong with the request or
  // the credential — the account is out of capacity while its plan meters still
  // read low — so it has to cool the account and let the wave rotate onto a
  // sibling. Read as an ordinary 400 it did the opposite: on 2026-08-29 the
  // broker relaunched the Cayley lane onto the same empty account six times in
  // eighteen minutes and charged each failure to the task's circuit breaker.
  /extra usage/i,
];

export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}

/**
 * A 429 that reported no exhausted window at all. Providers throttle bursts
 * with the same status they use for plan limits, and a burst clears in
 * seconds, so this is short on purpose: a wave of parallel sessions that
 * briefly outruns an endpoint should cost the account the next minute, not
 * the next ten. On 2026-09-15 the ten-minute reading took four Codex accounts
 * out within five minutes and left the machine with no account to start a
 * session on.
 */
export const DEFAULT_THROTTLE_COOLDOWN_MS = 60_000;

/**
 * A refusal that named an empty allowance rather than a busy endpoint. The
 * window it belongs to is usually hours long, so the next minute will not
 * refill it and retrying that soon just burns turns.
 */
export const PLAN_LIMIT_COOLDOWN_MS = 10 * 60_000;

const PLAN_LIMIT_PATTERNS = [
  /usage.?limit/i,
  /limit.*reached/i,
  /quota/i,
  /extra usage/i,
];

/**
 * Cooldown scaled to the limit class the provider named. A transient 429
 * clears in seconds, but a monthly spend ceiling will still be exhausted ten
 * minutes from now — retrying it every cooldown burns a failed turn per task
 * wave for the rest of the month. Long classes still expire (limits get
 * raised, windows roll over), just on the cadence of the window itself.
 *
 * A named window beats everything else: a provider that says "weekly" is
 * reporting an empty window whatever its usual 429s mean. `throttleCooldownMs`
 * lets a caller that knows its endpoint's burst behaviour override the
 * unnamed case.
 */
export function rateLimitCooldownMs(
  message: string,
  throttleCooldownMs: number = DEFAULT_THROTTLE_COOLDOWN_MS,
): number {
  if (/monthly|per.month|spend.?limit/i.test(message)) return 24 * 60 * 60_000;
  if (/weekly|per.week|seven.?day|7.?day/i.test(message)) return 6 * 60 * 60_000;
  if (PLAN_LIMIT_PATTERNS.some((p) => p.test(message))) return PLAN_LIMIT_COOLDOWN_MS;
  return throttleCooldownMs;
}

const CREDENTIAL_PATTERNS = [
  /no api key found/i,
  /has no shared codex oauth credential/i,
  /oauth refresh failed/i,
  /credential store modify failed/i,
  /\b401\b|unauthorized|invalid[_ ]?(api[_ ]?key|token|grant)/i,
  // OpenAI refuses a token its auth session no longer backs with "Provided
  // authentication token is expired." and no status code in the text. Read as
  // an unclassified error it looked like weather, so sessions sat retrying a
  // credential that would never work again (2026-09-09, the `openai-codex`
  // account).
  /(authentication |access |bearer )?token (is |has )?expired|expired (authentication |access |bearer )?token/i,
];

/**
 * The provider rejected the credential itself, so a fresh access token is
 * worth trying before the account is written off. Distinguished from the
 * wider credential class, which includes a store this process cannot read
 * and a refresh that already failed — refreshing again answers neither.
 */
const REJECTED_TOKEN_PATTERNS = [
  /\b401\b/,
  /unauthorized/i,
  /invalid[_ ]?(token|grant)/i,
  /(authentication |access |bearer )?token (is |has )?expired|expired (authentication |access |bearer )?token/i,
];

export function isRejectedTokenError(message: string): boolean {
  if (/oauth refresh failed/i.test(message)) return false;
  return REJECTED_TOKEN_PATTERNS.some((p) => p.test(message));
}

/**
 * The failure will be identical on the next attempt, so waiting for it is
 * waiting for nothing. These are defects in the launch or the request — a
 * model that does not exist, an account that cannot serve it, a request the
 * provider rejects on its merits — and the run should end so the ledger
 * records why. Everything else is treated as weather: a session rides it
 * out on backoff rather than dying of it, because the alternative throws
 * away however many hours of context the agent had built.
 */
const PERMANENT_PATTERNS = [
  /unknown model/i,
  /cannot alias/i,
  /\b400\b|\b404\b/,
  /invalid[_ ]?request|malformed|unsupported|not supported/i,
  /does not exist|no such model/i,
  /opening probe failed/i,
];

export function isPermanentError(message: string): boolean {
  return PERMANENT_PATTERNS.some((p) => p.test(message));
}

/** A provider retired, renamed, or cannot serve the configured model. This is
 * launch configuration, not evidence that the lane's task is broken. Keep it
 * distinct from generic permanent request failures so a stale model cannot
 * trip every task's circuit breaker. */
const MODEL_CONFIGURATION_PATTERNS = [
  /unknown model|no such model|model not found|cannot alias/i,
  /model.{0,200}(does not exist|retired|unavailable|testing period)/is,
  /\b404\b.{0,500}\bmodel\b|\bmodel\b.{0,500}\b404\b/is,
];

export function isModelConfigurationError(message: string): boolean {
  return MODEL_CONFIGURATION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The account cannot authenticate at all: a missing, shadowed, or rejected
 * credential. It is a property of the account, never of the task the run
 * carried, so it must cool the account rather than count toward a task's
 * circuit breaker — an unauthenticated account otherwise trips every task it
 * touches and stops the fleet (observed 2026-08-20, when a leftover per-user
 * Codex credential shadowed shared custody).
 */
export function isCredentialError(message: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => p.test(message));
}

/** Long enough that a broken account stops eating waves, short enough that a
 * repaired credential returns without operator action. */
export const CREDENTIAL_COOLDOWN_MS = 30 * 60_000;
