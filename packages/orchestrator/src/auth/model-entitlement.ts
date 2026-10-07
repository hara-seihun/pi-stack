import type { Store } from "../store.js";

/**
 * Account-scoped model entitlement. On October 7, 2026 two pooled Codex
 * accounts (openai-codex-11 and -12) began answering `gpt-6.1-sol` and
 * `gpt-6-astra` with "The '<model>' model is not supported when using Codex
 * with a ChatGPT account." while four sibling accounts kept serving both
 * models in the same minutes. The model IDs are real; the refusal belongs to
 * the account/model pair. Thread affinity kept re-admitting the refusing
 * account, so every resumed turn failed identically.
 *
 * A refusal is persisted as negative evidence for exactly that pair. New
 * admission and failover skip the pair until the evidence expires, then one
 * request may observe whether the entitlement returned. Recovery of an
 * execution that already holds an account lease is not filtered here, and no
 * other model or provider is ever substituted.
 */
export const MODEL_UNSUPPORTED_TTL_MS = 6 * 3_600_000;

const PATTERN = /The '([A-Za-z0-9._:-]{1,128})' model is not supported when using Codex with a ChatGPT account/i;
const key = (accountId: string, model: string) => `model-unsupported:${JSON.stringify([accountId, model])}`;

export interface ModelUnsupportedEvidence { readonly at: number; readonly model: string; readonly detail: string }

/** The provider-facing model the account refused, or undefined when the failure is not an entitlement refusal. */
export function accountModelUnsupported(message: string): string | undefined {
  return PATTERN.exec(message)?.[1];
}

/** Records refusal evidence only when the refusal names the model the account was asked for. */
export function recordAccountModelUnsupported(store: Store, accountId: string, requested: string, failure: string, now = Date.now()): boolean {
  const refused = accountModelUnsupported(failure);
  if (!refused || refused !== requested || !store.account(accountId)) return false;
  store.setControl(key(accountId, refused), JSON.stringify({ at: now, model: refused, detail: failure.slice(0, 500) } satisfies ModelUnsupportedEvidence));
  return true;
}

export function modelUnsupportedEvidence(store: Store, accountId: string, model: string, now = Date.now()): ModelUnsupportedEvidence | undefined {
  const raw = store.control(key(accountId, model));
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const evidence = value as Partial<ModelUnsupportedEvidence> | null;
  if (!evidence || typeof evidence.at !== "number" || !Number.isFinite(evidence.at) || evidence.model !== model || typeof evidence.detail !== "string") return undefined;
  const age = now - evidence.at;
  return age >= 0 && age < MODEL_UNSUPPORTED_TTL_MS ? evidence as ModelUnsupportedEvidence : undefined;
}

export function accountModelExcluded(store: Store, accountId: string, model: string | undefined, now = Date.now()): boolean {
  return model !== undefined && modelUnsupportedEvidence(store, accountId, model, now) !== undefined;
}

export function modelUnsupportedReason(evidence: ModelUnsupportedEvidence): string {
  return `model ${evidence.model} not supported on this account since ${new Date(evidence.at).toISOString()}`;
}

/** Actionable terminal error once every account of the family refuses the model: nothing is waiting on capacity. */
export function noEntitledAccountError(provider: string, model: string): string {
  return `${provider}/${model} is not supported on any eligible ${provider} account (provider: model is not supported when using Codex with a ChatGPT account). Choose another model or restore the account entitlement; no other model was substituted.`;
}
