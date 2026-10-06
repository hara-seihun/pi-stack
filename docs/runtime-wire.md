# Runtime wire state dispatch

The [explicit state contract](state-dispatch.md) applies at every first-party runtime boundary, not only status rendering.

## Closed protocol owners

- [`runtime-events.ts`](../packages/orchestrator/src/threads/runtime-events.ts) owns Pi/runner event discriminators and nested assistant-update, extension-UI and summarization-retry variants. Its SDK-derived tables are compile-checked against the installed Pi event unions. Parsing returns an explicit error; an unknown event is never a known no-op.
- [`runner-protocol.ts`](../packages/orchestrator/src/threads/runner-protocol.ts) owns shared-runner transport variants. Invalid native replies produce protocol diagnostics rather than being consumed as successful responses.
- [`response-events.ts`](../packages/orchestrator/src/response-events.ts) owns OpenAI Responses event classification, checked against the pinned SDK. Intentionally non-presentational valid events have named behavior.
- [`pi-event-presentation.ts`](../apps/remote/server/pi-event-presentation.ts) assigns every runtime event to a visual projection or observation-only handling. The exhaustive record prevents a new SDK event silently disappearing from Remote.
- [`state-validation.ts`](../apps/remote/shared/state-validation.ts) validates app stream state before mutating client state. It rejects invalid discriminators rather than entering a reconnect grace period with misleading UI.

Lifecycle and outcome remain separate. Unknown terminal outcomes and assistant stop reasons cannot become successful completion; `pending` and `deferred` are explicitly nonterminal. Native completion receipts can settle a turn that produced no assistant message. Known tool-only turns remain supported.

A child-derived wait has explicit `waitingForChildren` evidence from the server's actual direct-child census. A typed durable wait names its [dependency](threads.md#durable-dependency-waits-and-own-thread-wakes). An idle lifecycle paired with a running phase is an instrumentation error, not an alternate spelling of idle.

Unknown transcript roles/content blocks preserve their content in an unsupported notice; they are not reclassified as ordinary assistant or tool messages. Open-ended provider content stays evidence, with explicit unsupported diagnostics when it is outside the presentation contract.

Compaction's durable operation state is also closed. An invalid stored state produces a repair diagnostic and blocks automatic reinterpretation as a retryable failure. An explicit compact operation may supersede the invalid attempt through the existing owning recovery path; history is not silently rewritten.
