# Native history publication boundary

Owners: `deploy/native-history-boundary`, `deploy/native-history-coordinator.mjs`, and `deploy/native-history-bridge.mjs`. First unlock belongs to `apps/remote/server/native-history-startup.mjs`; the data transform belongs to [native history migration](native-history-migration.md).

## Always-open intake

Publication is background work. People continue creating agents, sending messages, answering questions and receiving scheduled wakes while an old generation serves its existing native history. `MAINTENANCE_INTAKE = 'always-open-v1'` is the publication contract. The publisher checks it before any maintenance effects, including already-checked queued candidates.

Observation records only source ownership. It changes neither `ThreadService.spawn`/`send` nor scheduled-wake delivery, and creates no admission trigger. The old request validator and durable `thread_request`/`thread_work` transactions remain authoritative for every new request and retry. Busy old work makes publication wait, not the person.

## Owner replacement

The coordinator stages entry wrappers referring to the immutable selected Remote and Orchestrator releases. Their resource identities, decoder and API module graph remain those of that release. The existing namespace launcher retains the encrypted mount. Inventory includes every registered active `pi-orchestrator@USER`, deduplicating the administrator. Ledger placement comes from the live owning namespace, then the exact registry declaration, then the inspected old CLI's HOME placement.

The old fleet's shutdown aborts tool-free providers, so the coordinator first observes all active provider requests without changing their dispatch. Once they are naturally idle, a short source-bound dispatch barrier prevents a new queued completion from entering the retiring provider. Completion submission remains accepted into its normal durable ledger. If a provider raced this barrier, every prepared barrier is released and normal dispatch resumes. The replacement daemon releases its own barrier before starting; queued requests continue with their original identities. The barrier never rejects inserts or changes accepted run outcomes.

Each bridge registers the actual constructed `Daemon.threads`, verifies its API identity and requires successful startup. Status, restoration and retirement share an operation queue. Stopped/detaching controllers await a live replacement for their exact database path. Normal shutdown closes the maintenance listener and timer rather than retaining a process with closed databases.

Readiness observes pending work, active native executions, controller operations, acknowledged output spools and complete old-runner custody. The old decoder attaches and ACKs retained events; the candidate never interprets retired capture frames. Repeated probes share their attachment. Positive native state reconciles busy/idle; unknown ownership remains an explicit preservation error.

When naturally idle, the bridge pauses **dispatch only** for the immediate controller replacement. Input continues through the normal durable validator. A late queued message is preserved for the successor, rather than refused or started in the retiring runtime. In-flight operations that raced this transition restore normal dispatch. Idle native sessions close while their old capture listener still serves shutdown hooks, then their runner controls acknowledge retirement. The old owner closes its databases before the private migration runs as the owning UID.

A brief listener replacement is reconciled using the same immutable request identity, URL, body, authorization and environment. Native thread clients and web creation/prompt transport retry transient connection/body loss and 502/503/504 responses for at most 60 seconds. Acceptance is reported only from the owner's real receipt. Person/environment changes, cancellation, authorization and validation errors remain terminal. PromptOutbox remains the durable client intent owner.

Root preflight is observational. Its executor replacement belongs to normal One Kenan activation and its durable ask/consent receipts, not a history-wide intake pause.

## Preservation and prerequisites

The migrator snapshots capture records and native preimages, promotes missing thinking, and retires capture tables atomically. Only successful migration writes `native-history-readiness.json`. Restart-safe owner receipts bind the immutable source, UID, placement and current phase. A migrated maintenance child retains its launcher namespace until candidate activation.

A host may declare `nativeHistoryPrerequisites` as an absolute root-owned executable. After private migrations and before readiness, the coordinator calls it with `HOST_FILE CANDIDATE_SHA`. It must return an idempotent candidate-bound `ready:true`, `applicationStarted:false` receipt. Preparation never starts candidate consumers.

## Locked first unlock

After mounting a person's folder, the launcher inspects native schema and retained producer identities. Fresh/native databases start normally. Old schema requires positive writer absence and acknowledged output before migration. When an old producer exists, only the candidate-bound immutable `legacy.json` decoder may adopt it. That owner continues accepting normal input while observing old work, then uses the same short replacement and private migration.

The Orchestrator's first-start owner (`native-history-startup.ts`) likewise checks retained producer protocol and spool sizes before choosing its decoder. Unknown/corrupt source custody preserves queued work and returns an explicit startup error. Native current custody starts directly. Capture maintenance belongs to the owner-local migrator, not a runtime compatibility decoder.

## Interruption and restoration

State lives outside model sessions. Pre-migration failure or cancellation restores only that attempt's transient source selectors and owned dispatch/observation state. Historical gated attempts may use their source-bound restoration helper to remove their exact old admission fences. Restoration never cancels accepted provider work or clears another candidate's identity. Each original owner supplies a positive live or closed generation proof in its own namespace and UID.

`nativeHistoryCustodyUnit` names an existing retained namespace. Where none exists, the bounded owner recovery launcher uses the exact declared person configuration and credential, invokes only the proof helper, and never starts an application entry. Live recovery checks immutable serving source, publisher UID, actual Node/Bun actor, namespace, PID and declared loopback health before and after its transaction. Health is never called while holding the consumer's database write lock.

Once private migration has crossed the schema boundary, the old capture decoder cannot be selected again. Repair retains custody until the candidate or a checked descendant serves. A positive serving-native proof can release an older attempt without recreating capture state.

Private snapshots and native preimages remain in the person's backup coverage. `legacy.json` contains source paths only. Retention pins those source releases and linked dependencies until every registered locked owner's migration is acknowledged. Host inspection receives bounded counts/proofs, never conversation bodies or credentials.

## Focused contracts

```sh
node --test scripts/native-history-boundary.test.mjs \
  scripts/native-history-attachment.test.mjs \
  scripts/native-history-owner-recovery.test.mjs \
  apps/remote/server/native-history-startup.test.mjs \
  scripts/migrate-native-history.test.mjs \
  scripts/native-history-fleet-startup.test.mjs
```
