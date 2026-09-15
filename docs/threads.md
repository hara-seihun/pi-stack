# Unified threads

## Accepted design

Orchestrator owns persistent threads, input admission, execution state and durable message delivery. Remote, fleet lanes, agents and the CLI use the same thread operations. Pi executes individual sessions. There is no selectable core or separate child runtime, scheduler, result relay or registry.

Pi is the only session engine. Astra, Sol, Terra, Luna, Fable and Opus are model choices, while retained names of other engines are import provenance. Session, settings, run and CLI operations do not accept an engine selector.

A thread has a stable ID, optional parent ID, cwd, native Pi transcript reference and settings. Its execution state describes only its own work. An idle parent with active children is idle. Native transcripts remain authoritative history; projections and live output are not additional conversation stores.

`ThreadState` is exactly `idle | running | stopped`, defined in [`contracts.ts`](../packages/orchestrator/src/threads/contracts.ts). `running` includes pending input, admission, startup, execution and cancellation until confirmed. `stopped` means held with cancellation confirmed. `idle` means no current work and no hold. Errors stay in details and execution outcomes; they do not add a lifecycle state. Queue labels describe pending messages, not threads.

The implementation contracts are documented in [Pi session execution](../packages/orchestrator/docs/pi-sessions.md) and the [thread service](../packages/orchestrator/docs/thread-service.md).

Shared-process execution remains essential. Hundreds of threads must not create hundreds of Node processes. Preserve existing machine, Unix-person, encrypted-storage, isolated-application and root-repair boundaries. Runtime resources may unload while durable threads persist.

## Messages and controls

Humans and agents have the same operations:

- Spawn always creates a fresh thread with a fresh context and initial assignment. Continuing an existing thread means sending it a message.
- Queue waits for the recipient's current execution to finish.
- Steer delivers at a safe boundary after current tool calls without cancelling them.
- Hard steer cancels current execution and its local tools, confirms cancellation, then runs the selected message first in the same conversation. Other pending messages retain their order. It does not cancel descendants or undo external effects.
- Stop cancels current execution and holds pending messages. Its request explicitly selects this thread or this thread and descendants.
- Resume releases held messages. With no pending messages it changes nothing and returns `no_pending_messages`.
- An explicit new human or agent message to a stopped thread resumes it with that message ahead of held messages. Held messages retain their relative order.
- Automatic child-idle notifications do not resume a stopped parent.

Remote's main Threads tab lists only parentless person conversations. The Orchestrator tab lists fleet threads and children using the same thread identities and controls. The right panel lists active direct children, with an expandable Inactive children section.

Delegation has exactly one level. Person conversations create workers in their authorized Orchestrator owner when configured. Ordinary people without access to the administrator's fleet retain workers in their own person boundary. Every parented thread, including existing records, and every fleet or isolated-application thread is a leaf worker. The owning service derives this role from custody and parentage, not client metadata. Workers do not receive `thread_spawn`, and the backend rejects recursive spawning even from already-running sessions with older tool schemas. Held or archived parents cannot create new workers, including while cancellation is unconfirmed. Local receipts are checked before forwarding creation so retries preserve previously accepted child identities. Existing transcripts and receipts remain with their current owner; they appear only in Orchestrator, not the main drawer.

Encrypted-folder workers also stay in their person's mount namespace and transcript custody. These remain leaf workers in the Orchestrator view. Worker tool eligibility is sent explicitly per session as `PI_THREAD_CAN_SPAWN=0`; conversations receive `1`. Shared runner processes do not carry this setting between sessions. Agent CLI `run` calls preserve the calling thread as parent and use its authorized API; agents cannot use unparented `wave` calls. Stop-with-descendants and child discovery traverse authorized owners, while durable completion notifications return through the directory to the original parent.

The UI stops a thread directly when there are no subthreads. Otherwise it asks "Should the subthreads stop too?" with "Yes, stop subthreads" and "No, just stop this thread" choices.

An execution has exclusive ownership of its thread. Cancellation fences late callbacks but must also stop local effects. Failure to confirm cancellation is a visible failure, not permission to start overlapping execution. Tools receive cancellation signals. CPU-blocking work belongs outside the shared event loop, without a separate Node process per agent.

## Relationships and notifications

Threads can list all accessible threads in their current environment or their direct children, read persisted history without starting a recipient, and send queue/steer/hard-steer messages to other accessible threads. Workers retain these collaboration tools but cannot spawn. Parentage determines discovery and automatic notifications, not aggregate execution state.

When a child's execution settles, commit its outcome and parent notification durably. Include thread/work IDs, normal/error/cancelled outcome, and that execution's final assistant message or an explicit absence. Deliver through ordinary messaging, with stable receipt identity and restart-safe deduplication. Notifications steer busy parents at the next safe boundary and wake idle parents, but remain held for stopped parents. Idle is not proof that an assignment succeeded.

## Defaults

Remote asks its naming model for one to three words. That is a style preference,
not a validity condition. Generated titles must contain 3–60 characters, cannot be
purely numeric, and cannot contain control characters. The parser removes heading
and quote wrappers and skips colon-ended introductions. Thread 1665 exposed the
word-count defect when three completed requests returned useful four- or five-word
AI Summit titles. Completed naming outputs remain in the completion ledger; repair
reuses that output rather than submitting another inference.

Remote can archive settled threads automatically with the person environment setting
`PI_REMOTE_AUTO_ARCHIVE_AFTER_MS=3600000` (one hour). The default is `0`, disabled.
A non-overlapping sweep runs every minute across that person's local and fleet directory.
Only idle or stopped threads with no pending messages and no activity newer than the
cutoff qualify. Running threads, pending messages and in-flight command work are retained,
and active/recent nonarchived descendants protect their parents. The owning service's
`archiveInactive` control rechecks eligibility synchronously without stopping execution;
older owners reject this action rather than interpreting it as an unconditional archive.
Archiving hides a thread without deleting history. Restoring resets the inactivity clock
but does not resume held work. Merely viewing a thread does not reset its clock.

Remote imports the Orchestrator source API through Bun, while shared runners execute
the compiled Node entrypoint in `dist/threads/runner-host.js`. Both source and compiled
callers resolve that same executable; build Orchestrator before starting source Remote.

Whether a native session must already exist is a per-thread instruction, never a shared
runner default. Controllers send `PI_THREAD_REQUIRE_SESSION=0` for fresh threads and
`1` for recovery or retained history. The explicit zero also works with previously
launched runners; new runners omit this flag from their process environment. The SDK
adapter resolves it from the individual open request. Missing required history remains
an error; a fresh child creates its own file without inheriting the first thread's flag.

Orchestrator resolves settings centrally. Standard provider speed is the default everywhere. Fable, Opus, Astra, Terra and Sol default to high thinking; Luna defaults to max. Explicit validated overrides are supported and do not accidentally inherit from a parent. Recovery preserves already accepted execution settings.

Subagents always use forced quota admission. Lanes use forced admission by default and can explicitly select background pacing. Readiness, actual quota exhaustion, account reservations, cooldowns, execution limits and explicit pause remain separate from background spending pace and reserves.

## Cutover and acceptance

Preserve existing thread identities, native conversations, parent links and pending input/result receipts. Never replay completed work. Existing imported history retains its provenance. Remove superseded owners after transferring useful state; no permanent alternate lifecycle path.

Remove the core abstraction, recursive Pi child scheduler, external fleet coordinator waiting system, Remote's independent work dispatcher/result relay, duplicated settings resolution and additional portable conversation journals. One API serves UI, CLI and agent tools. The completed change must reduce net source code substantially, not move complexity between packages.

Publication owns full checks, integration, both host deployments and Android distribution. Active execution must retain custody during activation.
