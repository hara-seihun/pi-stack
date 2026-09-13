import type { Store } from "../store.js";
import { allowsAccountUse } from "../domain.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";

export function eligibleInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>()) {
  return store.accounts().filter(account => account.provider === family
    && allowsAccountUse(account, "interactive") && !exclude.has(account.id)
    && (!account.cooldownUntil || account.cooldownUntil <= Date.now()) && auth?.has(account.id));
}

export function chooseInteractiveAccount(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>()) {
  const spent = (id: string) => Math.max(0, ...store.latestMeters(id).map(meter => Number(meter.used_percent)));
  return eligibleInteractiveAccounts(store, auth, family, exclude)
    .sort((a, b) => spent(a.id) - spent(b.id)
      || store.activeLeases(a.id).length - store.activeLeases(b.id).length || a.id.localeCompare(b.id))[0];
}
