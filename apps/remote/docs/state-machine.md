# Thread state and Remote presentation

The [unified thread design](../../../docs/threads.md) owns execution semantics. Orchestrator's `ThreadService` owns every persistent thread, its input queue, settings, cancellation and parent notifications. Remote has no execution phase machine, work dispatcher, child registry or result relay.

## Ownership and access

`server/server.ts` creates one person-owned `ThreadService` over `DATA/threads.sqlite3`, using Orchestrator's multiplexed shared Pi runner. Native JSONL files remain the conversation store. Thread IDs and parent IDs do not change when sessions unload or the supervisor restarts.

The common `/v1/threads` API is the same directory for humans, agent tools and offline-reader discovery. `/v1/thread-owner` exposes only this person's local service for explicitly configured peer wiring, so owner directories cannot recursively list each other. Remote's existing `/v1/sessions` routes translate presentation operations into that API. Root, child and fleet threads share the same `Session` response shape and transcript view. `origin` identifies person or fleet ownership for filtering; it does not select another lifecycle. `GET /v1/sessions/:sessionId/children` pages the exact owner's direct-child list through all states, including archived children, without opening Pi. The settings response includes the same children. The sidebar can show active children first and expand inactive ones without creating another registry.

The local service runs inside the person's existing Unix account and mount namespace. A fleet peer is included only when `/etc/pi-stack/host.json` names that Unix person as `fleetUser`. Readable fleet ledgers and previous observation access grant no control authority. `PI_REMOTE_ORCHESTRATOR_URL` selects the fleet owner endpoint, defaulting to `http://127.0.0.1:2460`. A peer failure retains its last listing and exposes an owner error; it does not change local thread execution state.

## Execution state is an observation

Remote publishes the shared `ThreadState` unchanged as `idle`, `running` or `stopped`. Live Pi events can add thinking, tool, compaction or retry display details while the thread is running. These details do not control execution or add lifecycle states. An idle parent stays idle while its children run.

`server/live-projection.ts` stores disposable text, thinking and bounded tool previews. These fields neither admit nor complete work. No GET request or browser selection starts a thread merely to read history. Owner inspection returns cached context or persisted native history without opening Pi.

## Messages and controls

Human and agent messages use `queue`, `steer` or `hardSteer` delivery. The service owns admission and dispatch receipts. Remote renders uninserted pending messages above the composer using their queued, running, dispatched or held state.

- Queue waits for the recipient's execution to finish.
- Steer waits for the current local tools without cancelling them.
- Hard steer confirms cancellation of current local execution before sending the selected message first. Other pending messages retain their order.
- Stop requires an explicit `descendants` boolean, cancels the selected execution scope and holds pending messages.
- Resume returns `no_pending_messages` when nothing is held. It starts no empty work.
- An explicit new message resumes a stopped thread with that message first. Automatic notifications stay held.

The owner also handles pending-message cancellation/promotion, settings and native session commands. Editing a user message forks through the owner, then Remote replaces its display-event projection and returns the original text to the composer. Sending is a separate operation.

Defaults come from Orchestrator. Remote's model picker restricts which configured models a destination offers; it does not resolve reasoning effort or provider speed independently.

## Remote data

`server/database.ts` stores presentation data in `supervisor.sqlite3`:

- `thread_views` contains drawer order, unread markers, naming counters and completion receipt references.
- Context documents and patches contain the provider-neutral display source.
- Events contain the bounded presentation and voice projection, not conversation recovery state.
- Message annotations retain meeting-transcript attachment receipts.
- Upload, inline-image and request records retain those Remote features' own custody.
- Notification rows and per-owner cursors deliver durable owner settlement receipts to clients.

The supervisor epoch fences replaced Remote instances from publishing presentation writes. It does not own execution. The Orchestrator importer transfers existing thread identities, native paths, parent links and pending/result receipts before removing the former execution tables and rebuilding presentation references. Active work must settle under its existing owner before the incompatible first cutover.

## Thread naming

Naming uses Orchestrator's durable tool-free `CompletionClient`, not a Pi process or a hidden thread. Remote saves a stable thread/message-count request ID and immutable input before submission, then reconciles the owner's receipt. Orchestrator owns provider execution and retry policy. A supervisor restart reuses the receipt rather than submitting another inference.

The completion owner must be explicitly permitted for the same Unix person. Without one, the thread keeps its current name and exposes a naming error. Naming currently supports the completion facility's Luna and Terra models. Defaults come from that facility; an explicit effort in `PI_REMOTE_THREAD_NAMING_MODEL`, such as `:low`, is forwarded. Speed is standard. Unsupported models and failed naming results are visible in the drawer's owner errors.

## Handoff

Orchestrator owns shared runners and session adoption. Release handoff suspends service dispatch and callbacks, detaches the shared runner connections and closes the controller database. Native execution remains with the runner. Remote stops its presentation subscriptions, HTTP server and feature workers, then exits with the supervisor's handoff code.

Session cleanup uses session-scoped runner commands, never a shared process PID. Hundreds of threads do not create hundreds of Node processes.

## Notifications

Child-idle notifications are Orchestrator messages with durable execution/work IDs, outcome and final assistant message or explicit absence. They use the same delivery operations as other input. Remote does not extract a child result from its event table or create a second parent relay.

Human notifications project each authorized owner's sequenced settlement feed. `server/thread-notifications.ts` commits the notification receipt and that owner's cursor together. Receipt IDs prevent replay from marking a viewed thread unread again. One owner's cursor cannot skip another owner's completions. `GET /v1/notifications` without a cursor establishes the current position; later requests replay up to 100 notifications. Viewing a thread clears its unread marker.

## Network synchronization

Remote still uses resumable long polling, with an epoch and wake sequence. Thread state and dashboard data have separate versions. The selected context and live text are compared by content hash on every response. A response carries only changed sections and complete documents or verified byte splices.

Clients commit section versions only after all document updates verify. Selection changes and reconnects cancel the preceding request. A response for another selection cannot replace the current conversation. Mutation responses request reconciliation instead of creating a second client-side copy of thread state.

Peer listings and inspections are derived caches. They are not another registry or execution owner. Local thread snapshots come directly from the person-owned service.

## Context and live output

Pi's model context is the interactive view. The context mirror publishes durable message boundaries; live deltas take an in-memory path. Final live text remains until the matching context replacement acknowledges it. Compaction must acknowledge its replacement, otherwise Remote clears the stale document rather than displaying removed messages.

The display projection strips provider continuation metadata and replaces inline image bytes with thread-scoped content-addressed URLs. Canonical context remains unchanged. Tool-result images load when expanded. Context patch journals checkpoint before their configured entry/byte limits, and clients verify every splice before rendering it.

`server/live-projection.ts` and `server/tool-progress.ts` preserve current tool cards until canonical context contains their results. `server/context-journal.ts`, `server/context-display.ts` and `server/sync.ts` own document storage and transport details.

## New thread picker

The shared browser/Android picker in `web/src/thread-start-state.ts` has local closed, destinations, models, creating and failed states. Opening captures the current choices. Dashboard updates do not move them during an interaction. Creation retries reuse the accepted request and thread IDs. Dismissing the picker does not cancel an accepted thread or let a late response replace a newer selection.

## Files and attachments

File browsing remains an environment-level lazy tree. Uploads resume from committed offsets and verify the completed hash. Draft attachments belong to their selected thread. Downloads support validators and byte ranges. Inline-image generation remains a Remote-owned feature worker with its own durable receipts; it does not keep the thread executing while an image provider works.
