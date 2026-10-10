# Pi Stack shared core

This package supplies the shared host engine: permission-separated thread custody, native Pi sessions, provider brokerage, OAuth custody, metering, images and durable tool-free inference. One core process owns these facilities for every registered principal on a host. [Core contracts](src/core/contracts.ts), [thread contracts](../../docs/threads.md) and [permissions](src/permissions.ts) define the boundaries.

Kenaznia dispatches work; native code owns accepted input, execution and result transitions. A kena can create kenatian; a kenatia cannot create agents. Threads are identified by task titles and immutable IDs. Exact native Pi JSONL remains history authority. Explicit Close cancels and archives only the selected conversation.

## Provider custody

[`ProviderController`](src/provider-controller.ts) borrows the existing [`Store`](src/store.ts), samples provider meters, reconciles filesystem completion receipts, admits exact model requests and reconnects the independent completion host. Core supplies its explicit auth path, agent directory, meter freshness and automatic-reset policy. Core owns reconciliation and observation timers; each declared ledger has one controller inside that process.

[`createModelBroker`](src/model-broker.ts) borrows that same Store and controller. Its embedded `request(verifiedPrincipal, req, res)` receives identity from core authentication, never from a caller-supplied principal. Core publishes account/model grants only to each original source configuration's declared ledger footprint, grouped by its original grant owner; an absent owner stays absent. Embedded brokers borrow publication custody. [`core/provider.ts`](src/core/provider.ts) locks each original ledger under its detached-owner receipt and installs explicit immutable completion aliases before exposing requests. Existing UID-bound loopback listeners run in this same process during finite caller adoption. An exact root-owned drained-stream receipt permits port adoption; live nft UID/input gates and unified use permission are checked on every request. UID-bound configuration includes explicit `admissionDeltaPaths` (empty when none); [enrollment evidence](docs/ordinary-users.md#enrollment-evidence) can extend the current UID policy without rewriting that original drain receipt.

Core credentials are root-owned digest bindings to registered principals. Clients set `PI_CORE_URL` and `PI_CORE_TOKEN_FILE`; the token file supplies `Authorization: Bearer …`. The broker mounts at `/v1/model-broker`. Operator provider routes mount at `/v1/providers` and require authorization for the provider resource before [`providerHttp`](src/provider-http.ts) runs. Ordinary model grants do not confer operator access. Native callers with an existing UID-bound listener set `PI_MODEL_BROKER_URL=http://127.0.0.1:PORT`; this explicit endpoint takes precedence over a tokenless gateway `PI_CORE_URL` and receives no unrelated core bearer.

Account eligibility preserves explicit stops, enabled state, calling-account exclusions, model entitlement, quota and cooldown evidence. Exact model/thinking/speed selections are retained; another model or tier is not substituted. Pi supplies provider catalogues and custom endpoint definitions. [`models.ts`](src/models.ts) overlays the shared explicit provider definitions for current routing and historical pricing.

OAuth remains in the existing shared credential file. [`SharedOAuthAuth`](src/auth/shared-oauth.ts) serializes refresh/quarantine; [account transfer](docs/account-transfer.md) moves exclusive ownership with the original leases and attribution. [Codex tier capabilities](docs/codex-capabilities.md) gate Ultrafast on the requested account/model's current entitlement.

### Original authority partitions

Configured provider fields are defined by [`CoreProviderConfig`](src/core/provider.ts). `primaryConfigPath` explicitly selects one of `configPaths`; each `grantFootprints` entry maps that original config to exact `ledgerOwnerIds` (`current` or retained IDs). Empty footprints are explicit. Retained ledger descriptors carry their own `ownerPrincipal`, `meterMaxAgeMs` and `autoReset` alongside exact custody paths/UID/GID/home. `freshListeners` is an explicit array (empty until enrollment). Its personal source joins `configPaths` and the same `grantFootprints` registry; [fresh enrollment](docs/ordinary-users.md#fresh-personal-listeners) proves a new principal/port/model policy under original account-creation authority, without another engine or another person's endpoint. Reload may change grants within a partition, not move its owner, footprint, ports or storage.

`ownerRoutes` explicitly binds an original ledger owner to its native `scopeId`, old `callerPrincipals` ceiling, observed budget and six separate resources: `completionRead`, `completionSubmit`, `completionRetry`, `completionCancel`, `providerRead`, `providerControl`. `/v1/providers/owners/OWNER/v1/completions/ID` preserves original stored IDs even when a public alias cannot be proved. Owner-scoped `/v1/plans`, `/v1/status`, account/control/capabilities/enabled/use and reservation GET/PUT/DELETE retain their original state. Reservations constrain eligible existing native/completion work; they do not produce work.

`GET /v1/providers/people-usage?period=day|week` aggregates trailing 24-hour or seven-day usage from each original ledger once, with frozen rates and no private account labels. Historical unscoped usage belongs to the declared original `ownerPrincipal`; subscription pools are deduplicated by declared OAuth custody. Its separate `peopleUsageResource` requires an actual read grant; declaring the resource grants nothing.

## Adoption and shutdown

The new owner uses the original ledgers, native runner boundaries, capability keys, session files, leases, immutable attempt receipts and accepted request IDs. Historical run sources/profile strings remain evidence, not admission inputs. Provider admission reads only durable completion requests; opening a ledger does not recreate work from historical producer rows.

Broker close rejects new admissions and drains accepted streams without signalling cancellation. Borrowed Store custody remains with core. Controller detach stops observation only; it does not close the independently executing completion host. Core closes its Store only after these facilities release it. A lost provider acknowledgement retains its original attempt fence and never authorizes a fresh request.

The completion host uses a ledger-specific socket and lifetime flock at `/run/user/UID/pi/completions/HASH.sock`. It runs outside the controller's lifetime, owns provider claims/cancellation/lease renewal, fsyncs receipts in `AGENT_DIR/completion-receipts`, and retires after its final execution and five idle seconds. A successor reconnects it. A claim without a terminal receipt is indeterminate, not replayable.

## Tool-free inference

[Durable completions](docs/completions.md) preserve system/user prompts, exact output, strict native JSON schemas, explicit model settings and once-only token accounting without an AgentSession or tools. The broker exposes submit/get/cancel/retry/attempts and [generated OpenAPI](docs/completions.openapi.json). Completion leases do not consume agent execution slots.

## Images and metering

[Image generation](docs/image-generation.md) and the [shared image service](docs/image-service.md) use the same OAuth, account eligibility and attempt custody. The app's image tag accepts a path or a prompt; core supplies the generation owner. [Anthropic Files](docs/anthropic-files.md) supplies account-scoped image upload references.

Provider samplers own deterministic quota observations. Explicit automatic Codex reset policy redeems only an available credit for raw weekly exhaustion, reserving its durable intent before POST. An uncertain redemption remains fenced until provider evidence resolves it. [Provider meter notes](docs/provider-meter-notes.md) and [reset statistics](docs/openai-reset-statistics.md) own observation and repair contracts.

Usage is component-aware (`input`, `output`, `cacheRead`, `cacheWrite`) and recorded once by the provider owner. [`person-usage.ts`](src/person-usage.ts) projects principal-local subscription dollars and unpriced usage. Broker `/v1/usage` filters meters/accounts and spending to its verified principal, aggregating each declared retained ledger once with its original frozen rates. An optional weekly allowance refuses new work without cancelling accepted requests.

## Operations

```text
PI_CORE_URL
PI_CORE_TOKEN_FILE
PI_CORE_SCOPE_ID       # CLI outside a native thread
PI_THREAD_API_URL      # injected scoped native callback address
PI_THREAD_TOKEN        # injected native thread capability
```

```bash
pi-orchestrator run --prompt "…" --model openai-codex/gpt-6.1-sol --thinking high --speed standard
pi-orchestrator send THREAD_ID --prompt "…"
pi-orchestrator close THREAD_ID
pi-orchestrator reopen THREAD_ID
pi-orchestrator dependencies THREAD_ID PEER_ID
pi-orchestrator account capabilities
pi-orchestrator account transfer ACCOUNT --to PEER
pi-orchestrator usage-evidence --ledger /absolute/ledger.sqlite3
```

Peer account-transfer/path configuration remains in the credential owner's explicit config. Tokens enter through files, never command arguments. Core owns boot and activation; source changes alone do not activate services or switch live routes.
