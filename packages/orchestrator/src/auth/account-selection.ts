import type { Store } from "../store.js";
import { allowsAccountUse } from "../domain.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";

/** Every account this family could serve a session from: right provider, allowed
 * for interactive use, not excluded by the caller, and holding a credential this
 * process can resolve. Cooldown is deliberately not part of it — a cooldown is
 * this machine's guess about capacity, not a property of the account. */
function usableInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude: Set<string>) {
  return store.accounts().filter(account => account.provider === family
    && allowsAccountUse(account, "interactive") && !exclude.has(account.id) && auth?.has(account.id));
}

export function eligibleInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>()) {
  return usableInteractiveAccounts(store, auth, family, exclude)
    .filter(account => !account.cooldownUntil || account.cooldownUntil <= Date.now());
}

/** Accounts held back only by a cooldown, nearest to expiry first. */
export function coolingInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>()) {
  return usableInteractiveAccounts(store, auth, family, exclude)
    .filter(account => account.cooldownUntil && account.cooldownUntil > Date.now())
    .sort((a, b) => a.cooldownUntil! - b.cooldownUntil! || a.id.localeCompare(b.id));
}

/**
 * `includeCooling` admits a session onto a cooling account when nothing else is
 * free, nearest expiry first. Cooldowns are inferred from an error message and
 * applied to the whole account, so a single throttled wave can cover the pool
 * and leave a person unable to open a thread at all — which is what happened on
 * 2026-09-15, when four Codex accounts cooled within five minutes and every new
 * session was refused outright. The provider is the authority on whether a
 * request is allowed; guessing on its behalf is worth an ordering preference,
 * never a refusal. Selection after a real rate-limit failover leaves it off, so
 * a turn that just lost an account still rotates away from the cooling ones.
 */
export function chooseInteractiveAccount(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>(), { includeCooling = false } = {}) {
  const spent = (id: string) => Math.max(0, ...store.latestMeters(id).map(meter => Number(meter.used_percent)));
  const eligible = eligibleInteractiveAccounts(store, auth, family, exclude)
    .sort((a, b) => spent(a.id) - spent(b.id)
      || store.activeLeases(a.id).length - store.activeLeases(b.id).length || a.id.localeCompare(b.id))[0];
  if (eligible || !includeCooling) return eligible;
  return coolingInteractiveAccounts(store, auth, family, exclude)[0];
}
