import { createHash } from "node:crypto";
import type { Store } from "../store.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";

export const CODEX_CAPABILITY_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 4_000;
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.159.0";
const observationKey = (accountId: string) => `codex-capabilities:${accountId}`;

type CapabilityError = "store-closed" | "credential-unavailable" | "missing-account-id" | "request-failed" | "invalid-response" | "cancelled" | `http-${number}`;
export type CodexCapabilityObservation =
  | { at: number; status: "observed"; models: Record<string, string[]> }
  | { at: number; status: "error"; error: CapabilityError };
export interface CodexTierObservation {
  at: number;
  fresh: boolean;
  supported: boolean | undefined;
  error?: CapabilityError;
}
export type CodexTierResult =
  | { ok: true; value: { accountId: string; model: string; tier: string | undefined } }
  | { ok: false; error: string };

type CacheEntry = { fingerprint: string; observation?: CodexCapabilityObservation; pending?: Promise<CodexCapabilityObservation> };
const caches = new WeakMap<Store, Map<string, CacheEntry>>();

function fresh(at: number): boolean {
  const age = Date.now() - at;
  return age >= 0 && age < CODEX_CAPABILITY_TTL_MS;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseModels(value: unknown): Record<string, string[]> | undefined {
  const models = record(value)?.models;
  if (!Array.isArray(models)) return undefined;
  const result: Record<string, string[]> = Object.create(null);
  const identifier = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(id);
  for (const value of models) {
    const model = record(value);
    if (!identifier(model?.slug) || !Array.isArray(model.service_tiers) || Object.hasOwn(result, model.slug)) return undefined;
    const tiers: string[] = [];
    for (const value of model.service_tiers) {
      const id = record(value)?.id;
      if (!identifier(id)) return undefined;
      tiers.push(id);
    }
    result[model.slug] = tiers;
  }
  return result;
}

function readObservation(store: Store, accountId: string): CodexCapabilityObservation | undefined {
  const raw = store.control(observationKey(accountId));
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const observation = record(value);
  if (typeof observation?.at !== "number" || !Number.isFinite(observation.at)) return undefined;
  if (observation.status === "error" && typeof observation.error === "string"
    && /^(store-closed|credential-unavailable|missing-account-id|request-failed|invalid-response|cancelled|http-\d{3})$/.test(observation.error)) {
    return { at: observation.at, status: "error", error: observation.error as CapabilityError };
  }
  const models = record(observation.models);
  if (observation.status !== "observed" || !models) return undefined;
  const parsed = parseModels({ models: Object.entries(models).map(([slug, tiers]) => ({ slug, service_tiers: Array.isArray(tiers) ? tiers.map(id => ({ id })) : undefined })) });
  return parsed ? { at: observation.at, status: "observed", models: parsed } : undefined;
}

/** Persisted observations are diagnostic evidence, never a cold-start eligibility cache. */
export function readCodexTierObservation(store: Store, accountId: string, model: string, tier: string): CodexTierObservation | undefined {
  const observation = readObservation(store, accountId);
  if (!observation) return undefined;
  return observation.status === "error"
    ? { at: observation.at, fresh: fresh(observation.at), supported: undefined, error: observation.error }
    : { at: observation.at, fresh: fresh(observation.at), supported: observation.models[model]?.includes(tier) ?? false };
}

export function readCodexCapabilities(store: Store, accountId?: string) {
  return store.accounts().filter(account => account.provider === "openai-codex" && (!accountId || account.id === accountId)).map(account => {
    const observation = readObservation(store, account.id);
    return { accountId: account.id, fresh: observation ? fresh(observation.at) : false,
      ...(observation ?? { status: "unknown" as const }),
      ultrafast: observation?.status === "observed" ? Object.fromEntries(Object.entries(observation.models).map(([model, tiers]) => [model, tiers.includes("ultrafast")])) : null };
  });
}

function hasCredential(auth: SharedOAuthAuth | undefined, accountId: string): boolean {
  try { return auth?.has(accountId) ?? false; } catch { return false; }
}

type Attempt<T> = { ok: true; value: T } | { ok: false };
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<Attempt<T>> {
  if (signal.aborted) return { ok: false };
  let onAbort: () => void = () => {};
  const aborted = new Promise<Attempt<T>>(resolve => { onAbort = () => resolve({ ok: false }); signal.addEventListener("abort", onAbort, { once: true }); });
  try {
    return await Promise.race([Promise.resolve().then(operation).then(value => ({ ok: true as const, value }), () => ({ ok: false as const })), aborted]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

function accountIdentity(credential: { access: string; accountId?: unknown }): string | undefined {
  if (typeof credential.accountId === "string" && credential.accountId) return credential.accountId;
  try {
    const claims = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString("utf8"));
    const id = record(record(claims)?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch { return undefined; }
}

async function discover(store: Store, auth: SharedOAuthAuth, accountId: string, signal: AbortSignal | undefined, fetchFn: typeof fetch): Promise<CodexCapabilityObservation> {
  const failure = (error: CapabilityError): CodexCapabilityObservation => ({ at: Date.now(), status: "error", error });
  const persistFailure = (error: CapabilityError) => {
    if (store.closed) return failure("store-closed");
    const observation = failure(error);
    store.setControl(observationKey(accountId), JSON.stringify(observation));
    return observation;
  };
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const resolveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const resolved = await bounded(() => auth.credential(accountId, resolveSignal), resolveSignal);
  if (!resolved.ok) return persistFailure(signal?.aborted ? "cancelled" : "credential-unavailable");
  const credential = resolved.value;
  const identity = accountIdentity(credential);
  if (!identity) return persistFailure("missing-account-id");
  const credentialFingerprint = (value: typeof credential) => createHash("sha256").update(JSON.stringify([auth.path, accountIdentity(value), value.access, value.refresh, value.expires])).digest("hex");
  const fingerprint = credentialFingerprint(credential);
  let cache = caches.get(store);
  if (!cache) { cache = new Map(); caches.set(store, cache); }
  const key = `${auth.path}\0${accountId}`;
  let entry = cache.get(key);
  if (!entry || entry.fingerprint !== fingerprint) {
    entry = { fingerprint };
    cache.set(key, entry);
  }
  if (signal?.aborted) return failure("cancelled");
  if (entry.observation && fresh(entry.observation.at)) return entry.observation;
  if (!entry.pending) {
    const current = entry;
    const requestSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    current.pending = (async () => {
      const request = (access: string) => bounded(() => fetchFn(MODELS_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${access}`, "ChatGPT-Account-Id": identity, originator: "codex_cli_rs", accept: "application/json" },
        signal: requestSignal,
      }), requestSignal);
      let response = await request(credential.access);
      let credentialError = false;
      if (response.ok && response.value.status === 401) {
        void response.value.body?.cancel().catch(() => {});
        const repaired = await bounded(() => auth.refreshRejected(accountId, credential.access, requestSignal), requestSignal);
        if (!repaired.ok || accountIdentity(repaired.value) !== identity) credentialError = true;
        else {
          current.fingerprint = credentialFingerprint(repaired.value);
          response = await request(repaired.value.access);
          if (response.ok && response.value.status === 401) await bounded(() => auth.reject(accountId, repaired.value.access, requestSignal), requestSignal);
        }
      }
      let observation: CodexCapabilityObservation;
      if (credentialError) observation = failure("credential-unavailable");
      else if (!response.ok) observation = failure("request-failed");
      else if (!response.value.ok) {
        void response.value.body?.cancel().catch(() => {});
        observation = failure(`http-${response.value.status}`);
      } else {
        const body = await bounded(() => response.value.json() as Promise<unknown>, requestSignal);
        const models = body.ok ? parseModels(body.value) : undefined;
        observation = models ? { at: Date.now(), status: "observed", models } : failure("invalid-response");
      }
      if (store.closed) return failure("store-closed");
      if (cache.get(key) === current) {
        current.observation = observation;
        store.setControl(observationKey(accountId), JSON.stringify(observation));
      }
      return observation;
    })().finally(() => { current.pending = undefined; });
  }
  // A cancelled waiter must not cancel another caller's shared discovery request.
  const pending = entry.pending!;
  const observed = signal ? await bounded(() => pending, signal) : { ok: true as const, value: await pending };
  if (!observed.ok) return failure("cancelled");
  if (cache.get(key) !== entry || !fresh(observed.value.at)) return failure("credential-unavailable");
  return observed.value;
}

/** Callers supply their grant/use/quota exclusions; capability discovery does not widen access. */
export async function codexTierExclusions(store: Store, auth: SharedOAuthAuth | undefined, model: string, tier: string | undefined, excluded: Set<string>, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<Set<string>> {
  if (tier !== "ultrafast") return excluded;
  const result = new Set(excluded);
  await Promise.all(store.accounts().filter(account => account.provider === "openai-codex" && !excluded.has(account.id)).map(async account => {
    if (!account.enabled || !hasCredential(auth, account.id)) { result.add(account.id); return; }
    const observation = await discover(store, auth!, account.id, signal, fetchFn);
    if (observation.status !== "observed" || !fresh(observation.at) || !observation.models[model]?.includes(tier)) result.add(account.id);
  }));
  return result;
}

/** Explicit metadata refresh bypasses the TTL, while joining an existing per-account request. */
export async function refreshCodexCapabilities(store: Store, auth: SharedOAuthAuth | undefined, accountId?: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch) {
  const accounts = store.accounts().filter(account => account.provider === "openai-codex" && (!accountId || account.id === accountId));
  await Promise.all(accounts.map(async account => {
    if (!account.enabled || !hasCredential(auth, account.id)) {
      store.setControl(observationKey(account.id), JSON.stringify({ at: Date.now(), status: "error", error: "credential-unavailable" } satisfies CodexCapabilityObservation));
      return;
    }
    const entry = caches.get(store)?.get(`${auth!.path}\0${account.id}`);
    if (entry) entry.observation = undefined;
    await discover(store, auth!, account.id, signal, fetchFn);
  }));
  return readCodexCapabilities(store, accountId);
}

/** Guard a pinned account without refreshing any unrelated accounts. */
export async function requireCodexTier(store: Store, auth: SharedOAuthAuth | undefined, accountId: string, model: string, tier: string | undefined, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<CodexTierResult> {
  const value = { accountId, model, tier };
  if (tier !== "ultrafast") return { ok: true, value };
  const account = store.accounts().find(account => account.id === accountId);
  if (!account || account.provider !== "openai-codex" || !account.enabled || !hasCredential(auth, accountId)) return { ok: false, error: `${accountId} has no available Codex credential for ${model} ${tier}.` };
  const observation = await discover(store, auth!, accountId, signal, fetchFn);
  if (observation.status === "error") return { ok: false, error: `${accountId} ${model} ${tier} capability unavailable (${observation.error}).` };
  return fresh(observation.at) && observation.models[model]?.includes(tier)
    ? { ok: true, value }
    : { ok: false, error: `${accountId} does not advertise ${model} ${tier}.` };
}
