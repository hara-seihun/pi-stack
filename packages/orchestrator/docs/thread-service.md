# Shared core thread custody

[`ThreadService`](../src/threads/service.ts) owns accepted input, execution receipts, questions, result subscriptions and lifecycle inside the shared core. [`contracts.ts`](../src/threads/contracts.ts) is the transport contract; an authorized directory routes peers without becoming another scheduler. Native Pi JSONL is the exact history authority.

## Roles and identity

[`roles.ts`](../src/threads/roles.ts) defines `kenaznia`, `kena` and `kenatia`.

- Kenaznia is the canonical, dispatch-only managing conversation. Its native tool list and execution gate exclude shell/file/operational tools. Agents do that work.
- Kenaznia launches kenan; a kena launches kenatian. The service refuses a kenatia's spawn request independently of its tool schema.
- A kenatia can list and talk to any authorized agent. Roles do not grant access to another principal's resources.
- Task titles identify agents. The owner assigns roles and exports `PI_THREAD_ROLE`; exact historical sender receipts remain unchanged.

The native adapter consumes `roleTools()` and `roleInstruction()`. `PI_THREAD_CAN_SPAWN` is derived from the stored role. Unknown recorded roles are errors, not ordinary workers.

Workers write state and the next action to their owning Markdown notes and finish. Completion does not archive a thread. Only explicit Close archives it. Close cancels running work after positive native cancellation; not-landed input retains its exact receipt and payload. Reopen releases that pending custody without repeating already-landed work. Explicit user-requested `cancelMessage` cancels that selected pending receipt. `view` does not mutate lifecycle, and automatic inactivity archival is rejected.

## Lossless delivery

There is one delivery behavior: `pending`. Existing persisted queue/steer/hardSteer values are adopted as pending without deleting, interrupting or cancelling their messages. Historical terminal receipts retain their recorded values. Current tools expose no mode selector or promotion.

`send()` commits a stable request ID and payload before acknowledgment. Retrying an accepted request returns the same receipt, including after Stop. Sender, text, images, source and correlation must match. Messages are dispatched in accepted ordinal order, all queued inputs in one native batch:

```ts
{ type: "input_batch", batchId, workId: firstWorkId, workIds,
  inputs: [{ workId, message, images, inputOrigin }] }
```

`thread_input_batch` in SQLite binds the batch to its original execution and message IDs. Native ACK confirms every input in the atomic batch. `thread_landed {workIds}` records actual model delivery independently of acceptance. An uncertain ACK retains custody and is inspected through the original command/input status; it never causes a new request identity or blind replay.

`pendingMessages` and `pending()` count/list only accepted inputs whose `landed_at` is unset. Landed execution receipts remain in `inputs`, exact history and settlements, but are not displayed as pending work.

The native inbox owns the completed-output boundary. It batches messages after the current assistant output, never mid-generation. Running tools yield observation to the model while their operation continues with its own identity. `tool_operation_result` enters the same durable inbox under deterministic `operation:…:terminal` work identity, so a repeated completion event cannot create another input.

Recovery uses `input_batch` only for original not-landed inputs, then `resume_pending {workIds}` to continue the exact adopted branch. Original work/execution IDs, prepared attachments and accepted settings survive. Completed receipts settle without another model request. Rejected, never-landed input remains pending with an explicit `inputFailure`; deliberate repair/retry owns its next admission.

## Timing and Markdown duties

Kenaznia receives a twenty-minute open-work digest. [`manager-watchdog.ts`](../src/threads/manager-watchdog.ts) defines its cadence. The native service owns its timer/occurrence ledger; Kenaznia judges local day/date, timezone, business hours, weekends and holidays before dispatching. Explicit stops remain paused. Human input does not withdraw already-accepted digests.

Only Kenaznia can create a future duty reminder. Worker wake rows remain inert source custody until Markdown adoption. Changing/cancelling a reminder does not withdraw an accepted occurrence. Dependency waits are event subscriptions, not worker polling: `agents`, `job`, `deployment` and `message` carry explicit IDs and durable registration outcomes. A settled producer's result is retained; a subscription never prevents explicit Close.

[`core/duties.ts`](../src/core/duties.ts) exposes:

```ts
adoptMarkdownDuties({ service, watch?, path: absoluteOwningMarkdownPath })
  // Result<{path, receipt, wakeCount, watchCount, pendingOccurrenceIds}>
```

The owning core supplies unlocked, permission-scoped owners and a declared private Markdown path. The importer atomically writes and fsyncs the source snapshot before recording custody and retiring future timer rows. A content-addressed block restores the original snapshot on retry after partial retirement; human notes are preserved. Held/archived owners remain stopped and unknown owner state remains unresolved. Import never starts or ticks a worker.

`service.exportWakeDuties()` returns original generation, schedule, last occurrence, pending IDs and stop state. `adoptWakeDuty(threadId, markdownReceipt)` records custody before retiring its future timer, leaving accepted messages intact. [`WatchList`](../src/threads/watch-list.ts) is the read-only watch custody/drain adapter: `exportDuties()` retains items, old check IDs, pending spool, request receipts, timing and delivery failures; `adoptDuties(receipt)` records Markdown transfer. `start()` creates no timer. Explicit `tick()` drains only an existing accepted occurrence spool with its original IDs. Stopped owners are not ticked. New watch changes/checks belong to the Markdown owner.

[`core/duties-runtime.ts`](../src/core/duties-runtime.ts) is the executable adoption/drain plugin. Its configuration is explicitly `disabled`, or `configured` with entries:

```ts
{ scopeId, path: "/declared/private/duties.md", watch:
  { kind: "none" } // or
  { kind: "existing", databasePath, adoptionReceiptPath, acceptedSpool: "drain" | "hold" }
}
```

`CoreDuties.start()` validates scope/runtime resource paths, obtains detached table custody for an existing watch database, and writes Markdown before retiring future duties. The watch receipt names the exact five source tables plus `watch_markdown_adoption`. Source schema is checked read-only; a missing database/table is never replaced. Disjoint image and watch claims share one physical controller lock through the core ownership broker. Unavailable scopes are untouched.

Main's existing clock calls `tick()`; there is no plugin timer. `hold` retains the original spool. `drain` rechecks the configured principal's dispatch grant, declared workspace and original check/parent stop state before each accepted spawn. Closing the plugin waits for accepted dispatch and releases only its own table claim. Kenaznia's stored `markdownDutiesPath` points at the canonical notes; its digest includes completed workers' final state and tells it to dispatch a fast reader rather than read files itself.

## Session and receipt lifetime

Construction supplies `databasePath`, `sessionsDir`, native `openSession`/attachment and optional scoped environment, admission and preparation hooks. `start()` enables reconciliation. An execution is active exactly while its `thread_execution.ended_at` is null; a partial unique index admits one per thread. Each execution retains its effective settings and capacity identity.

Preparation is durable before native intake. Account/model leases end with execution; session residency is independent. A native `backgroundOperationCount` keeps the executor alive while its model lease can be released. Reclamation, handoff and explicit Stop must respect that operation custody, not mistake yielded observation for cancelled execution.

`suspend()` fences dispatch and callbacks. `detach()` waits for owned operations and transfers retained native sessions without fabricating settlement. `close()` refuses active work and closes confirmed-idle resources. Native cancellation/absence is positive evidence; transport loss is not.

Inspection is read-only and does not open a session. Metadata, indexed native item windows and exact branch record pages have explicit contracts and an 8 MiB bound. Full context is opt-in. Unknown/missing required history returns an error, not an empty conversation. `settlements(after, limit)` returns ordered durable execution receipts; listener events are observations, not delivery acknowledgments.

Questions retain original IDs, suggestions, answers, routing deadlines and first-answer arbitration. Kenaznia's held-question tools act under the person's actual authority. Answer/forward outboxes retain correlation across restart. A person's input and a manager's decision remain distinct provenance.

## Source adoption

`importState(threads, messages)` is one synchronous transaction before `start()`. Preserve IDs, parentage, native file references, held/archive state, timestamps, accepted settings and original input receipts. Imported terminal work does not dispatch; accepted pending work stays with its exact ledger identity. Required native history is marked explicitly so an absent transcript cannot become a fresh session. Source cleanup belongs to the adoption owner after durable custody.

Targeted source-only proofs:

```sh
cd packages/orchestrator
node ../../node_modules/vitest/vitest.mjs run tests/roles-lifecycle.test.ts tests/duties-adoption.test.ts tests/duties-runtime.test.ts --maxWorkers=1
```
