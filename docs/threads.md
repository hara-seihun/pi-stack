# Unified threads

A person's own Kenan can list/read/post their Pi Remote rooms with `pi-room`; the [room contract](../apps/remote/docs/rooms.md#a-persons-own-kenan) owns local kernel-UID admission, server membership and agent attribution. Room conversations remain in the separate room runtime, not the person's private thread directory.

## Accepted design

Orchestrator owns persistent threads, input admission, execution state and durable message delivery. Remote, fleet lanes, agents and the CLI use the same thread operations. Pi executes individual sessions. There is no selectable core or separate child runtime, scheduler, result relay or registry.

Pi is the only session engine. Astra, Sol, Luna, Fable and Opus are model choices, while retained names of other engines are import provenance. Session, settings, run and CLI operations do not accept an engine selector.

A thread has a stable ID, optional parent ID, cwd, native Pi transcript reference and settings. The [Sandbox profile](sandbox.md) adds a raw-context, four-tool execution boundary with a separate persistent workspace per thread. Its execution state describes only its own work. An idle parent with running or dependency-waiting children keeps execution state `idle`, but Remote displays **Waiting on agents** in the inbox, thread header and worker tree. This display includes direct children in either authorized owner. An explicit durable dependency wait can also keep that label after children stop running; it is cleared by a matching result, explicit input, a scheduled recovery wake or `thread_wait` clear. A held parent also remains idle; clients compose its held label from `thread.held`. Native transcripts remain authoritative history. Projections and live output are not additional conversation stores.

`ThreadState` is exactly `idle | running`, defined in [`contracts.ts`](../packages/orchestrator/src/threads/contracts.ts). `running` includes pending input, admission, startup, execution and cancellation until confirmed. `idle` means the thread has no current work. The separate `held` boolean prevents queued input from starting. Stop leaves the thread `{ state: "idle", held: true }` after cancellation is confirmed, and resume clears `held`. Errors stay in details and execution outcomes; they do not add a lifecycle state. Remote must not display this broad `running` flag as proof of work: its [execution status contract](../apps/remote/web/README.md#execution-status-is-evidence-not-reassurance) reports every owned pending-operation and runtime phase, treats missing instrumentation as a defect rather than a normal unknown state, and exposes elapsed phase time separately from the age of the latest activity update.

A message moves through `queued`, `dispatched` and `done`. A held thread does not change a queued message's state. Clients use the thread's `held` field when they need a held-queue label. `insertedAt` records when Pi accepted the message and `landedAt` when it entered the agent's conversation. A prompt lands on acceptance. Pi holds a steer or follow-up in its queue until the next tool boundary, or starts a turn with it when the run has already settled, then starts it as a user message with exactly the text it was sent ([native adapter](../packages/orchestrator/docs/pi-sessions.md)); the thread service records `landed_at` when it observes that `message_start`. The timestamp lives on the work row, so compaction and restarts cannot return a delivered message to a client's queue. Remote's queue shows only pending messages that have not landed. `outcome` records `complete`, `failed` or `cancelled` after settlement. An execution is active exactly while `ended_at` is null; the execution table has no separate state column.

The implementation contracts are documented in [Pi session execution](../packages/orchestrator/docs/pi-sessions.md) and the [thread service](../packages/orchestrator/docs/thread-service.md).

Shared-process execution remains essential. Hundreds of threads must not create hundreds of Node processes. Preserve existing machine, Unix-person, encrypted-storage, isolated-application and root-repair boundaries. Runtime resources may unload while durable threads persist.

## Messages and controls

Humans and agents use the same thread API, with one delivery restriction:

- Spawn always creates a fresh thread with a fresh context and initial assignment. Continuing an existing thread means sending it a message. A subagent may be ephemeral: it archives as soon as its last accepted assignment settles, after the parent notification and result are saved. Its transcript, files and other effects persist. Model-tool spawns default to ephemeral; set `ephemeral: false` when follow-up work is planned. Other API callers select it explicitly.
- Agent-to-agent messages always use steer or hard steer. They default to steer. A request with `senderId` and `delivery: "queue"` is invalid.
- Human messages default to steer and may explicitly use queue, steer or hard steer.
- Queue waits for the recipient's current execution to finish.
- Steer delivers at a safe boundary after current tool calls without cancelling them.
- Hard steer cancels current execution and its local tools, confirms cancellation, then runs the selected message first in the same conversation. Other pending messages retain their order, including steers already accepted into Pi's native queue but not yet entered into the conversation. Cancelling the turn returns those inputs to durable queued state with the same receipt, settings and prepared payload; landed inputs are never replayed. It does not cancel descendants or undo external effects.
- Stop cancels current execution and holds pending messages. The foreground Stop button immediately stops only the selected thread, without a scope dialog; its workers keep running. API and agent control requests explicitly select this thread or this thread and descendants.
- Resume releases held messages. With no pending messages it changes nothing and returns `no_pending_messages`.
- An explicit new human or agent message to a held thread clears the hold and runs that message ahead of previously queued messages. Those messages retain their relative order.
- Automatic child-idle notifications do not resume a held parent.

Remote's main Threads tab lists only parentless person conversations. The Orchestrator tab lists fleet threads and children using the same thread identities and controls. The right panel lists active direct children, with an expandable Inactive children section.

Delegation has exactly one level. Person conversations create workers in their authorized Orchestrator owner when configured. Ordinary people without access to the administrator's fleet retain workers in their own person boundary. Every parented thread, including existing records, and every fleet or isolated-application thread is a leaf worker. The owning service derives this role from custody and parentage, not client metadata. Workers do not receive `thread_spawn`, and the backend rejects recursive spawning even from already-running sessions with older tool schemas. Held or archived parents cannot create new workers, including while cancellation is unconfirmed. Local receipts are checked before forwarding creation so retries preserve previously accepted child identities. Existing transcripts and receipts remain with their current owner; they appear only in Orchestrator, not the main drawer.

Encrypted-folder workers also stay in their person's mount namespace and transcript custody. These remain leaf workers in the Orchestrator view. Worker tool eligibility is sent explicitly per session as `PI_THREAD_CAN_SPAWN=0`; conversations receive `1`. Shared runner processes do not carry this setting between sessions. Agent CLI `run` calls preserve the calling thread as parent and use its authorized API; agents cannot use unparented `wave` calls. Stop-with-descendants and child discovery traverse authorized owners, while durable completion notifications return through the directory to the original parent.

The UI stops a thread directly when there are no subthreads. Otherwise it asks "Should the subthreads stop too?" with "Yes, stop subthreads" and "No, just stop this thread" choices.

An execution has exclusive ownership of its thread. Cancellation fences late callbacks but must also stop local effects. Failure to confirm cancellation is a visible failure, not permission to start overlapping execution. Tools receive cancellation signals. CPU-blocking work belongs outside the shared event loop, without a separate Node process per agent.

## Caller identity

Thread owners listen on loopback, and until September 28, 2026 they believed whatever a request said. Any local process could create a child under any thread, send as any thread, or create a root that looked like a person's conversation. Converge grants autonomous sessions less authority than conversations with a watching administrator, and one `curl` escaped that limit. Owners now resolve every spawn and send to a verified caller, in [`caller.ts`](../packages/orchestrator/src/threads/caller.ts):

- **thread**: the request carries `x-pi-thread-token`. The owner puts `PI_THREAD_TOKEN`, an HMAC of the thread ID under the person's key, in every session's environment next to `PI_THREAD_ID`. Thread tools and the `pi-orchestrator` CLI send it. Runner processes never hold one.
- **runtime** and **service**: the loopback peer is a shared thread runner, a Remote supervisor or an Orchestrator daemon, found from `/proc/net/tcp` and the socket's owning process, with no thread runner among its ancestors. They may name the thread they act for. Sessions opened before tokens existed keep working through this rule.
- **person**: the local router (peer uid 0) or another host's router presenting a credential listed in host `upstreamCredentials`.
- **process**: everything else, recorded by uid, pid and command.

A thread may create only its own children and send only as itself; it cannot send as a person. Runtime, service and person callers may name a parent or sender. Root-owned runners (root repair) arrive as uid 0 like the router. A process may not name a parent or an agent sender. A process may still queue human-form messages; publication reports use that route. Refusals return HTTP 403, and an invalid token or untrusted upstream credential returns 401.

Every thread an owner creates records `metadata.createdBy` from that caller: `{kind:"thread",threadId}`, `{kind:"person",via}`, `{kind:"process",uid,pid,command,attestation}`, or `runtime`/`service`. Clients cannot set it; a service forwarding a creation to another owner carries the original creator. The creator is excluded from the spawn receipt, so retries keep their identity. With host `callerAttestation`, the owner runs that command on a creating process's pid and stores its JSON. Root threads therefore say who made them: a person through a router, a thread's tools, or a named local process with the host's verdict.

Everything runs as the person's own Unix user. A process that deliberately reads another session's environment or the key file can still impersonate that thread. The boundary stops ordinary API use, the CLI and thread tools from forging custody; it is not a defense against a determined process with the same uid.

## Asynchronous user questions

`request_user_input_async` stores a pending question with its thread owner and returns immediately. Suggestions have no fixed count; one may be explicitly recommended. Human answers combine zero or more selections with free text, with only an entirely empty answer rejected. An explicit dismissal settles a question without answering or authorizing a suggestion and delivers a correlated human steer saying it was skipped. Durable question identity correlates the answer to its question, and ordinary human steer delivery supplies it at a safe boundary without cancelling work. Questions remain pending beyond the current turn and across restarts. Asking also atomically records an owner-local sequenced occurrence for client notifications; accepted questions advance notification cursors without replaying an alert. The [Remote question contract](../apps/remote/docs/questions.md) describes the shared client and API.

Root-owned permission questions are different: a `rootConsent` inbox question whose durable ask receipt is `consent:ID:question` stores its answer for RootConsentManager without queuing an ordinary agent turn. The owner exposes that receipt through `questionState`, history reads and display-context projection; Remote overlays it even over an already captured local conversation. Retries preserve the same answer and acceptance time. Answering does not release unrelated held work or restore an archived inbox, and dismissal authorizes nothing. Ordinary messages and ordinary async questions in that same inbox retain normal delivery. Historical answers that already have a `question-answer:ID` work record remain owned by native delivery and are not projected again. A later inbox agent can read receipt-only answers through its own `thread_read`; they are not injected into its native prompt.

## Personal watch list

Every normal thread can maintain its person's [watch list](watch-list.md) with `watch_list`, `watch_list_add`, `watch_list_update` and `watch_list_remove`. The unlocked Remote supervisor stores it in the existing encrypted thread database and starts a visible Opus 5.5 check only for due items. Major decisions use the asynchronous question tool. Fleet tools route to the person's owner rather than storing private checks in the fleet ledger. Watch checks are root conversations visible in Chats but cannot create workers.

## Rooms

With the host's `oneKenan` flag enabled, a fresh Remote conversation may be a [room](../apps/remote/docs/rooms.md). The router authenticates membership and stamps each actual speaker. A dedicated unprivileged `pi-rooms` supervisor is custodian; the creator is recorded separately. Room-local traces are transparent, and its only tools are `ask_kenan` and asynchronous public questions. Root receives the current full audience from a trusted directory lookup, never from request text. `metadata.room.members` supplies the full audience to turn instructions, and notifications reach each member's own supervisor ledger. The public room API is separate from private supervisor context/stream access.

## Relationships and notifications

Threads can list all accessible threads in their current environment or their direct children, read persisted history without starting a recipient, and steer or hard steer other accessible threads. Humans may also queue messages. Workers retain these collaboration tools but cannot spawn. Parentage determines discovery and automatic notifications, not aggregate execution state.

The thread service wraps every agent input in the same [`<agent_message>` envelope](../packages/orchestrator/src/threads/message-format.ts) before passing it to Pi. It explicitly identifies the input as an agent-to-agent message, not a user message. Explicit messages and initial child assignments carry the sender thread, recipient thread, message receipt, source and reply reference. Completion reports show only the sender thread in envelope metadata; their body gives the worker title when known, event, outcome, final text and any error. Routing receipts stay in the thread service. Senderless human inputs remain unchanged. Formatting happens after context preparation on both first delivery and recovery, so pending inputs prepared by an earlier release gain the envelope without changing receipts or replaying completed work.

`inspect(threadId, { contextRevision })` lets a caller that already holds an idle thread's context at that revision skip it: the owner returns the thread, pending messages and live projection without reading the native history. Remote uses this when a fleet thread is reopened, so an unchanged thread with a large history is not reread on every selection. Its display projection is normally cached within a 64 MB budget; a larger one is kept only while some client has that thread open, so reselecting it does not reproject the history either.

A parent can call `thread_await` with one child ID or a group of direct child IDs. The first settlement returns its outcome, final text, remaining IDs and per-thread `after` cursors. Pass the returned cursors into subsequent waits, including after sending another assignment to the same worker. Results already persisted are available immediately; waiting does not consume results or stop other children. Each model-facing call makes one owner wait of at most 25 seconds instead of hiding repeated timeouts. Status lookup on timeout has a separate two-second limit. If none arrives, it returns `settlement: null`, `timedOut: true`, the remaining IDs and latest cursors, plus a status for each remaining child. Status includes `state`, `held`, `pendingMessages` and any admission wait or execution error; an unavailable status has an explicit error. A timeout is not progress or completion. Use the status to intervene, work on independent tasks or wait again with `after`. Stop or hard steer cancels the tool; ordinary steer waits for the tool boundary, so completion notifications remain ordinary messages rather than interrupting the await.

When a child's execution settles, commit its full outcome and final assistant message to execution/work receipts and a compact parent notification to the message queue. The parent sees `thread_idle`, the worker title, `complete`/`failed`/`cancelled`, final text or null, and any error. It receives no thinking, tool calls, provider metadata, usage or opaque fields. Its envelope retains the sender thread ID so the agent can send follow-up work. Native transcripts and stored execution results retain the original message for continuation and inspection. Dispatch and recovery also project queued reports prepared by an earlier release, preserving appended meeting context and receipt identity. Agent tool previews apply the same projection to pending reports.

Deliver through ordinary messaging, with stable receipt identity and restart-safe deduplication. Notifications steer busy parents at the next safe boundary and wake idle parents, but remain queued when the parent is held. Idle is not proof that an assignment succeeded.

## Durable dependency waits and own-thread wakes

Use `thread_wait` as the final tool call when no useful local work remains. It stores the reason and optional direct child dependencies, then ends the native turn without another model request:

```json
{ "action": "set", "reason": "Need the build worker's result", "threadIds": ["build-worker"], "after": { "build-worker": 12 } }
```

`after` is optional and uses the same per-child settlement cursors as `thread_await`; omitted cursors start at zero. A missing or unrelated child is rejected. An already-settled dependency or result queued during registration does not create a stale wait. For another assignment to the same persistent worker, use its latest cursor. Clear with `{ "action": "clear" }`. Every operation concerns the calling thread itself, not another thread selected by the model.

The thread remains `state: "idle"`, with a typed `waitingOnAgents: {reason,threadIds,after,since}` and the owner-owned `metadata.agentWait`. It releases its model lease and stops inference; its idle native session remains eligible for warm reuse and ordinary idle reclamation. Remote and Android say **Waiting on agents**, show the dependency and wait time, and do not issue a completion notification while a root or descendant still waits. A live `thread_await` tool also reports an observed `waiting_on_agents` execution phase. Human questions, account admission, provider/backoff waits, stopped/archived threads and ordinary idle stay distinct. Stop/archive labels take precedence and retain the wait information for inspection. Waiting/scheduled threads resist inactivity archiving; an ephemeral worker keeps custody while it waits or owns a wake.

Child settlements remain the primary resumption event: their existing durable result message clears a matching wait, steers a busy parent or resumes an idle parent. It never releases a hold or restores an archive. Explicit input clears waiting through ordinary messaging. Waiting is not an assertion that a child succeeded, and ending a native turn is not completion of all dependent work.

For durable external work or recovery from missed events, set a periodic wake **before** waiting:

```json
{ "action": "set", "reason": "Check the durable release receipt", "cadenceMs": 120000, "nextDueAt": 1791000120000 }
```

This is `thread_wake`, not the personal watch list. It stores one schedule for the agent's **existing thread**, preserves its history/workspace/model, and creates no new root or separate agent. Set changes the reason/cadence and retimes the check; omitted `nextDueAt` defaults to now plus cadence. List with `{ "action": "list" }`; cancel with `{ "action": "cancel" }` once resolved. Cadence is an integer of at least 60000 ms and next due is Unix epoch milliseconds. It is independent of the person's watch-list batch floor or whether personal checks are enabled.

The existing ThreadService reconciliation tick (five seconds, no inference) queues one due notification only when the thread is idle, unheld, unarchived and has no pending/active work. SQLite commits the message identity and next due together. An overdue schedule coalesces missed intervals into one check and advances from actual delivery; busy/admission-delayed work cannot build a wake backlog or overlap execution. Restart retains the exact receipt. Normal model admission decides when that accepted input can execute; it never substitutes a different model. Stop/archive pause new delivery without discarding the schedule. Restore alone leaves a hold intact. Cancel removes future scheduling and any still-queued, unstarted wake, but does not cancel native work already dispatched.

`Thread.wakeSchedule`, `thread_wake` list, and the shared inspector expose `reason`, `cadenceMs`, `nextDueAt`, optional `lastDueAt`, `lastDeliveredAt`, `lastMessageId`, `lastLandedAt` and `deferredReason` (`busy`, `stopped`, `archived`). Due times are requests, not promises of model capacity: `lastDueAt` versus `lastDeliveredAt` records scheduler delay, and queue/landing/admission evidence records execution delay. An overdue `nextDueAt` remains visible while paused or busy. The next check is observed within one reconciliation tick once eligible.

The owner API uses `POST /v1/threads/agentWait` (`set`/`clear`) and `/v1/threads/wakeSchedule` (`set`/`list`/`cancel`), carrying `threadId` and a stable `requestId` for mutations. Native tools derive these from their own thread and tool-call ID. The usual thread capability verifies self, rejects another person's key, and routes only through authorized owners. Runtime/service forwarding is admitted; senderless processes and human routers cannot impersonate self-scheduling tools. Mutation receipts and the `thread_wake` table live beside ordinary messages in each owner's thread database, never in a general watch store.

Focused lifecycle proof: `npm test --workspace=pi-orchestrator -- tests/thread-wake.test.ts tests/thread-wake-native.test.ts`. The native test uses real Pi, SQLite and authenticated loopback HTTP with a synthetic provider (no credentials or external inference), replaces its controller, and renders the same browser/Android status component through that transport. Set `PI_THREAD_WAKE_PROOF_DIR` to retain its JSON transitions and HTML status artifacts. Remote status/notification proofs are `bun test apps/remote/server/live-projection.test.ts apps/remote/server/thread-notifications.test.ts apps/remote/web/thread-activity.test.ts`.

## Model availability

Machine → Models enables or disables offered models globally for everyone's new threads on the selected host. Only the host administrator (`fleetUser`) can edit; everyone else sees read-only enabled/disabled states. All Remote and Orchestrator person owners live-read the same `/var/lib/pi-stack/model-availability/policy.json` file. `PI_STACK_MODEL_AVAILABILITY_PATH` overrides the path for fixtures; there are no per-person overrides:

```json
{ "version": 1, "disabled": ["openai-codex/gpt-6-astra", "anthropic/claude-fable-5-1"] }
```

A missing file enables every model. Writes replace it atomically, preserving unrelated choices. A malformed or unreadable policy rejects new creation rather than silently enabling models. The policy is live-read at creation, so no restart is needed. Catalog names, physical IDs and numbered pool providers resolve to the same identity. Admission checks resolved settings before committing new roots or children, including CLI, direct thread APIs, scheduled work and private workers. Retrying a previously accepted creation retains its thread; imports and restored threads retain their state. Existing threads can continue, resume and change settings. Disabling never cancels them, changes their model or changes account availability; application completions and thread naming are unaffected. Existing child-model restrictions still apply when a model is enabled.

The Remote dashboard always exposes `modelAvailability` and `canManageModels`; the latter is true only for the host administrator. Bootstrap start profiles omit disabled models. Administrator-only `PUT /v1/models/:id/availability` accepts `{ "enabled": true }` or `false` and returns `{ "models": [...] }`; provider/model IDs use encoded path segments. An open stale picker cannot bypass server admission. A disabled configured default is rejected when requested rather than silently substituting another model. Each host has one global policy shared by every person; both household machines are seeded with the requested disablements.

## Explicit thread names

Models can use `thread_control` with `{ "action": "rename", "title": "Chosen name" }`
to rename their own thread; `threadId` selects another accessible thread. This uses
the same durable owner as a person's title edit. Both `rename` and `update` with
`title` persist `metadata.titleSource: "manual"`. The name stays pinned through
new messages, controller restarts, archive/restore and automatic naming results
already in flight. A later explicit rename replaces it and remains pinned.
Blank or missing rename titles are rejected without changing the thread.

Only the internal automatic naming path writes titles with `automaticTitle: true`;
it records `titleSource: "auto"` and cannot overwrite a manual title. Untagged
existing threads continue automatic naming until explicitly renamed. Title-source
metadata cannot be changed through a metadata patch.

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
Only idle threads with no pending messages and no activity newer than the cutoff qualify. A conversation's hour starts when any authorized person views it while it is idle, not when it finishes. Unseen and unread idle conversations remain in Current Chats. Opening or returning to an idle conversation resets the hour; if it finishes while visible, that counts as an idle view. Background selection and agent reads do not count. New activity invalidates the previous idle view, so the next idle period needs another view.
Running threads, pending messages and in-flight command work are retained, and
active or recent nonarchived descendants protect their parents. The owning service's
The owner stores the view as `metadata.autoArchiveViewedAt` through `control(view)`, without changing execution activity or `updatedAt`. Remote records the view before clearing unread, and state refreshes do not continually reset an already armed timer. `archiveInactive` control rechecks the view deadline and subtree eligibility synchronously without stopping execution, so a view arriving after the sweep's list read still prevents an immediate archive. The view survives restarts; conversations without one are not backdated.

A persistent worker's lifetime is its conversation's. An ephemeral worker archives after its final assignment settles; it never waits in the active worker list for the inactivity sweep. Archiving a thread, by the sweep or by hand,
archives every descendant with it, across owners: `archiveInactive` marks the whole
subtree once it has verified the subtree is idle, and the directory's `update
archived` walks children in other owners after the root. A worker's unread marker
protects nothing; its reader is the agent above it. Workers still expire without a human view, but opening an idle worker gives it and its ancestors a fresh hour. A worker whose parent is archived
or missing is archived on the next sweep as soon as it stops running, however recent,
along with any messages still queued for it: they came from the conversation that is
gone. Before
September 21, 2026 a closed conversation left its finished workers live and unread
forever, and they filled the Workers tab as parentless roots.

Closing hides a thread without deleting history. The UI's X first stops that AI and all
its descendants, then marks the root archived. A failed descendant stop keeps the chat
visible. There is no separate archive tab; the New/Open Chat picker restores previous
conversations. Restoring clears the previous idle-view clock but does not resume held work; viewing the restored idle conversation starts a fresh hour.

A stop with `reason: "archive"` (the X, and the stop inside `update archived`) records
`metadata.archiveInterruption` on every thread it takes out of play that was not
already held, with the execution it cancels. The `restore` control
(`{ action: "restore", descendants, resume? }`) unarchives a thread or, with
`descendants: true`, its whole subtree across owners, deepest first. With
`resume: true` each recorded thread returns to play: an interrupted turn gets one
continuation message (request `archive-resume:THREAD:EXECUTION`), held queued work is
released, an idle thread is unheld so worker results wake it, and the archive's
still-undelivered "cancelled" result for the parent is withdrawn. Threads that were
already stopped stay stopped, and a later send, resume or deliberate stop discards the
record. Remote's Undo after X restores the subtree with `resume: true`; X asks for
confirmation first when workers below the chat are running. Agents restore with
`thread_control` `restore`, and `thread_send` restores an archived descendant of the
calling thread before delivering. On September 28, 2026 an accidental archive of a
coordinator cancelled 19 running workers and only raw HTTP could restore them.
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

New subagents default to Sol regardless of their parent's model. A child may explicitly choose Opus or another installed model outside the Astra and Fable families; the thread owner rejects Astra and Fable child requests before forwarding to another owner. Existing spawn receipts replay unchanged. Main conversations retain explicit Anthropic selection and existing threads keep their accepted settings.

Orchestrator resolves settings centrally. Standard provider speed is the default everywhere. Fable, Opus, Astra and Sol default to high thinking; Luna defaults to max. Explicit validated overrides are supported and do not accidentally inherit from a parent. Astra also accepts an explicit `ultrafast` speed override in Remote settings, CLI `--speed ultrafast`, and thread settings; other models reject it. It sends `service_tier: "ultrafast"` without changing thinking or defaults. The [provider request contract](../packages/orchestrator/docs/pi-sessions.md) records Codex's advertised tiers and observed responses; selecting a tier requests it, rather than proving the provider used it. Recovery preserves already accepted execution settings unless the owner explicitly selects `retryWaiting` for dormant provider/admission waiting work after saving a new model. `settings` remains future-only for model changes; `effectiveSettings` names current accepted/next queued work. The explicit waiting switch preserves native work IDs, original execution attribution and durable retry provenance, and uses the new selection across restart without interrupting genuine live work. Remote shows the effective waiting model and offers “Switch waiting work to selected model”. Same-model selections do not bypass real quota/backoff. A settings change that arrives while the thread's session is still opening waits for the open and is then applied to the new session. It does not fail with an unavailable session: Voice lowers the meeting thread's thinking at the moment a name mention's prompt opens that thread.

Subagents always use forced quota admission, except under a thread mode that declares its own. A thread mode (`metadata.mode`, declared in [`modes.ts`](../packages/orchestrator/src/threads/modes.ts)) sets a conversation's admission, default settings, kept tools and bash ceiling, and its workers' defaults; children inherit it and cannot change it. `live`, for live consulting such as a meeting, makes the conversation an Astra dispatcher (dispatching and meeting tools, ten-second bash) at Ultrafast speed, and gives its workers priority speed and live admission. Forced and live admission both bypass background machine and account session ceilings and choose the least-loaded eligible account first. Lanes use forced admission by default and can explicitly select background pacing. Readiness, actual quota exhaustion, account reservations, cooldowns, execution limits and explicit pause remain separate from background spending pace and reserves.

A thread that cannot be admitted says so. When every eligible account refuses, `metadata.admissionWait` carries the refusal code, the joined per-account reasons, the instant the current reason first appeared and its latest observation. The work stays queued and reconciliation retries it, so the same unchanged reason does not bump the thread revision; the entry disappears as soon as an account is assigned or the thread is halted. A refusal that retrying cannot fix, such as an invalid request, settles the thread as failed with that message instead of waiting. Before this, an unadmitted thread sat in `running` with queued input and no recorded cause, which is how the September 18 Codex exhaustion produced subagents that never opened a session.

A running thread treats a provider rate limit as a capacity wait, not a task result. The refusing account is cooled for the limit class the provider named (a monthly spend ceiling for a day, a burst throttle for a minute). Interactive routing tries each usable sibling at most once until an answer succeeds; fresh exhausted model-binding meters are excluded, even when a cooling sibling is probed. Native retries cannot request an account already refused in that round. Assigned Fleet executions wait for re-admission instead of retrying their pinned refused account. A later qualifying answer from any consumer lifts a hold early under the [evidence rule](../packages/orchestrator/README.md).

The native runner owns settlement and re-evaluates it every 30 seconds as well as on events. If a run ends with steering still queued in Pi (a run that ended on a terminal error leaves Pi's queue unconsumed), the runner runs that queue instead of waiting on it, so accepted input always reaches a turn and the execution settles.

Exhausting the round stores `metadata.providerWait` (execution/work IDs, failure, since and predicted `retryAt`) and `metadata.admissionWait`. Work stays running and dispatched under the same execution; no thread settlement, parent result or `thread_idle` is emitted. The idle native runner and account lease are released. Reconciliation reads current capacity evidence, then re-admits the accepted model/thinking/speed and resumes the failed native work without duplicating its original input. Explicit stop cancels the wait. Broker-only owners use a durable retry schedule rather than immediate model loops. Cold `get_state` reads idle/waiting owner state without model admission; its `source: thread-owner`, `threadState`, `pendingWorkCount` and `providerWait` distinguish durable waiting from native streaming. Transient failures that are not account capacity take the same waiting path: a fenced compaction (`Native compaction failed`, `Auto-compaction failed`, or a named compaction retry time) and dropped transports (`fetch failed`, resets, closed WebSockets, 5xx). They resume no earlier than `retryAt`: the failure's own named retry time, or a backoff that doubles per consecutive failure of the same execution from 30 seconds to a 30-minute cap (`metadata.providerWait.attempts`, carried across resumes as `metadata.providerRetry`). Nothing in this path waits for a manual retry, so a transient failure always runs again.

## Cutover and acceptance

Preserve existing thread identities, native conversations, parent links and pending input/result receipts. Never replay completed work. Existing imported history retains its provenance. Remove superseded owners after transferring useful state; no permanent alternate lifecycle path.

Remove the core abstraction, recursive Pi child scheduler, external fleet coordinator waiting system, Remote's independent work dispatcher/result relay, duplicated settings resolution and additional portable conversation journals. One API serves UI, CLI and agent tools. The completed change must reduce net source code substantially, not move complexity between packages.

Publication owns full checks, integration, both host deployments and Android distribution. Active execution must retain custody during activation.
