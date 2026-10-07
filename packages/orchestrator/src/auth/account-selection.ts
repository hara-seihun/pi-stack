import type { Store } from "../store.js";
import { allowsAccountUse } from "../domain.js";
import { modelDrainsMeter } from "../catalog.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";
import { accountModelExcluded } from "./model-entitlement.js";

const METER_MAX_AGE_MS = 90 * 60_000;

function bindingMeters(store: Store, id: string, family: string, model?: string, now = Date.now()) {
  return store.latestMeters(id).filter(meter => (!model || modelDrainsMeter(family, model, meter.meter_id))
    && meter.observed_at <= now + 60_000 && now - meter.observed_at <= METER_MAX_AGE_MS
    && (!meter.reset_at || meter.reset_at > now));
}

/** A fresh exhausted binding window is evidence, unlike an inferred account-wide cooldown. */
export function interactiveQuotaExhausted(store: Store, id: string, family: string, model?: string, now = Date.now()): boolean {
  return bindingMeters(store, id, family, model, now).some(meter => meter.used_percent >= 100);
}

function usableInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude: Set<string>, model?: string) {
  return store.accounts().filter(account => account.provider === family
    && allowsAccountUse(account, "interactive") && !exclude.has(account.id) && auth?.has(account.id)
    && !accountModelExcluded(store, account.id, model)
    && !interactiveQuotaExhausted(store, account.id, family, model));
}

export function eligibleInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>(), model?: string) {
  return usableInteractiveAccounts(store, auth, family, exclude, model)
    .filter(account => !account.cooldownUntil || account.cooldownUntil <= Date.now());
}

export function coolingInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>(), model?: string) {
  return usableInteractiveAccounts(store, auth, family, exclude, model)
    .filter(account => account.cooldownUntil && account.cooldownUntil > Date.now())
    .sort((a, b) => a.cooldownUntil! - b.cooldownUntil! || a.id.localeCompare(b.id));
}

/** Admission can probe inferred cooldowns, but never fresh exhausted model quota.
 * Failover callers exclude the entire refused round, not just its latest account. */
export function chooseInteractiveAccount(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>(), { includeCooling = false, model, live = false }: { includeCooling?: boolean; model?: string; live?: boolean } = {}) {
  const spent = (id: string) => Math.max(0, ...bindingMeters(store, id, family, model).map(meter => Number(meter.used_percent)));
  const load = (id: string) => store.activeLeases(id).length;
  const eligible = eligibleInteractiveAccounts(store, auth, family, exclude, model)
    .sort((a, b) => (live ? load(a.id) - load(b.id) || spent(a.id) - spent(b.id) : spent(a.id) - spent(b.id) || load(a.id) - load(b.id))
      || a.id.localeCompare(b.id))[0];
  if (eligible || !includeCooling) return eligible;
  return coolingInteractiveAccounts(store, auth, family, exclude, model)[0];
}

/** Reconciliation reads evidence, never submits a model request to test capacity. */
export function interactiveRetryAvailability(store: Store, auth: SharedOAuthAuth | undefined, family: string, model: string, now = Date.now()): { available: boolean; retryAt: number } {
  const accounts = store.accounts().filter(account => account.provider === family && allowsAccountUse(account, "interactive") && auth?.has(account.id)
    && !accountModelExcluded(store, account.id, model, now));
  const times = accounts.map(account => Math.max(now, account.cooldownUntil ?? now,
    ...bindingMeters(store, account.id, family, model, now).filter(meter => meter.used_percent >= 100)
      .map(meter => meter.reset_at ?? now + METER_MAX_AGE_MS)));
  return { available: times.some(time => time <= now), retryAt: times.length ? Math.min(...times) : now + 60_000 };
}
