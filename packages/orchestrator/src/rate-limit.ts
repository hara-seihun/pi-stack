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

export const ACCOUNT_COOLDOWN_MS = 10 * 60_000;
