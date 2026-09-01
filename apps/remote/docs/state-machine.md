# Pi Remote state machine

Pi Remote treats SQLite and one per-thread runtime projection as the authority. Clients are projections only: they may show a short-lived local action overlay, but they never invent an authoritative lifecycle transition.

Each supervisor process first writes a random `supervisor_epoch` lease to SQLite. Every API request, runtime event, reconciliation, activation continuation, work worker, and child-exit callback verifies that lease before durable mutation. This fences an old supervisor incarnation that is still unwinding while its replacement has already reset and adopted the database; its late `SIGTERM` child exit cannot overwrite the replacement's `STOPPED` state with `FAILED`.

## Server lifecycle

Each live RPC child has exactly one phase:

| Phase | Meaning | Public state |
|---|---|---|
| `STARTING` | Child exists; initial `get_state` has not completed | `STARTING` |
| `IDLE` | Child is ready and Pi has no active or pending run | `IDLE` |
| `DISPATCHING` | An idle `prompt` was durably dispatched, but `agent_start` has not proved the run yet | `RUNNING` / `QUEUED` |
| `RUNNING` | Pi has proved an active run; steering/follow-up messages stay in this phase | `RUNNING` |
| `ABORTING` | Pi is stopping the active operation in the existing child; accepted steering may still complete | `ABORTING` |
| `STOPPING` | The idle reaper, archiving, or supervisor shutdown is removing the child | `ABORTING` until process exit, then `STOPPED` |

`phaseVersion` changes on phase transitions, dispatches, queue changes, and Pi activity. A `get_state` reconciliation captures this version before its RPC request and discards the response if the version changed while it was in flight. This prevents an old inactive snapshot from settling newer work.

### Valid transitions

```text
(no runtime) -> STARTING -> IDLE
IDLE -> DISPATCHING -> RUNNING -> IDLE
RUNNING -> RUNNING                 queued steer/follow-up
STARTING -> STARTING                   cancel claimed work before dispatch
DISPATCHING|RUNNING -> ABORTING -> IDLE
IDLE -> STOPPING                       fifteen-minute inactivity reaper
any live phase -> STOPPING -> STOPPED|FAILED
FAILED|STOPPED -> STARTING         later activation/retry
```

Only `RUNNING -> IDLE` can ordinarily settle dispatched work. `agent_settled` in `DISPATCHING` is stale and ignored. In `RUNNING`, it starts a next-tick `get_state` check rather than settling by itself. The state-compactor aborts the low-level run before Pi reports compaction, then starts a continuation from the compaction callback. Its intermediate `agent_settled` therefore arrives before `compaction_start`; Pi's state already reports the compaction, so the check keeps the work and runtime alive. During `ABORTING`, the abort handler owns the phase transition, while Pi may finish steering it already accepted before `abort()` returns. `STOPPING` suppresses output. An assistant message with `stopReason=error|aborted` is held until confirmed settlement: a later successful assistant message in the same run clears it, so automatic retry, account failover, or compaction does not expose a false terminal failure. If the run settles without recovery, the provider error remains in the supervisor event ledger for voice and diagnosis. The interactive view comes from Pi's model context rather than this event projection.

## Durable work

Work items move through:

```text
queued -> running -> dispatched -> complete
   |         |            |
   +---------+------------+-> cancelled
   +---------+------------+-> queued (retry/process recovery)
```

- SQLite contains the message before the API acknowledges it, but Pi's model context does not. Until Pi confirms insertion, clients show the work item above the composer with its canonical `queued`, `running`, or `dispatched` status.
- `running` means the worker has claimed it but has not handed it to Pi.
- `dispatched` means exactly one RPC command was written; acknowledgement loss never causes a duplicate send. Pi's next context snapshot contains the user message after RPC acknowledgement or subsequent Pi activity proves insertion, and the pending composer card disappears in the same durable update.
- A `followUp` created during `RUNNING` remains `queued` under supervisor ownership. It is not handed to Pi until the current run settles, so it can be atomically promoted to `steer` or cancelled. While busy, the worker skips held follow-ups and dispatches only promoted steering items; while idle, it starts the oldest queued item as the next prompt.
- Cancellation succeeds only while the supervisor still owns an item in `queued`; it atomically marks the item `cancelled` before any Pi insertion. Client-side Edit uses this same cancellation endpoint and copies the returned canonical text into the composer without creating a second server-side message.
- Promotion normally updates a still-pending durable work item before it has any event entry. An already-inserted item keeps its delivery event accurate for voice consumers.
- All dispatched items in one Pi run complete only when reconciliation confirms Pi inactive from the `RUNNING` phase. An `agent_settled` event requests that reconciliation but cannot complete work on its own.
- Cancellation is terminal for the active item. Stop requeues every later queued/running/dispatched item with `resume=0`; a dispatch error checks each durable state before retrying, so the cancelled active turn cannot resurrect while retained messages remain sendable.
- A live release handoff keeps `dispatched` work attached to its existing runtime host and releases a supervisor-only `running` claim back to `queued`. A crash or full service restart terminates unclaimed runtime hosts, requeues `running`/`dispatched` work, and resumes an interrupted inserted turn through the supported RPC `prompt` command with an explicit continuation instruction. Startup never invents protocol commands that Pi does not support.

## Abort ownership

Abort stops only the current operation through Pi's RPC `abort`; it never terminates the Pi RPC child. This propagates cancellation into the active local or remote tool while preserving the thread process, model state, and session. A claimed message can be cancelled during `STARTING` before dispatch without cancelling activation. A prompt waiting in retry backoff has no active Pi operation, so abort cancels that durable item directly, clears its retry timer, and returns the existing child to `IDLE` instead of briefly displaying `ABORTING` and resuming the retry loop.

Pi owns steering it has already acknowledged, while the supervisor continues to own uninserted follow-ups. Because `session.abort()` waits for Pi to become idle, accepted steering may complete before the abort response and its real transcript output remains visible. The active work item becomes `cancelled`, accepted steering completed by Pi becomes `complete`, and supervisor-held work then dispatches normally through the same child. If Pi refuses or cannot confirm abort, the endpoint reports failure and leaves the child and active work running; it never substitutes process termination for operation cancellation.

The normal runtime termination path is the idle reaper. After fifteen minutes in `IDLE`, it preserves the Pi JSONL session and stops the child and its runtime host. Release activation replaces the supervisor immediately while runtime hosts keep active children alive. The old supervisor writes one handoff document, disconnects, and exits with status 75. The service launcher starts the selected release, which adopts those hosts and continues their event streams before opening the HTTP listener. A handoff waits only for an in-flight abort operation because its durable cancellation decision belongs to the supervisor that started it. Explicit thread retirement, full service shutdown, activation failure, and unexpected child failure remain distinct termination paths. Archiving an ordinary thread sets `sessions.archived_at`, cancels unfinished durable work, and stops the child while preserving events, settings, and Pi JSONL resume state. Archived threads cannot activate or accept new work until unarchived.

## Revision ordering

Every externally meaningful lifecycle mutation increments `sessions.revision`. Session snapshots in list, event, prompt, and abort responses carry this revision.

Both clients:

1. apply a selected-thread snapshot only when its revision is at least the last applied revision;
2. capture a selection generation for every poll and discard selected-thread/event results after a switch;
3. capture an action generation and reject poll projections that overlap a send or abort;
4. coalesce a poll requested during another poll and run it immediately afterward rather than dropping it; and
5. use a local `SENDING`/`ABORTING` overlay only while the HTTP action is unresolved.

This keeps thread identity, lifecycle, context capture time, and local actions separate. A response for thread A cannot mutate thread B, and a pre-action poll cannot overwrite the action response.

## Network synchronization

Android uses one resumable long poll for the visible environment. Selecting a thread or observed agent cancels that poll and starts an immediate request for the new selection; it never waits for the previous selection's 25-second idle poll to expire. SSH transports warm in the background while the app is open, and context-cache reads have their own executor so metadata requests cannot delay the first cached paint. Completion monitoring uses one independent long poll per environment with watched work. An idle result waits one second before it becomes a notification. Compaction activity or a resumed turn within that second cancels the pending notification, so the brief idle state between compaction and its continuation stays silent. The server identifies each incarnation with `epoch` and orders wakeups with `seq`. A client reconnects with its last sequence. An epoch change clears cursors and requests authoritative state again.

Canonical interactive context remains the exact JSON document captured by Pi. The mirror rebuilds it from Pi's active session branch on startup, successful compaction, and tree navigation instead of waiting for another model request. A successful compaction carries an explicit replacement acknowledgement. The supervisor accepts that replacement while Pi reports compaction in progress even when its capture clock is behind the stored document, then assigns it the next capture time. If that acknowledgement is missing or does not match the stored document, the supervisor clears the old context before notifying clients. Android renders that clear as an empty context and deletes its cached copy. Android explicitly requests a display projection that removes only schema-known provider continuation metadata; ordinary API and browser responses keep the canonical document. Each projection has its own SHA-256 history over UTF-8 bytes. A context update is either a complete document or one byte splice naming its base and target hashes. The client checks the base, applies the splice, verifies the target, and only then parses it. A missing base is an explicit complete resynchronization. The server keeps recent versions for this purpose and records streaming patches separately from the stable context, so one new token does not rewrite or transfer the preceding transcript. A finalized message or compaction commits a new stable document and clears its patch chain.

Live text for observed orchestrator agents and GPT-Live delegation follows the same verified splice rule. Event rows still use their durable sequence cursor.

Android caches each verified context in app-private storage. Cached text is labelled while the endpoint reconnects and does not advance lifecycle state. Outgoing prompts enter an app-private outbox before the composer clears. Retries retain the same request ID, and the supervisor's request ledger makes delivery idempotent across lost acknowledgements and process death.

## Android context rendering

Document state and view state are separate. JSON parsing and entry modeling run on the poll executor; the UI thread receives detached entry models. System-prompt and tool-definition rows stay pinned. A new selection shows the newest conversation entry in its first render frame, then inserts up to 32 recent entries above it within bounded frame work. Automatic updates may grow that window to 64 entries before old keyed views are evicted. The earlier-context row expands by 32 entries at the reader's request and suspends the automatic bound for that selection.

Every context entry has a stable key and a content signature. Reconciliation moves the existing view for a surviving key, updates it only when its signature changed, and creates as many missing views as fit an eight-millisecond frame budget. Backfilled rows never play arrival animations. Tool arguments, results, timing, and status update inside the existing card, so a growing result does not replay the card's entrance animation or lose its expanded state. A new context capture therefore does not recreate unchanged Markdown, tool cards, selections, or image state. Selection changes and context compaction invalidate only state whose keys no longer survive.

The drawer's plan summary renders only cards with a measured percentage. Environments without an account for a plan's provider do not get empty provider rows. Machine usage likewise omits unavailable hardware, such as the GPU row on a CPU-only VM. The server samples CPU every second independently of the 25-second client poll, so an idle connection does not turn the reading back into an unavailable value.

Slash-command discovery is lazy. Selecting or switching to an idle thread reads its context without starting its Pi runtime; typing `/` requests runtime-owned commands when they are actually needed.

Attachments upload in hash-checked chunks. Initialization by request ID returns the committed byte offset, so reconnecting resumes rather than creates another file. Completion checks the whole-file hash before the file enters ingestion. Downloads carry validators and byte-range support.

## Android file browsing

The Files drawer tab belongs to the selected environment, not to a thread. It starts at `/`, includes hidden entries, and requests only the open directory. The server sorts folders before regular and special files. Android renders the result through a recycled list, so directories with thousands of entries do not create thousands of views.

A folder tap replaces the list and adds its path to the breadcrumb row. Back moves to the parent before it closes the drawer. A regular file tap sends it to Android's download manager without reading it into the app. A long press copies the absolute path. Special files remain visible but cannot be downloaded.

## Observed orchestrator agents

Autonomous orchestrator agents are outside this state machine. They have no supervisor epoch, no RPC child, no runtime phase, and no durable work queue here, because Pi Remote does not own them: the orchestrator's SQLite ledger owns their lifecycle and its agent hosts own their sessions.

The observation surface is therefore a pure projection with three rules:

1. Pi Remote never writes agent lifecycle state. Its only write is touching a run's `watch` marker, which asks the owning agent host to publish partial output; losing that write degrades to message-granular updates, never to wrong state.
2. An observed agent's transcript is applied only to the selection generation that requested it, exactly as for threads, and a per-run byte cursor makes replay incremental. Opening an agent leaves thread selection untouched, and opening a thread ends observation.
3. The list projects only the `running` rows of the ledger. Settlement is not a client state transition: a settled run simply leaves the list, and one already open stays open because observation fetches it by id and renders whatever terminal result the ledger holds.

## Core invariants

1. Exactly one supervisor epoch may publish durable state; callbacks from replaced incarnations are read-only and terminate locally.
2. One server runtime at most per thread ID. Each RPC wrapper and all descendants run in a dedicated process group; stop waits for the whole group and escalates from `SIGTERM` to `SIGKILL`.
3. One serialized durable worker at most per thread ID.
4. A runtime event is bound to the thread ID captured when that child was spawned.
5. Only an inactive Pi state confirmed from `RUNNING` may settle and complete dispatched work.
6. `ABORTING` preserves real transcript output while owning settlement; only `STOPPING` suppresses output.
7. A stale reconciliation response cannot change phase.
8. The cancelled active item is never retried; Pi-owned accepted steering and supervisor-owned pending work each continue from their canonical owner without duplication.
9. A completed compaction can expose only the replacement context acknowledged during that compaction. A missing or mismatched replacement clears the prior document.
10. Client context snapshots are applied only to the selection generation that requested them; their capture times never move backward.
11. Client authoritative lifecycle snapshots never move backward in revision.
