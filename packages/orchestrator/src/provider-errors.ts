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
];

export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(message));
}

/**
 * A rate-limit error that named no window. Ten minutes suits a plan-metered
 * family, where an unnamed 429 usually means some window is empty and the
 * next minute will not refill it. It is two orders of magnitude too long for
 * a family that throttles bursts instead of metering plans, so those families
 * declare their own class in operator config (`throttleCooldownMs`).
 */
export const DEFAULT_THROTTLE_COOLDOWN_MS = 10 * 60_000;

/**
 * Cooldown scaled to the limit class the provider named. A transient 429
 * clears in minutes, but a monthly spend ceiling will still be exhausted ten
 * minutes from now — retrying it every cooldown burns a failed turn per task
 * wave for the rest of the month. Long classes still expire (limits get
 * raised, windows roll over), just on the cadence of the window itself.
 *
 * A named window beats the family's declared throttle: a provider that says
 * "weekly" is reporting an empty window whatever its usual 429s mean.
 */
export function rateLimitCooldownMs(
  message: string,
  throttleCooldownMs: number = DEFAULT_THROTTLE_COOLDOWN_MS,
): number {
  if (/monthly|per.month|spend.?limit/i.test(message)) return 24 * 60 * 60_000;
  if (/weekly|per.week|seven.?day|7.?day/i.test(message)) return 6 * 60 * 60_000;
  return throttleCooldownMs;
}

/** Resolves the cooldown for an error against the provider family that
 * raised it, so the same 429 text can mean ten minutes on a metered plan and
 * half a minute on a burst-throttled endpoint. */
export type CooldownPolicy = (family: string | undefined, message: string) => number;

/** The policy for a deployment that declares nothing: every family's unnamed
 * 429 is a plan limit. */
export const uniformCooldown: CooldownPolicy = (_family, message) => rateLimitCooldownMs(message);

const CREDENTIAL_PATTERNS = [
  /no api key found/i,
  /has no shared codex oauth credential/i,
  /oauth refresh failed/i,
  /credential store modify failed/i,
  /\b401\b|unauthorized|invalid[_ ]?(api[_ ]?key|token|grant)/i,
];

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
  /unknown model|no such model|cannot alias/i,
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
