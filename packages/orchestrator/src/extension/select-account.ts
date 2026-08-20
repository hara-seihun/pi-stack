import type { AccountRow } from "../ledger/ledger.js";

/**
 * Interactive account selection: least-used first, round-robin among ties.
 *
 * "Least used" is the provider's own view — the max latest used-percent
 * across the account's meters — so a fresh account (no readings) sorts
 * first and starts earning calibration. Ties (integer percents make them
 * common) break by least-recently-bound, which is what makes this a round
 * robin rather than a pile-on; the final tie-break is the id, for
 * determinism. Cooling and expired accounts are skipped entirely, as are
 * orchestrator-only accounts. Shared accounts remain eligible because their
 * OAuth credential lives in the central cross-process store.
 *
 * Selection happens once per session: sessions stay sticky to their account
 * because provider-side prompt caches are per-account, and a mid-session
 * switch throws that cache away. The one exception is failover, which passes
 * `exclude` to move off a failing account.
 */
export function pickAccount(
  accounts: readonly AccountRow[],
  family: string,
  now: number,
  usedPercent: (accountId: string) => number | undefined,
  exclude?: ReadonlySet<string>,
): AccountRow | undefined {
  const candidates = accounts
    .filter(
      (a) =>
        (a.shared || a.domain === "interactive") &&
        a.provider === family &&
        !exclude?.has(a.id) &&
        (a.accessUntil === undefined || a.accessUntil > now) &&
        (a.cooldownUntil === undefined || a.cooldownUntil <= now),
    )
    .map((a) => ({ account: a, used: usedPercent(a.id) ?? 0 }))
    .sort(
      (x, y) =>
        x.used - y.used ||
        (x.account.lastBoundAt ?? 0) - (y.account.lastBoundAt ?? 0) ||
        x.account.id.localeCompare(y.account.id),
    );
  return candidates[0]?.account;
}
