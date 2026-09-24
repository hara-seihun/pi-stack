# Unified threads

## Accepted design

Orchestrator owns persistent threads, input admission, execution state and durable message delivery. Remote, fleet lanes, agents and the CLI use the same thread operations. Pi executes individual sessions. There is no selectable core or separate child runtime, scheduler, result relay or registry.

Pi is the only session engine. Astra, Sol, Luna, Fable and Opus are model choices, while retained names of other engines are import provenance. Session, settings, run and CLI operations do not accept an engine selector.

A thread has a stable ID, optional parent ID, cwd, native Pi transcript reference and settings. Its execution state describes only its own work. An idle parent with running children keeps execution state `idle`, but Remote displays `AWAITING` in the drawer, thread header and live activity indicator. This display includes direct children in either the person or fleet owner and returns to `IDLE` when the last running child settles. A held parent also remains idle; clients compose its held label from `thread.held`. Native transcripts remain authoritative history. Projections and live output are not additional conversation stores.

`ThreadState` is exactly `idle | running`, defined in [`contracts.ts`](../packages/orchestrator/src/threads/contracts.ts). `running` includes pending input, admission, startup, execution and cancellation until confirmed. `idle` means the thread has no current work. The separate `held` boolean prevents queued input from starting. Stop leaves the thread `{ state: "idle", held: true }` after cancellation is confirmed, and resume clears `held`. Errors stay in details and execution outcomes; they do not add a lifecycle state.

A message moves through `queued`, `dispatched` and `done`. A held thread does not change a queued message's state. Clients use the thread's `held` field when they need a held-queue label. `insertedAt` records when Pi accepted the message, while `outcome` records `complete`, `failed` or `cancelled` after settlement. An execution is active exactly while `ended_at` is null; the execution table has no separate state column.

The implementation contracts are documented in [Pi session execution](../packages/orchestrator/docs/pi-sessions.md) and the [thread service](../packages/orchestrator/docs/thread-service.md).

Shared-process execution remains essential. Hundreds of threads must not create hundreds of Node processes. Preserve existing machine, Unix-person, encrypted-storage, isolated-application and root-repair boundaries. Runtime resources may unload while durable threads persist.

## Messages and controls

Humans and agents use the same thread API, with one delivery restriction:

- Spawn always creates a fresh thread with a fresh context and initial assignment. Continuing an existing thread means sending it a message.
- Agent-to-agent messages always use steer or hard steer. They default to steer. A request with `senderId` and `delivery: "queue"` is invalid.
- Human messages default to queue and may explicitly use queue, steer or hard steer.
- Queue waits for the recipient's current execution to finish.
- Steer delivers at a safe boundary after current tool calls without cancelling them.
- Hard steer cancels current execution and its local tools, confirms cancellation, then runs the selected message first in the same conversation. Other pending messages retain their order. It does not cancel descendants or undo external effects.
- Stop cancels current execution and holds pending messages. Its request explicitly selects this thread or this thread and descendants.
- Resume releases held messages. With no pending messages it changes nothing and returns `no_pending_messages`.
- An explicit new human or agent message to a held thread clears the hold and runs that message ahead of previously queued messages. Those messages retain their relative order.
- Automatic child-idle notifications do not resume a held parent.

Remote's main Threads tab lists only parentless person conversations. The Orchestrator tab lists fleet threads and children using the same thread identities and controls. The right panel lists active direct children, with an expandable Inactive children section.

Delegation has exactly one level. Person conversations create workers in their authorized Orchestrator owner when configured. Ordinary people without access to the administrator's fleet retain workers in their own person boundary. Every parented thread, including existing records, and every fleet or isolated-application thread is a leaf worker. The owning service derives this role from custody and parentage, not client metadata. Workers do not receive `thread_spawn`, and the backend rejects recursive spawning even from already-running sessions with older tool schemas. Held or archived parents cannot create new workers, including while cancellation is unconfirmed. Local receipts are checked before forwarding creation so retries preserve previously accepted child identities. Existing transcripts and receipts remain with their current owner; they appear only in Orchestrator, not the main drawer.

Encrypted-folder workers also stay in their person's mount namespace and transcript custody. These remain leaf workers in the Orchestrator view. Worker tool eligibility is sent explicitly per session as `PI_THREAD_CAN_SPAWN=0`; conversations receive `1`. Shared runner processes do not carry this setting between sessions. Agent CLI `run` calls preserve the calling thread as parent and use its authorized API; agents cannot use unparented `wave` calls. Stop-with-descendants and child discovery traverse authorized owners, while durable completion notifications return through the directory to the original parent.

The UI stops a thread directly when there are no subthreads. Otherwise it asks "Should the subthreads stop too?" with "Yes, stop subthreads" and "No, just stop this thread" choices.

An execution has exclusive ownership of its thread. Cancellation fences late callbacks but must also stop local effects. Failure to confirm cancellation is a visible failure, not permission to start overlapping execution. Tools receive cancellation signals. CPU-blocking work belongs outside the shared event loop, without a separate Node process per agent.

## Relationships and notifications

Threads can list all accessible threads in their current environment or their direct children, read persisted history without starting a recipient, and steer or hard steer other accessible threads. Humans may also queue messages. Workers retain these collaboration tools but cannot spawn. Parentage determines discovery and automatic notifications, not aggregate execution state.

The thread service wraps every agent input in the same [`<agent_message>` envelope](../packages/orchestrator/src/threads/message-format.ts) before passing it to Pi. It explicitly identifies the input as an agent-to-agent message, not a user message. Explicit messages and initial child assignments carry the sender thread, recipient thread, message receipt, source and reply reference. Completion reports show only the sender thread in envelope metadata; their body gives the worker title when known, event, outcome, final text and any error. Routing receipts stay in the thread service. Senderless human inputs remain unchanged. Formatting happens after context preparation on both first delivery and recovery, so pending inputs prepared by an earlier release gain the envelope without changing receipts or replaying completed work.

A parent can call `thread_await` with one child ID or a group of direct child IDs. The first settlement returns its outcome, final text, remaining IDs and per-thread `after` cursors. Pass the returned cursors into subsequent waits, including after sending another assignment to the same worker. Results already persisted are available immediately; waiting does not consume results or stop other children. Each model-facing call makes one owner wait of at most 25 seconds instead of hiding repeated timeouts. Status lookup on timeout has a separate two-second limit. If none arrives, it returns `settlement: null`, `timedOut: true`, the remaining IDs and latest cursors, plus a status for each remaining child. Status includes `state`, `held`, `pendingMessages` and any admission wait or execution error; an unavailable status has an explicit error. A timeout is not progress or completion. Use the status to intervene, work on independent tasks or wait again with `after`. Stop or hard steer cancels the tool; ordinary steer waits for the tool boundary, so completion notifications remain ordinary messages rather than interrupting the await.

When a child's execution settles, commit its full outcome and final assistant message to execution/work receipts and a compact parent notification to the message queue. The parent sees `thread_idle`, the worker title, `complete`/`failed`/`cancelled`, final text or null, and any error. It receives no thinking, tool calls, provider metadata, usage or opaque fields. Its envelope retains the sender thread ID so the agent can send follow-up work. Native transcripts and stored execution results retain the original message for continuation and inspection. Dispatch and recovery also project queued reports prepared by an earlier release, preserving appended meeting context and receipt identity. Agent tool previews apply the same projection to pending reports.

Deliver through ordinary messaging, with stable receipt identity and restart-safe deduplication. Notifications steer busy parents at the next safe boundary and wake idle parents, but remain queued when the parent is held. Idle is not proof that an assignment succeeded.

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
Only idle threads with no pending messages and no activity newer than the cutoff qualify. Unread idle conversations remain in Current Chats until the person reads them.
Running threads, pending messages and in-flight command work are retained, and
active or recent nonarchived descendants protect their parents. The owning service's
`archiveInactive` control rechecks eligibility synchronously without stopping execution;
older owners reject this action rather than interpreting it as an unconditional archive.

A worker's lifetime is its conversation's. Archiving a thread, by the sweep or by hand,
archives every descendant with it, across owners: `archiveInactive` marks the whole
subtree once it has verified the subtree is idle, and the directory's `update
archived` walks children in other owners after the root. A worker's unread marker
protects nothing; its reader is the agent above it. A worker whose parent is archived
or missing is archived on the next sweep as soon as it stops running, however recent,
along with any messages still queued for it: they came from the conversation that is
gone. Before
September 21, 2026 a closed conversation left its finished workers live and unread
forever, and they filled the Workers tab as parentless roots.

Closing hides a thread without deleting history. The UI's X first stops that AI and all
its descendants, then marks the root archived. A failed descendant stop keeps the chat
visible. There is no separate archive tab; the New/Open Chat picker restores previous
conversations. Restoring resets the inactivity clock but does not resume held work.
Merely viewing a thread does not reset its clock. AI completion never reopens a closed
chat; human messaging backends reopen on a fresh incoming message. Current-chat membership
and order are shared across the person's devices, while selection remains local.

Remote imports the Orchestrator source API through Bun, while shared runners execute
the compiled Node entrypoint in `dist/threads/runner-host.js`. Both source and compiled
callers resolve that same executable; build Orchestrator before starting source Remote.

Whether a native session must already exist is a per-thread instruction, never a shared
runner default. Controllers send `PI_THREAD_REQUIRE_SESSION=0` for fresh threads and
`1` for recovery or retained history. The explicit zero also works with previously
launched runners; new runners omit this flag from their process environment. The SDK
adapter resolves it from the individual open request. Missing required history remains
an error; a fresh child creates its own file without inheriting the first thread's flag.

New subagents default to Sol regardless of their parent's model. Explicit child choices are limited to OpenAI Codex models outside Astra. The thread owner rejects Anthropic and Astra child requests before forwarding to another owner. Existing spawn receipts replay unchanged. Main conversations retain explicit Anthropic selection and existing threads keep their accepted settings.

Orchestrator resolves settings centrally. Standard provider speed is the default everywhere. Fable, Opus, Astra and Sol default to high thinking; Luna defaults to max. Explicit validated overrides are supported and do not accidentally inherit from a parent. Recovery preserves already accepted execution settings.

Subagents always use forced quota admission. Lanes use forced admission by default and can explicitly select background pacing. Readiness, actual quota exhaustion, account reservations, cooldowns, execution limits and explicit pause remain separate from background spending pace and reserves.

A thread that cannot be admitted says so. When every eligible account refuses, `metadata.admissionWait` carries the refusal code, the joined per-account reasons, the instant the current reason first appeared and its latest observation. The work stays queued and reconciliation retries it, so the same unchanged reason does not bump the thread revision; the entry disappears as soon as an account is assigned or the thread is halted. A refusal that retrying cannot fix, such as an invalid request, settles the thread as failed with that message instead of waiting. Before this, an unadmitted thread sat in `running` with queued input and no recorded cause, which is how the September 18 Codex exhaustion produced subagents that never opened a session.

## Cutover and acceptance

Preserve existing thread identities, native conversations, parent links and pending input/result receipts. Never replay completed work. Existing imported history retains its provenance. Remove superseded owners after transferring useful state; no permanent alternate lifecycle path.

Remove the core abstraction, recursive Pi child scheduler, external fleet coordinator waiting system, Remote's independent work dispatcher/result relay, duplicated settings resolution and additional portable conversation journals. One API serves UI, CLI and agent tools. The completed change must reduce net source code substantially, not move complexity between packages.

Publication owns full checks, integration, both host deployments and Android distribution. Active execution must retain custody during activation.
