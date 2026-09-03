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
| `STOPPING` | Hard steer, the idle reaper, archiving, or supervisor shutdown is removing the child process group | `ABORTING` until process exit, then `STOPPED` |

`phaseVersion` changes on phase transitions, dispatches, queue changes, and Pi activity. A `get_state` reconciliation captures this version before its RPC request and discards the response if the version changed while it was in flight. This prevents an old inactive snapshot from settling newer work.

### Valid transitions

```text
(no runtime) -> STARTING -> IDLE
IDLE -> DISPATCHING -> RUNNING -> IDLE
RUNNING -> RUNNING                 queued steer/follow-up
STARTING -> STARTING                   cancel claimed work before dispatch
DISPATCHING|RUNNING -> ABORTING -> IDLE
DISPATCHING|RUNNING -> STOPPING -> STARTING   hard steer
IDLE -> STOPPING                       fifteen-minute inactivity reaper
any live phase -> STOPPING -> STOPPED|FAILED
FAILED|STOPPED -> STARTING         later activation/retry
```

Only `RUNNING -> IDLE` can ordinarily settle dispatched work. `agent_settled` in `DISPATCHING` is stale and ignored. In `RUNNING`, it starts a next-tick `get_state` check rather than settling by itself. Our deployment-specific VCC fork checks active context before each provider request, starts compaction at 250,000 tokens, replaces the summary, and queues the interrupted tool loop after compaction succeeds. Pi's end-of-run context-window check remains a fallback. The intermediate `agent_settled` can therefore arrive before compaction and continuation finish; Pi's state already reports pending activity, so the check keeps the work and runtime alive. During `ABORTING`, the abort handler owns the phase transition, while Pi may finish steering it already accepted before `abort()` returns. `STOPPING` suppresses output. An assistant message with `stopReason=error|aborted` is held until confirmed settlement: a later successful assistant message in the same run clears it, so automatic retry, account failover, or compaction does not expose a false terminal failure. If the run settles without recovery, the provider error remains in the supervisor event ledger for voice and diagnosis. The interactive view comes from Pi's model context rather than this event projection.

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
- Soft steer promotes a pending follow-up into Pi's current run. Hard steer marks the chosen follow-up as next, terminates the active Pi process group immediately, and starts a fresh process on the same session with that message. Work already dispatched into the interrupted run is cancelled; supervisor-owned follow-ups retain their relative order.
- Promotion normally updates a still-pending durable work item before it has any event entry. An already-inserted item keeps its delivery event accurate for voice consumers.
- All dispatched items in one Pi run complete only when reconciliation confirms Pi inactive from the `RUNNING` phase. An `agent_settled` event requests that reconciliation but cannot complete work on its own.
- Cancellation is terminal for the active item. Stop requeues every later queued/running/dispatched item with `resume=0`; a dispatch error checks each durable state before retrying, so the cancelled active turn cannot resurrect while retained messages remain sendable.
- A live release handoff keeps `dispatched` work attached to its existing runtime host and releases a supervisor-only `running` claim back to `queued`. A crash or full service restart terminates unclaimed runtime hosts, requeues `running`/`dispatched` work, and resumes an interrupted inserted turn through the supported RPC `prompt` command with an explicit continuation instruction. Startup never invents protocol commands that Pi does not support.

## Abort ownership

Abort stops only the current operation through Pi's RPC `abort`; it never terminates the Pi RPC child. This propagates cancellation into the active local or remote tool while preserving the thread process, model state, and session. A claimed message can be cancelled during `STARTING` before dispatch without cancelling activation. A prompt waiting in retry backoff has no active Pi operation, so abort cancels that durable item directly, clears its retry timer, and returns the existing child to `IDLE` instead of briefly displaying `ABORTING` and resuming the retry loop.

Pi owns steering it has already acknowledged, while the supervisor continues to own uninserted follow-ups. An ordinary abort uses Pi's RPC command and keeps the process alive. Because `session.abort()` waits for Pi to become idle, accepted steering may complete before that response; its real transcript output remains visible and its work becomes complete.

Hard steer is deliberately stronger. Pi has no RPC command that can clear or reprioritize an accepted steering queue, so waiting for its ordinary abort would let those messages run first. Hard steer instead suppresses late output, terminates the Pi process group and active tools, cancels every item dispatched into that run, and starts a new Pi process from the same JSONL session. The selected message is the first dispatch to that process. Supervisor-owned follow-ups remain queued behind it. If process-group termination cannot be confirmed, the endpoint restores the selected message as an ordinary follow-up and reports failure instead of claiming it was preempted.

The normal passive runtime termination path is the idle reaper. After fifteen minutes in `IDLE`, it preserves the Pi JSONL session and stops the child and its runtime host. Release activation replaces the supervisor immediately while runtime hosts keep active children alive. The old supervisor writes one handoff document, disconnects, and exits with status 75. The service launcher starts the selected release, which adopts those hosts and continues their event streams before opening the HTTP listener. A handoff waits only for an in-flight ordinary abort operation because its durable cancellation decision belongs to the supervisor that started it. Explicit hard steer, thread retirement, full service shutdown, activation failure, and unexpected child failure remain distinct termination paths. Archiving an ordinary thread sets `sessions.archived_at`, cancels unfinished durable work, and stops the child while preserving events, settings, and Pi JSONL resume state. Archived threads cannot activate or accept new work until unarchived.

## Revision ordering

Every externally meaningful lifecycle mutation increments `sessions.revision`. Session snapshots in list, event, prompt, and abort responses carry this revision.

The shared React client keeps its rendered state and a current-state ref in lockstep. Polling and action callbacks read the ref rather than a render-time closure, and each selected context or agent response is applied only if the selected ID still matches the ID captured when the request began. Selecting a thread clears the previous context and live documents before it requests an immediate reconciliation. The client never copies server-owned state out of a mutation response: a prompt, abort, archive, toggle, or reorder returns, the client requests an immediate reconciliation, and the next synchronization response replaces the affected section whole. The selected thread is looked up in the synchronized list by ID rather than held as a second copy. The one local overlay is a dropped drawer order, shown until the state response that follows the committed reorder arrives or the request fails.

This keeps thread identity, lifecycle, context capture time, and local actions separate. A response for thread A cannot mutate thread B, and a synchronization request made before a selection change cannot put its context into the new view.

## Network synchronization

The shared client uses one resumable long poll for the visible environment. Selecting a thread or observed agent aborts that request and starts an immediate reconciliation; it never waits for the previous selection's 25-second idle poll to expire. The Android shell warms SSH-backed environments before the web client uses them, and the client reconciles immediately when its page becomes visible again.

`server/protocol.ts` defines the request and response. The server identifies each incarnation with `epoch` and orders wakeups with `seq`. The response has four sections, and whether each is sent depends only on what the client says it already has, never on wake timing:

- `state` (threads, archived threads) is sent when the client's `stateVersion` differs. That version combines every SQLite change with explicit in-memory state signals, so a write cannot be omitted merely because its call site forgot to wake the long poll.
- `dashboard` (plan meters, governors, host toggles, machine usage, orchestrator agents, thread-start profiles) is sent when the client's `dashboardVersion` differs. A server tick rebuilds the dashboard while clients are connected and bumps that version only when the encoded snapshot changed; a governor or action toggle rebuilds it before responding. Rebuilds are serialized so a toggle's rebuild always observes the toggle.
- `session` is evaluated on every request that names a thread: the display projection of its stored context and its live text and thinking are each compared by hash and returned as nothing, a splice, or a full document. Voice adds a durable event cursor to the same section.
- `agent` likewise follows the named orchestrator run.

A response computed while live tokens are flowing therefore still carries a newly selected thread's context; the earlier design gated context on the same condition as the thread list and starved a selection change for as long as any thread kept streaming. A client reconnects with the wake sequence and its versions and hashes; an epoch change needs no client reset because a fresh epoch sends every versioned section and every document is content-addressed.

Canonical interactive context remains the exact JSON document captured by Pi. The mirror rebuilds it from Pi's active session branch on startup, successful compaction, and tree navigation instead of waiting for another model request. It also checkpoints finalized assistant and tool-result messages. Live assistant text stays in the runtime projection. Its first delta wakes waiting clients immediately, and later deltas are coalesced to one wake per 16 milliseconds. When an assistant message ends, its final text remains in that projection until the server acknowledges the context document containing the same message. The mirror retains its latest desired document and retries transient request failures, so a lost response cannot discard the only finalized copy or leave a blank handoff. This keeps token streaming out of SQLite and avoids serializing the full model context for each delta. A successful compaction carries an explicit replacement acknowledgement. The supervisor accepts that replacement while Pi reports compaction in progress even when its capture clock is behind the stored document, then assigns it the next capture time. If that acknowledgement is missing or does not match the stored document, the supervisor clears the old context before notifying clients. The client renders that clear as an empty context and deletes its cached copy. Its display projection removes schema-known provider continuation metadata. pi-vcc resumes a successful automatic compaction with the visible user message `your context was compacted, you now have tons of space to keep working as long as you like`. When that message immediately follows compaction's empty aborted assistant response, the projection replaces the misleading `Assistant error · Request aborted` card with `Context compacted`. The canonical API document stays unchanged. Each projection has its own SHA-256 history over UTF-8 bytes. A context update is either a complete document or one byte splice naming its base and target hashes. The client checks the base, applies the splice, verifies the target, and only then parses it. A missing base is an explicit complete resynchronization. The server keeps recent versions for this purpose. A finalized message or compaction commits a new stable document and clears its patch chain.

Live text for observed orchestrator agents and GPT-Live delegation follows the same verified splice rule. Event rows still use their durable sequence cursor.

The 32 most recent verified context documents remain in app-private IndexedDB across process restarts. When a thread is selected, the client reads its cached document while requesting an immediate reconciliation and sends the cached hash on the next poll. The server returns only a splice if it changed. The transcript renders the latest 60 entries first and reveals earlier entries in 60-entry pages, so opening a long thread does not lay out hundreds of off-screen messages before its first paint. A reverse-column scroll container anchors the latest entry at the bottom without assigning `scrollTop` after renders. Native scroll anchoring holds the visible message still when live content grows below it. Active thread order is durable supervisor state; the client applies a dropped order immediately, restores the previous order if the request fails, and accepts the server's returned order when it commits.

## React context rendering

Every context entry has a stable key and a content signature. Reconciliation retains the common prefix, updates a surviving keyed message in place, and creates only the changed suffix. Every message, tool card, queued message, and live model block exposes its source text through a copy action. Tool arguments, results, timing, and status update inside the existing card, so a new context capture does not recreate unchanged Markdown or lose an expanded tool card. Compaction replaces entries whose keys no longer survive.

Live model output is Markdown from its first chunk and updates at most once per display frame. Every partial document is completed before it is parsed: an open fence, code span, or emphasis run gets its closer, and a construct whose meaning is still undecided waits out of sight until the text that settles it arrives. Half a link, a formula KaTeX cannot compile yet, a table without its delimiter row, and a bare block marker are all held back rather than shown as source. A render that throws keeps the previous output, and the rendered nodes are patched instead of replaced, so a growing message never drops back to its source text, loses a selection, or blinks its images and formulas. The finalized context then replaces the live block with the identical rendering. Thread selection has no entrance animation; navigation never hides content behind a decorative transition.

The drawer's plan summary renders only cards with a measured percentage. Environments without an account for a plan's provider do not get empty provider rows. Machine usage likewise omits unavailable hardware, such as the GPU row on a CPU-only VM. The server samples CPU every second independently of the 25-second client poll, so an idle connection does not turn the reading back into an unavailable value.

Slash-command discovery is lazy. Selecting or switching to an idle thread reads its context without starting its Pi runtime; typing `/` requests runtime-owned commands when they are actually needed.

Attachments upload in hash-checked chunks. Initialization by request ID returns the committed byte offset, so reconnecting resumes rather than creates another file. Completion checks the whole-file hash before the file enters ingestion. Downloads carry validators and byte-range support.

Editing a finalized user message is an idle-only session transition. The server reads Pi's append-only entries, resolves the displayed message timestamp on the active branch, and uses Pi's supported `fork` command to create history immediately before it. The thread adopts the forked session file, its recovery and voice event projection is rebuilt from that branch, and the context mirror replaces the visible transcript. The client clears its old cached projection and puts Pi's returned original text in the composer. Sending remains a separate user action.

## File browsing

The Files drawer tab belongs to the selected environment, not to a thread. Its lazy Headless Tree root is `/`; opening a folder requests only that directory. The server includes dotfiles and sorts folders before regular and special files. The client preserves loaded branches and expansion state while switching tabs. TanStack Virtual renders only the visible rows, so opening a directory with tens of thousands of entries does not create tens of thousands of DOM elements.

Selecting a folder expands or collapses it. Selecting a regular file uses the host-file endpoint to download it. Special files remain visible but cannot be downloaded. A failed directory read appears as an error child beneath that folder, and the toolbar can retry the selected folder.

## Observed orchestrator agents

Autonomous orchestrator agents are outside this state machine. They have no supervisor epoch, no RPC child, no runtime phase, and no durable work queue here, because Pi Remote does not own them: the orchestrator's SQLite ledger owns their lifecycle and its agent hosts own their sessions.

The observation surface is therefore a pure projection with three rules:

1. Pi Remote never writes agent lifecycle state. Workers publish live state through the orchestrator daemon, and settled history comes from the Pi session JSONL. Worker activity uses the same uppercase public vocabulary as interactive threads. The observation boundary normalizes activity from workers that survived a release handoff, and clients render an unknown activity literally instead of misreporting it as idle.
2. An observed agent's transcript is applied only to the selection generation that requested it, exactly as for threads, and a per-run byte cursor makes replay incremental. Opening an agent leaves thread selection untouched, and opening a thread ends observation.
3. The list projects active orchestrator runs. Settlement is not a client state transition. A settled run leaves the list, and one already open remains readable by ID.

## Core invariants

1. Exactly one supervisor epoch may publish durable state; callbacks from replaced incarnations are read-only and terminate locally.
2. One server runtime at most per thread ID. Each RPC wrapper and all descendants run in a dedicated process group; stop waits for the whole group and escalates from `SIGTERM` to `SIGKILL`.
3. One serialized durable worker at most per thread ID.
4. A runtime event is bound to the thread ID captured when that child was spawned.
5. Only an inactive Pi state confirmed from `RUNNING` may settle and complete dispatched work.
6. `ABORTING` preserves real transcript output while owning settlement; only `STOPPING` suppresses output.
7. A stale reconciliation response cannot change phase.
8. An ordinary abort never retries its cancelled active item. A hard steer cancels every item owned by the retired Pi process and dispatches the selected supervisor-owned message first in its replacement.
9. A completed compaction can expose only the replacement context acknowledged during that compaction. A missing or mismatched replacement clears the prior document.
10. Client context snapshots are applied only to the selection generation that requested them; their capture times never move backward.
11. Client authoritative lifecycle snapshots never move backward in revision.
12. Final live assistant text remains visible until the matching message is acknowledged in the durable context or newer model activity supersedes its live projection.
