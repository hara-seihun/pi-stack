# Durable tool-free inference

The core model broker owns application inference over the existing provider ledger and shared OAuth pool. [`ProviderController`](../src/provider-controller.ts) owns admission and recovery; an independent completion host owns actual provider calls. A request uses Pi's native Codex provider directly, without AgentSession, extensions, skills, context files or tools. Caller system and user prompts stay separate. Metadata stays in the ledger.

## Authentication and endpoints

Set `PI_CORE_URL` and `PI_CORE_TOKEN_FILE`. Read the file into `Authorization: Bearer TOKEN`; do not put tokens in argv. Core binds the token digest to one registered principal and checks its model grant. The inference base is `${PI_CORE_URL}/v1/model-broker`.

The following paths are relative to that base:

- `PUT /v1/completions/{requestId}` atomically admits or replays immutable input.
- `GET /v1/completions/{requestId}` reads current custody without dispatch.
- `POST /v1/completions/{requestId}/cancel` cancels unfinished work; completed results remain unchanged.
- `POST /v1/completions/{requestId}/retry` requeues only a proved pre-execution rate-limit rejection. Cancelled/indeterminate outcomes cannot be retried.
- `GET /v1/completions/{requestId}/attempts` reads append-only assignment, receipt and recovery history.
- `GET /v1/completions/openapi.json` serves the runtime-generated contract.

`CompletionClient` accepts an explicit principal-bound broker `baseUrl` and optional `tokenFile`, or these core environment variables. An explicitly configured `PI_MODEL_BROKER_URL=http://127.0.0.1:PORT` selects the original UID-bound listener before core variables and does not read/send an unrelated core token. The listener is owned by the same core process, with exact host UID gates and per-request unified use authorization. It has no daemon endpoint fallback. A client transport timeout does not cancel durable work.

[`completion-contract.ts`](../src/completion-contract.ts) supplies TypeBox schemas and derived TypeScript types. [`completion-openapi.ts`](../src/completion-openapi.ts) builds OpenAPI from those schemas; [`completions.openapi.json`](completions.openapi.json) is the generated copy.

## Explicit input

New requests require `model`, `prompt`, `thinkingLevel` and `speed`. `model` is an exact installed Pi Codex ID (`openai-codex/gpt-6-astra`, for example), or the established `astra`, `sol`, `luna` aliases. Unknown models produce an error before admission. `speed` is `standard`, `priority` or `ultrafast`; unsupported or unentitled tiers are refused rather than substituted. Settings remain fixed across attempts.

```json
{
  "model": "luna",
  "prompt": "Extract the supplied facts",
  "systemPrompt": "Return only source-backed facts",
  "thinkingLevel": "low",
  "speed": "standard",
  "responseFormat": {
    "type": "json_schema",
    "name": "facts",
    "schema": { "type": "object", "properties": {}, "additionalProperties": false },
    "strict": true
  }
}
```

Native schemas become `text.format`, not prompt text. Unset `systemPrompt` means no caller instructions. `maxOutputTokens` is explicitly unsupported by Codex and returns HTTP422 before creating a run; local truncation is not a provider output cap.

A record preserves public `requestId`, original `runId`, requested model/metadata and timestamps. `settings` records explicitly selected thinking and speed. It is absent for historical inputs which omitted them. States are `queued`, `running`, `completed`, `failed`, `cancelled` or `indeterminate`. Completed records contain exact text, provider-reported model/response ID, native usage and `stopReason: stop|length`. Missing native terminal/model/usage evidence is an error, not estimated success.

## Exact identity adoption

IDs contain 1–256 letters, digits, periods, underscores, colons or hyphens; `openapi.json` is reserved. Normal broker storage uses `broker-SHA256(principal + NUL + publicRequestId)`. Public responses always retain the caller's original request ID.

Before switching an old daemon caller, the trusted core adoption owner invokes:

```ts
broker.adoptCompletion(verifiedPrincipal, publicRequestId, originalStoredRequestId, originalLedgerOwnerId)
```

The default ledger owner ID is `current`. Embedded brokers declare additional owners as `{id, store, controller}`; core's configured provider requires explicit `retainedLedgers` and `completionAliases` arrays (empty when none). Each retained ledger descriptor names `id`, `ownerPrincipal`, `databasePath`, `adoptionReceiptPath`, `uid`, `gid`, `home`, `authPath`, `agentDir`, `meterMaxAgeMs` and `autoReset`; its detached-owner receipt binds that exact ID, path and database inode. Each alias names `principal`, `requestId`, `storedRequestId` and `ownerId`. Core acquires every ledger's lifetime lock and resolves all configured aliases before serving requests.

Adoption binds the public scoped ID to the original stored record and grants it to that principal. A central `adopting` alias fences the public ID before cross-ledger access is recorded; only the completed `ready` alias permits lookup. An unavailable ledger owner or unfinished adoption returns503 rather than allowing a new submission. It does not create a run, change the stored input, rename a run/attempt or dispatch a provider request. Conflicting public identities or another principal's existing custody are refused. Adoption is not an HTTP operation available to model callers.

Original broker sources retain their separate config paths, grant owners (including unset), publication footprints and caller ceilings. Core never unions different sources into a wider listener. An alias requires a unique proved original source/footprint; otherwise the owner-scoped route `/v1/providers/owners/OWNER/v1/completions/STORED_ID` preserves the original stored ID without manufacturing a principal/public-ID mapping. Owner routes require an explicit original caller ceiling plus separate read/submit/retry/cancel resource grants. GET/PUT/attempts/cancel/retry/OpenAPI retain the durable completion contract; original direct PUT returns200, while a new broker PUT returns202.

Callers replay historical input unchanged. For deterministic IDs used by both old and new inputs: GET first; when `record.settings` is absent, PUT the original historical body; otherwise PUT the body plus those exact settings. Only after the retained-ID registry is completely adopted may a genuinely new404 submission include explicit settings. Canonical input equality ignores object key order but not added settings, prompts or metadata. A changed body under the same ID returns409.

Admission reads the principal's current live account/model grant, not the account list captured on arrival. Revocation, model policy and quota gates apply to queued work. Reads and exact replays of accepted custody remain available so a grant change cannot erase a receipt.

## Provider fences and lifecycle

Before provider dispatch, the host persists an attempt claim. No native automatic retry or alternate transport is used. Another worker finding a claim without a receipt fences it as indeterminate. Lost transport after acceptance and provider deadline expiry also remain indeterminate; none permits a fresh ID or request replay.

The host fsyncs `AGENT_DIR/completion-receipts/RUN_ID.json` before settlement. Receipt reconciliation persists outcome and component-aware usage once. Late receipts may settle an interrupted attempt; caller cancellation remains terminal while late usage is still accounted. The host renews cancellation leases until provider execution settles.

An HTTP429 before SSE admission is an explicit rejection. Its immutable receipt and assignment remain in attempt history; the same logical request/run is requeued with `attemptCount` and `retryAt`. The historical exact envelope `{"detail":"Rate limit exceeded"}` is also a proved rejection eligible for caller-authorized `/retry`. Arbitrary error text is not. Account feedback preserves observed backoff and concurrency windows; it does not invent a configurable request cap.

Controller replacement detaches observation and reconnects the existing ledger-specific socket/flock owner under its original UID. Configured UID/GID/home custody governs a missing-host launch through that user's manager; the root core never substitutes its own runtime directory or inherits its private environment into a person's host. It never closes the completion host. Broker close refuses new admissions and drains its accepted streaming requests without abort. Core retains Store custody until that drain and controller detach finish. Provider eligibility, fresh meters, exhaustion, cooldowns, account enablement, explicit pause and model grants remain real boundaries. Plain inference holds provider leases, not agent execution slots.
