# Live Codex model tier capabilities

[`auth/codex-capabilities.ts`](../src/auth/codex-capabilities.ts) owns per-account Codex model tier discovery. Ultrafast is an account/model capability, not a hardcoded subscription plan test: an account's authenticated `GET https://chatgpt.com/backend-api/codex/models?client_version=0.159.0` must advertise the requested `models[].slug` with `service_tiers[].id === "ultrafast"`.

## Routing contract

```ts
codexTierExclusions(
  store: Store,
  auth: SharedOAuthAuth | undefined,
  model: string,
  tier: string | undefined,
  excluded: Set<string>,
  signal?: AbortSignal,
  fetchFn?: typeof fetch,
): Promise<Set<string>>

requireCodexTier(
  store: Store,
  auth: SharedOAuthAuth | undefined,
  accountId: string,
  model: string,
  tier: string | undefined,
  signal?: AbortSignal,
  fetchFn?: typeof fetch,
): Promise<CodexTierResult>
```

`CodexTierResult` is `{ok:true,value:{accountId,model,tier}} | {ok:false,error:string}`. The pinned guard discovers only that account. Both functions leave Standard/default/Priority/no-tier policy unchanged. They gate only Ultrafast.

The selection helper copies caller exclusions and adds every Codex account that cannot demonstrate current advertised support. It only refreshes enabled, credential-bearing, nonexcluded accounts; callers must first exclude accounts outside their grants and existing use/reservation policy. Capability discovery never authorizes a broader pool, changes quota/cooldown/reservation policy, or silently downgrades Ultrafast to another tier. Transport failures, unavailable credentials, malformed responses and stale observations are ineligible, not evidence of a negative capability.

## Discovery lifecycle

Shared OAuth's locked `credential()` resolves and refreshes the normal bearer. The ChatGPT account identity comes from its `accountId`, or the Codex JWT account claim when needed. One metadata 401 invokes `refreshRejected()` and retries once; a second 401 quarantines the rejected refreshed token. Credential/account identity changes invalidate the memory cache immediately. No credential, identity, token fingerprint, response body, plan label or exception text is persisted or logged.

The memory cache TTL is 60 seconds (`CODEX_CAPABILITY_TTL_MS`). Discovery single-flights per account within one owning Store. Each credential resolution and the complete HTTP/401-repair/response-body phase has its own four-second deadline. Accounts refresh concurrently. A caller can cancel its wait without cancelling another caller's shared request. The shared operation is bounded and checks `Store.closed` before persistence, so owner shutdown cannot write into a closed ledger.

`Store.control("codex-capabilities:ACCOUNT")` holds only `{at,status:"observed",models:{MODEL:[TIER_IDS]}}` or `{at,status:"error",error:SANITIZED_CODE}`. Persisted observations survive restart for diagnostics but are never reused to authorize a cold process. Error observations do not erase the distinction between unknown/error and an observed false value. Successful refresh replaces previous error evidence.

## Dispatch receipts

Each broker listener serves `GET /v1/dispatches` with only its principal's latest 128 Codex dispatch receipts, retained under `broker-dispatches:PRINCIPAL` in the owning ledger. Receipts contain `id`, `requestId`, `principal`, `accountId`, `model`, `serviceTier`, `at`, `updatedAt`, `httpStatus` when received, and `outcome`. No prompts, credentials, provider response bodies or token counts are saved. The model/tier are read from the final serialized outgoing HTTP body immediately before transport. Each credential-repair attempt has a distinct receipt.

The broker returns `x-pi-broker-dispatch-id` for exact response correlation. `id` is the broker lease ID plus attempt number; `requestId` is the actual outgoing `x-client-request-id`, SHA-256 of `principal + "\\0" +` the incoming `prompt_cache_key` (otherwise session-id/session_id/x-claude-code-session-id). Read the receipts before a trial and retain the newly created records after it; the account-specific benchmark listener isolates them from other principals.

`dispatched` records intent at the send boundary, `accepted` records successful HTTP headers, and `completed`, `incomplete` or `failed` records a native terminal SSE event. An HTTP refusal is `rejected`. Cancellation or a connection ending without a native terminal event records `cancelled` or `indeterminate`, never completed. These receipts prove the account and tier sent, not the provider's internal hardware routing or a measured speedup.

## Operator status and refresh

`GET /v1/status` exposes `codexCapabilities`, one record per local Codex account:

- `status`: `unknown`, `observed`, or `error`;
- `at` and `fresh`: observation timestamp and TTL state;
- `models`: advertised model → tier IDs after a successful observation;
- `ultrafast`: model → true/false after a successful observation, otherwise `null`;
- `error`: sanitized error code after failed discovery.

This is local account evidence, not another principal's private broker grants. Stale observations retain historical advertised values with `fresh:false`; routing refuses stale evidence and refreshes it.

Explicit refresh makes no inference request and bypasses the TTL while joining any already-running per-account request:

```sh
pi-orchestrator account capabilities
pi-orchestrator account capabilities openai-codex-8
```

The CLI calls `POST /v1/accounts/capabilities` with `{}` or `{accountId:"openai-codex-8"}` on the owning daemon. Broker-client daemons reject local credential refresh and direct the operator to the account owner. Unknown/non-Codex aliases return 404. Disabled or credential-less accounts report `credential-unavailable` without a metadata request.

Programmatic diagnostic helpers are `readCodexCapabilities(store, accountId?)`, `readCodexTierObservation(store, accountId, model, tier)`, and `refreshCodexCapabilities(store, auth, accountId?, signal?, fetchFn?)`. The targeted read returns `{at,fresh,supported:boolean|undefined,error?}`; an absent observation returns `undefined`.

Focused contracts live in `tests/codex-capabilities.test.ts` and `tests/codex-capabilities-api.test.ts`. On September 29, 2026, the live GMKtec pool returned valid ten-model catalogs for all five accounts. Astra Ultrafast was advertised only by `openai-codex-8`; accounts 11, 12, 3 and 4 did not advertise it. These are discovery observations, not enduring account policy.
