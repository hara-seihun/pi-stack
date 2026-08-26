import { readFileSync } from "node:fs";

/**
 * The account ids a runtime can actually authenticate: the keys of its
 * credential stores. Which runtime may spend an account is exactly this
 * fact — the fleet's stores are the central shared-Codex file beside the
 * ledger plus the orchestrator user's own auth.json, and an interactive pi
 * session's store is its own agent dir's auth.json.
 *
 * An unreadable or absent store contributes nothing rather than failing:
 * the caller is asking "what can I spend", and a store it cannot read is a
 * store it cannot spend from.
 */
export function credentialedAccountIds(storePaths: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const path of storePaths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const key of Object.keys(parsed)) ids.add(key);
  }
  return ids;
}
