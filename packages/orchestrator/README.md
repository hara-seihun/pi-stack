# Pi Stack shared core

This package supplies the shared host engine: permission-separated thread custody, native Pi sessions, provider brokerage, OAuth custody, metering, images and durable tool-free inference. One core process owns these facilities for every registered principal on a host. [Core contracts](src/core/contracts.ts), [thread contracts](../../docs/threads.md) and [permissions](src/permissions.ts) define the boundaries.

Kenaznia dispatches work; native code owns accepted input, execution and result transitions. A kena can create kenatian; a kenatia cannot create agents. Threads are identified by task titles and immutable IDs. Exact native Pi JSONL remains history authority. Explicit Close cancels and archives only the selected conversation.

[Native future factory](docs/runner-factory.md) owns immutable creator upgrades, retained adapter environments, writer custody and created-session historical receipt projection.

## Provider custody

[`ProviderController`](src/provider-controller.ts) borrows the existing [`Store`](src/store.ts), samples provider meters, reconciles filesystem completion receipts, admits exact model requests and reconnects the independent completion host. Core supplies its explicit auth path, agent directory, meter freshness and automatic-reset policy. Core owns reconciliation and observation timers; each declared ledger has one controller inside that process.

[`createModelBroker`](src/model-broker.ts) borrows that same Store and controller. Its embedded `request(verifiedPrincipal, req, res)` receives identity from core authentication, never from a caller-supplied principal. Core publishes account/model grants only to each original source configuration's declared ledger footprint, grouped by its original grant owner; an absent owner stays absent. Embedded brokers borrow publication custody. [`core/provider.ts`](src/core/provider.ts) locks each original ledger under its detached-owner receipt and installs explicit immutable completion aliases before exposing requests. Existing UID-bound loopback listeners run in this same process during finite caller adoption. An exact root-owned drained-stream receipt permits port adoption; live nft UID/input gates and unified use permission are checked on every request. UID-bound configuration includes explicit `admissionDeltaPaths` (empty when none); [enrollment evidence](docs/ordinary-users.md#enrollment-evidence) can extend the current UID policy without rewriting that original drain receipt.

Core credentials are root-owned digest bindings to registered principals. Explicit operator provider clients set `PI_CORE_URL` and `PI_CORE_TOKEN_FILE`; their token file supplies `Authorization: Bearer …`. Thread CLI and native peer tools instead use their registered own-UID Unix gateway, never a bearer fallback. The broker mounts at `/v1/model-broker`. Operator provider routes mount at `/v1/providers` and require authorization for the provider resource before [`providerHttp`](src/provider-http.ts) runs. Ordinary model grants do not confer operator access. Native callers with an existing UID-bound listener set `PI_MODEL_BROKER_URL=http://127.0.0.1:PORT`; this explicit endpoint takes precedence over a tokenless gateway `PI_CORE_URL` and receives no unrelated core bearer.

Account eligibility preserves explicit stops, enabled state, calling-account exclusions, model entitlement, quota and cooldown evidence. Exact model/thinking/speed selections are retained; another model or tier is not substituted. Pi supplies provider catalogues and custom endpoint definitions. [`models.ts`](src/models.ts) overlays the shared explicit provider definitions for current routing and historical pricing.

OAuth remains in the existing shared credential file. [`SharedOAuthAuth`](src/auth/shared-oauth.ts) serializes refresh/quarantine; [account transfer](docs/account-transfer.md) moves exclusive ownership with the original leases and attribution. [Codex tier capabilities](docs/codex-capabilities.md) gate Ultrafast on the requested account/model's current entitlement.

### Original authority partitions

Configured provider fields are defined by [`CoreProviderConfig`](src/core/provider.ts). `primaryConfigPath` explicitly selects one of `configPaths`; each `grantFootprints` entry maps that original config to exact `ledgerOwnerIds` (`current` or retained IDs). Empty footprints are explicit. Retained ledger descriptors carry their own `ownerPrincipal`, `meterMaxAgeMs` and `autoReset` alongside exact custody paths/UID/GID/home. `freshListeners` is an explicit array (empty until enrollment). Its personal source joins `configPaths` and the same `grantFootprints` registry; [fresh enrollment](docs/ordinary-users.md#fresh-personal-listeners) proves a new principal/port/model policy under original account-creation authority, without another engine or another person's endpoint. Reload may change grants within a partition, not move its owner, footprint, ports or storage.

`ownerRoutes` explicitly binds an original ledger owner to its native `scopeId`, old `callerPrincipals` ceiling, observed budget and six separate resources: `completionRead`, `completionSubmit`, `completionRetry`, `completionCancel`, `providerRead`, `providerControl`. `/v1/providers/owners/OWNER/v1/completions/ID` preserves original stored IDs even when a public alias cannot be proved. Owner-scoped `/v1/plans`, `/v1/status`, account/control/capabilities/enabled/use and reservation GET/PUT/DELETE retain their original state. Reservations constrain eligible existing native/completion work; they do not produce work.

`GET /v1/providers/people-usage?period=day|week` aggregates trailing 24-hour or seven-day usage from each original ledger once, with frozen rates and no private account labels. Historical unscoped usage belongs to the declared original `ownerPrincipal`; subscription pools are deduplicated by declared OAuth custody. Its separate `peopleUsageResource` requires an actual read grant; declaring the resource grants nothing.

## Internal room custody

The shared `rooms` scope belongs only to its kernel-bound `pi-rooms` service. Person-facing room access remains in Remote's authenticated actor and current membership gateway, including history-return rechecks and event revocation. Scope custody is not an audience consent or a shared-scope person grant.

[`deploy/core-room-custody.mjs`](../../deploy/core-room-custody.mjs) stages the finite correction from the original confidential room scope with missing custodian grants. Invoke `node deploy/core-room-custody.mjs ABS_CONFIG EXPECTED_CONFIG_SHA256 ABS_AUTHORITY_RECORD ABS_CANDIDATE` with protected root-owned inputs. It preserves subjects, privacy, gateway ceilings, credentials and existing exact-thread grants/consents, changes only internal scope consent to `not-required`, and adds the existing service's exact read/write/dispatch/control grant. Conflicting scope authority is a typed refusal. The receipt binds the original configuration and authority record hashes. Validate the candidate with the deployed Core parser under Bun and namespace preflight; apply it only in an ordinary Core handoff, since reload cannot change resource custody. No service is started by the projector.

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

## Host readiness

`/health` and `/v1/health` report `ready`, `degraded`, and explicit subsystem `reconciliation` states. Startup, shutdown, an unobserved first reconciliation, thrown reconciliation failures and failed duties remain HTTP503. Root's returned delivery-error count describes retained durable outbox work: it reports `delivery-degraded` and its count without disabling unrelated host scopes. A locked or unreachable recipient does not make the shared engine unavailable. The original outbox retains its identity, error and retry; readiness neither acknowledges delivery nor suppresses that failure.

Core activation subscribes each manager-notice adapter without awaiting its historical scan, callback policy or delivery acknowledgements. Callback projections may start only after Core health, so replay cannot be an initial readiness dependency. The adapter owns its operation, durable cursor/outbox, retry and close drain. Historical scans yield after each committed 100-receipt page; acknowledged outbox deliveries yield before the next original request, allowing HTTP and shutdown to progress without losing custody.

Health also reports `startup: { phase, elapsedMs, phaseElapsedMs }`, using a monotonic clock. The journal emits `type: core-startup` phase-bound observations with only release commit, scope count and durations. Phases distinguish scope adoption/activation, provider/memory/image/duty/Root adoption, callback/HTTP/provider/gateway transports and initial reconciliation. `ready` marks the first successful health reconciliation, not recipient delivery. An HTTP503 still carries its current phase; retain that body when a host health gate fails. No deadline is enlarged by these observations.

Scope adoption emits one aggregate `core-adoption` observation with outcome, release commit, declared/adopted counts and `durationsMs`: `runtimeCustody`, `threadDatabase`, `scopeAdoption` and `directoryWiring`. Runtime and database times are nested inside scope adoption; they must not be summed with it. No scope/thread IDs, paths, metadata, credentials or error bodies cross this observation boundary. A later health `ready.phaseElapsedMs` is time already spent ready, not startup latency.

Already-current thread adoption preserves role metadata and pending delivery rows without rewriting them, preserves exact queue/active-execution indexes, and avoids duplicate question-event sequence allocation. Genuine legacy normalization and mismatched-index migration still run; index replacement is transactional and conflicts refuse adoption. `tests/thread-adoption-idempotence.test.ts` proves unchanged second-open schema/data/sequence, legacy migration, cyclic custody refusal and rollback of a conflicting active-index migration.

`tests/core-adoption.test.ts` holds the actual notice adapter's policy response while verifying healthy HTTP and a close drain that still waits for that same operation. Set `PI_CORE_STARTUP_PROBE_PREDECESSOR=/absolute/immutable/orchestrator/dist/core/service.js` to bind its activation method to an exact predecessor and reproduce the readiness refusal. `tests/core-manager-relay.test.ts` covers checkpointed paging, stopped/restarted outbox IDs and acknowledgement fences; `tests/core-startup-clock.test.ts` covers phase timings.

## Operations

```text
PI_CORE_URL
PI_CORE_GATEWAY_SOCKET
PI_CORE_GATEWAY_UID    # exact expected Core server UID
PI_CORE_SCOPE_ID       # explicit account scope for CLI outside a native thread
PI_CORE_TOKEN_FILE     # operator provider commands only; must be unset for thread commands
PI_THREAD_API_URL      # injected scoped native callback address
PI_THREAD_TOKEN        # injected native thread capability
```

Outside a thread, explicitly export the chosen account's existing `/etc/pi-stack/users/USER/core.env` before invoking thread commands (`set -a; . /etc/pi-stack/users/USER/core.env; set +a`). Unset native `PI_THREAD_ID`/`PI_THREAD_TOKEN` and `PI_CORE_TOKEN_FILE`; no account is inferred from HOME or a stale callback URL. The socket's kernel credentials and existing route ceiling still authorize that account. Missing scope/gateway configuration is an error. A native capability requires its injected `PI_THREAD_API_URL` and is preserved through the same gateway, including original send/wait IDs and the request deadline. Gateway uncertainty returns an unconfirmed receipt for the original identity, not another transport or automatic resubmission.

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
