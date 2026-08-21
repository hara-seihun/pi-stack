/**
 * One vocabulary for "this account is out of capacity right now" across
 * every surface that sees provider errors: interactive routing failover,
 * and runner-side classification of orchestrator runs. A match cools the
 * account down in the ledger, which both interactive binding and broker
 * admission honour.
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
 * Cooldown scaled to the limit class the provider named. A transient 429
 * clears in minutes, but a monthly spend ceiling will still be exhausted ten
 * minutes from now — retrying it every cooldown burns a failed turn per task
 * wave for the rest of the month. Long classes still expire (limits get
 * raised, windows roll over), just on the cadence of the window itself.
 */
export function rateLimitCooldownMs(message: string): number {
  if (/monthly|per.month|spend.?limit/i.test(message)) return 24 * 60 * 60_000;
  if (/weekly|per.week|seven.?day|7.?day/i.test(message)) return 6 * 60 * 60_000;
  return 10 * 60_000;
}

const CREDENTIAL_PATTERNS = [
  /no api key found/i,
  /has no shared codex oauth credential/i,
  /oauth refresh failed/i,
  /credential store modify failed/i,
  /\b401\b|unauthorized|invalid[_ ]?(api[_ ]?key|token|grant)/i,
];

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
