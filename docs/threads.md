# Persistent agents and threads

[First global-capacity cutover](agent-capacity-cutover.md) owns the durable all-owner admission barrier, ThreadService custody census and initialization before managed model doctors.

[The kena model](agents.md) owns the product contract. One agent has one stable
thread ID, native Pi conversation, workspace, complete model settings and storage
owner. Foreground/background is placement, not a class of agent. Orchestrator,
Remote, schedules, tools and the CLI use the same ThreadService operations.

## Identity, custody and placement

New threads receive an immutable Nebulani `agentName`, separate from the mutable
conversation title and UUID. Startup backfills historical threads without a name
once and stores it with the thread, so imports, projections and restarts preserve
the same identity. A name is not an authorization credential. `parentId` records the agent that
launched this one. It supplies the direct launched-agent list and result
provenance, not recursive cancellation or a leaf-worker restriction. The runtime
projects one role, `agent`.

Every ordinary agent may create another agent. Application, sandbox, Unix-person,
encrypted-folder and shared-human-room restrictions remain execution boundaries.
One agent type does not grant access across them. Shared runners host many native
sessions without a process per agent. Owners and transcripts are not moved just
to change placement.

`metadata.foreground` explicitly controls discovery in Chats. Human creation is
foreground; agent, lane, schedule and watch creation is background. An explicit
human open promotes the selected agent. Agent reads, subscriptions and attention
requests cannot promote it. Opening from a notification or launched-agent link
selects the same identity, not a copied conversation.

Completed background tasks archive as soon as their final assignment settles,
regardless of unread results or attention notices. Startup also reconciles already
completed background tasks. Transcripts, results, assignment receipts and notification
history remain accessible; opening a notification restores and promotes the original
thread. Foreground Chats keep their unread behavior. Pending input/questions, typed
waits, wake schedules, outstanding result subscriptions and persistent watch threads remain
open because their work is not complete. Startup-failed agents also remain visible,
including after their bounded retry budget settles an assignment as failed: losing
native startup is not proof that external resources have been released. Automatic
archive sweeps preserve that owner across restarts. Successful startup clears the
failure; explicit Stop/close still takes effect and never resumes failed work.
A native turn without nonempty final assistant text or a retained dependency/question
returns a failed settlement with `Native turn ended without a final result or a durable
dependency wait`. Its `metadata.incompleteResult` keeps the owner open across archive
sweeps and restart; a subsequent settled result clears it. Explicit close remains available.

`lastUserMessageAt` records accepted explicit input without an agent sender.
Automatic notices, agent messages, tool activity, titles and settlements do not
change it. Imports retain original timestamps. Creation time orders threads with
no person input.

Imported settings are complete model/thinking/speed values. Invalid settings
return `invalid_request` before creating work; bulk import rolls back atomically.
Only creation/control override requests resolve partial preferences.

## State and work

Native execution and assignment completion are distinct. `running` includes
accepted runnable input, admission, startup, execution and cancellation until
confirmed. `waiting` describes an agent with a current `thread_wait` (agent, job,
deployment or message) or unresolved outgoing result subscriptions, but no local
execution. Active execution wins over either waiting reason. `idle` is genuinely available with no current work. Archived agents
retain history but accept no automatic execution. There is no persistent Stopped
product state. An inactive or stopped agent with no explicit dependencies is
idle even if agents it previously launched are still active. Launch provenance
never supplies a non-idle status or icon; each agent owns its own activity.

Execution activity names observed phases: queuing, admission, opening, inference,
tools, compaction, cancellation or provider recovery. Missing instrumentation is
a status defect, not a reason to invent Idle or Working. The same state feeds
status pills, lists, notification policy and recurring producers. See
[explicit dispatch](state-dispatch.md) and [runtime wire](runtime-wire.md).

A native turn ending does not finish an assignment that still has a dependency or
unanswered question. Settlements with `assignmentPending` are not completion
results for peer awaiting. The synchronous `threadHasOutstandingWork` predicate
covers execution, queued input, waits, dependencies and recovery wakes; callers
also inspect durable questions before declaring completion. Native settlement is correlated
with the current execution and completed work receipt, not an earlier turn's event. The
owner rechecks native idleness after dependency reconciliation before committing completion.

## Dependencies

`control({ action: "dependencies", threadId, threadIds })` replaces an agent's
outgoing peer dependencies. Agent callers can change only their own edges.
Dependencies reference accessible peers, not only agents they launched. Invalid,
self and inaccessible targets are rejected. Registration reads only named peers;
it does not walk a graph or forbid mutual subscriptions. Exact-identity directory
pages resolve their owner without listing unrelated stores.

A dependency A → B is a durable result subscription. B records A as a recipient;
its terminal result is committed with a stable delivery receipt before delivery.
The receiving owner clears the subscription and resumes a matching wait in the
same transaction as accepting the result. A settled result remains accessible even
when B automatically archives. Registration against an already-settled peer delivers
its saved result; an explicitly closed peer delivers cancellation, not success.

Explicit Close wins on either endpoint. Closing B confirms native cancellation and
publishes a cancelled terminal settlement, even if B was idle with a dependency
wait rather than executing. Closing A clears its wait and outgoing subscriptions
without closing B. Owner-to-owner `resultSubscribe` updates and terminal deliveries
retry from durable state across outages and controller restart. An unavailable
peer never vetoes closing the local agent. Automatic retention keeps A while it
still awaits a result, but subscribers do not prevent a completed B from archiving.

`thread_wait` sets a scheduling wait and ends the native turn without polling:

```json
{"action":"set","kind":"agents","reason":"Need the implementation result","threadIds":["peer-id"]}
```

The other variants identify `jobId`, `publicationId`, or a collaborator
`fromThreadId`. Every variant has a concrete reason and dependency identity;
there is no available-for-assignment or generic external wait. Peer waits use
optional owner settlement cursors in `after`. Registration probes the current
assignment: an older settlement or its parked notification cannot satisfy a peer
that has newer queued/running work or an unfinished dependency wait. Delayed
result notifications retain their execution identity; only a matching current
assignment result clears an agent wait. Cross-owner delivery obtains bounded
owner evidence, and an unavailable owner leaves the result subscription pending with a typed
error. Historical notifications are still delivered, without releasing the wait.
Bounded
`thread_await` still reads historical results according to its explicit cursors.

Every successful request returns the current thread snapshot plus a durable
`waitRegistration` outcome: `registered` contains the accepted wait;
`already_arrived` contains the current assignment settlement; `resumed` identifies
new input by `messageIds`; `cleared` confirms release. A retry returns the same
registration outcome even if subsequent input has already removed the active wait.
Only a still-active `registered` wait terminates the native turn. An already-arrived
result or resuming input remains available for the agent to handle; success without
an explanation for an absent wait is not a valid registration outcome.

`set` atomically replaces the previous wait and its peer subscriptions, retaining
independently declared explicit subscriptions even when a peer belonged to both.
Validation and current-assignment probe failures leave the accepted wait unchanged.
The wait, subscription reconciliation journal and retry receipt commit together;
a subscription transport outage after acceptance leaves a registered wait with
`metadata.dependencyError` and durable reconciliation custody. Controller restart
retries that journal without replaying the wait request or native work. Completed
peer results discharge their edges through the existing result receipt, including
when the producer automatically archives before cross-owner delivery.

`clear` releases the caller's wait and all outgoing result subscriptions. Explicit
subscriptions can also be managed without suspending current execution.

`thread_await` is a bounded wait of at most 25 seconds on accessible peers. It
returns the first completed assignment, cursors and remaining agent IDs. Timeout
is not completion; it includes current peer status or an explicit status error.
Ordinary messages do not cancel local tools. Results arrive durably without a
model polling loop, and dependency waiting holds no model/execution lease.

## Messages

A message has stable identity and moves `queued` → `dispatched` → `done`.
`insertedAt` records acceptance and `landedAt` records native conversation entry.
Native history owns the conversation. Projections, live text and pending queues
are not alternative journals. Cancellation/recovery cannot replay landed input.

- Human input may use queue, steer or hard steer; steer is the declared initial
  delivery selection.
- Agent input uses steer or hard steer; queue from an agent is rejected.
- Queue waits for the current execution to finish.
- Steer lands at the next safe boundary after current tools.
- Hard steer cancels current execution and local tools, confirms cancellation,
  then runs the new message before other retained pending messages. It does not
  cancel peers or undo external effects.

The owner stamps sender identity. Native agent messages retain a distinct
`<agent_message>` envelope so the model cannot mistake them for human input.
The client renders the sender's Nebulani name and readable body, without wrapper
XML or routing JSON. In its own thread every assistant remains **Kenan**.
Completion messages contain final text, outcome and errors, never the sender's
private reasoning or provider metadata. Explicit result destinations and durable
receipts preserve exactly-once delivery across owner handoff and restart.

`inspect` accepts `contextRevision` so an unchanged idle conversation can omit
native history. `thread_read` reads persisted history without starting or
promoting the recipient. Merely inspecting an agent is not a human view.

## Controls

- `close`: cancel and archive only the selected agent. Result subscribers receive
  durable cancellation; its own outgoing subscriptions are released.
  Failed cancellation leaves visible custody and never permits overlapping work.
- `reopen`: restore the conversation without resuming interrupted or queued work.
- `open`: human opening also promotes foreground placement.
- `cancel`: end the selected agent's current work without archiving it or leaving
  a persistent stopped state.
- `placement`: explicit human-controlled foreground/background change.
- `rename`: a person's nonblank conversation title, recorded with
  `metadata.titleSource: "manual"`. It pins the title: the thread's agent cannot
  retitle it until a person renames it again. Agents cannot call `rename`. This
  does not rename the agent's Nebulani identity.
- `title`: the thread's own agent titles its conversation through the
  `thread_title` tool, self only, recorded with `metadata.titleSource: "agent"`.
  The agent names its thread when it starts and again whenever it judges the topic
  has changed enough. Nothing else titles a thread automatically. While a person's
  rename pins the title, `title` returns a conflict and changes nothing. Older
  `titleSource: "auto"` titles count as agent titles and are not pinned. The optional
  `taskDescription` is a nonempty sentence of at most 240 characters describing the
  task's intended outcome. It is stored with the title and projected into the
  Orchestrator; omitted descriptions stay unset or retain an already supplied one.
  No model is called to infer a description from private transcript content.
- `settings`: future model/thinking/speed preferences; `effectiveSettings` names
  already accepted current/queued work.
- `retryWaiting`: apply selected settings to dormant provider/admission waiting
  work without interrupting genuinely live work or bypassing real quota refusal.

Retained Stop/restore requests select only the named agent; old descendant or
resume flags never revive a cancellation tree or replay archived input. A closed
agent's old pending messages do not resume simply because the person reopened it.
Confirmed close/cancel also removes its recovery wake schedule; reopening does not
recreate it. An explicit answer to a retained question reopens the thread with
that answer, not the cancelled queue.

Ephemeral creation is retention policy, not another kind of agent. It may archive
only after the assignment really settles: no active work, outstanding subscriptions, waits,
wakes, attention awaiting the person or unanswered questions. Foreground and
unread human attention remain discoverable. Automatic retention preserves unfinished subscriptions; explicit Close overrides
retention without losing durable terminal results.

## The person's manager

[Mono view and manager custody](../apps/remote/docs/mono.md) owns the optional forever conversation. The person's supervisor creates one full-context thread lazily on first use, marked `metadata.manager:true`, and preserves it from archival. It uses the ordinary tools and durable own-thread wake. Questions from other own-person threads pass through manager custody before becoming human-visible; unhandled holds expire after two hours. The watch-list scheduler remains independent.

## Questions and attention

`request_user_input_async` stores independently answerable questions with stable
IDs, suggestions and optional recommendation. Answers arrive as correlated human
messages at a safe boundary. Dismissal explicitly skips the question; it does not
authorize a suggestion. Questions survive turn settlement and restart. Authors
Renia-reduce them: ask the decision or person-only fact first, retain only
answer-changing context, preserve material uncertainty and consequences, and
keep suggestions concise. Questions and suggestions support Markdown; routing
preserves the authored text without truncation or a model rewrite. The
[question contract](../apps/remote/docs/questions.md#authoring) owns this rule.

Root permission questions retain their separate receipt-only answer path for
RootConsentManager; answering them neither resumes unrelated work nor restores
an archived inbox. Historical delivered answers are not injected again.

`thread_attention` records a notification with a nonblank summary of at most
1000 characters. It cannot promote an agent. The Notifications tab retains
attention/question history independently of transient browser or Android
notifications; selecting an entry opens its original thread. A durable receipt
proves server acceptance, not that a device displayed it. Notifications use Renia
reduction: tell the person only what changes their next action or reliance.

Question loading is a scoped resource state: loading, ready or failed, optionally
with an explicitly stale previous snapshot. Failure cannot overwrite agent
execution or connection status. Recovery clears the corresponding question
error. HTTP request deadlines apply only while their owning request is active;
asynchronous descendants do not inherit an expired deadline indefinitely.

## Scheduled work

`thread_wake` owns a recovery schedule on the same existing agent, not a new
agent. It accepts set/list/cancel with reason, `cadenceMs` (at least 60 seconds)
and optional epoch-ms `nextDueAt`. Due events coalesce while busy; archived agents
do not wake. Stable receipt identity and SQLite transactions prevent repeated
inputs after restart. Cancel removes future and unstarted wake work, not tools
already executing. External job/publication waits should register recovery
before suspending and cancel it when the dependency resolves.

The person's [watch list](watch-list.md) stores recurring checks in encrypted
person-owned state, separated by destination. Fleet tools route to that owner.
Lane and [recurring schedule](../packages/orchestrator/docs/schedules.md) producers
create ordinary background agents. Neither a quiet native turn nor a dependency
wait grants permission to launch an overlapping occurrence.

## Resource admission

All owners share the [global 100-agent budget](agents.md#execution-budget).
Admission queues when the budget is full. Foreground/background placement,
creator provenance, forced model admission and live meeting mode never bypass
that limit. Actual provider capacity and execution slots are distinct constraints.

Model settings resolve centrally. New delegated agents use Sol/high/standard
unless explicitly configured; Luna uses max thinking. Models are not prohibited
merely because the requesting agent itself was launched by another agent.
Machine model availability applies to new creation, while accepted existing
settings and historical attribution survive policy changes. Actual provider
exhaustion, reservations and readiness remain independent admission constraints.

A positively failed pre-native open releases its original capacity identity;
startup rejection cannot strand that lease behind a separate failed settlement.
Direct cwd admission rejection carries typed absence proof. Retained runner
absence or confirmed idle cancellation releases startup custody before settling
failure. Lost acknowledgements retain custody. Restart recovery may release a
persisted cwd failure only with `nativeNotReady`, the exact failed/unlanded work
and settlement, matching work-capacity source, and no current native reference,
runtime or execution. Result notices do not become reply assignments.

Startup exits preserve their native reference until ownership is reconciled.
Missing-reference recovery enumerates the owner's retained runner generations,
reattaches an existing thread socket, and fences queued opens through the native
serial close before accepting absence. An unreachable generation must also have
no process-lifetime lock owner. Unknown generations, conflicting ownership or an
unacknowledged fence retain the original capacity identity. Recovery never
replays stopped input or changes an already-completed assignment receipt.

Native input acknowledgement custody is queried by `get_input_status` with the exact
`commandId` and `workId`. Native `thread_input_status` receipts distinguish accepted,
rejected and in-flight commands across acknowledgement loss and restart. A query
returns `never_accepted` only after crossing the runner's ordered ingress barrier.
An accepted result confirms insertion without dispatching again; rejection/non-admission
retires only that input and leaves the active execution and later queue intact.
An in-flight result retains custody. Unknown identities and malformed status replies
are errors, not acceptance. Retained pre-status adapters are recognized by their exact
unknown-command response, then queried through their ordered native state barrier:
the adapter writes admission synchronously before its first await, so native absence
after that barrier proves non-admission. This route neither restarts the runner nor
replays the input. Explicit Stop/close still fences all reconciliation.

Retained attachment has one in-flight operation and one native client per thread.
Repeated custody probes reuse that client; concurrent native opens await its
attachment. A new attachment reads native `get_state` before claiming busy or
idle, without resubmitting input. If that observation fails, the attached client
and original custody remain available for explicit recovery. Fleet controller
handoff stops its local lease heartbeat timers before ledger closure, including
failed shutdown, while preserving durable account/broker execution custody for
the next controller.

Provider capacity refusals preserve execution/work identity, retire inactive
native resources, and retry through durable admission without emitting a false
completion. Transient compaction/transport recovery has recorded retry times and
bounded backoff. A successful response may lift a provider hold under the shared
[account evidence policy](../packages/orchestrator/README.md#pooled-credentials-and-admission).

## Caller identity and shared rooms

The thread capability proves the calling agent, not its claimed sender/creator
fields. Router-authenticated humans, runtime/service forwarding and ordinary
process callers remain distinct. Creator provenance is owner stamped; a caller
cannot claim another agent as itself or use placement to gain authority.
See [`caller.ts`](../packages/orchestrator/src/threads/caller.ts).

Human [rooms](../apps/remote/docs/rooms.md) remain audience boundaries with an
unprivileged `pi-rooms` conversation and only root-request/public-question tools.
They are not agent organization groups. Room membership never grants access to
private agents, histories or encrypted folders.

## Incoming model delivery time

[`message-delivery.ts`](../packages/orchestrator/src/threads/message-delivery.ts)
owns `installMessageDelivery(session, env)`. The common native session boundary
installs it once. It projects the final `convertToLlm` output, after request-only
labels, custom/summary/bash conversion and forced application/telephone prompts.
Every incoming system, user and tool-result message receives a leading timestamp;
assistant output is unchanged. Roles, tool IDs, sender labels and external-callee
boundaries are retained. Ingress routes do not prepend their own timestamps.

Delivery time is sampled when a message first enters a prepared model request,
not when a queued receipt was accepted or a runner launched. The prefix contains
local ISO calendar date, millisecond time, numeric UTC offset and IANA zone.
Native message/entry timestamps keep their original provenance. The non-context
`model_message_delivery_v1` receipt stores source identity, original timestamp,
delivery instant and timezone provenance, never message content or a transformed
context snapshot. Subsequent requests, resume and retained compaction history
reuse that delivery record, without another prefix or receipt. Newly generated
compaction/branch messages receive their own delivery records.

The trusted owner launcher declares `PI_PERSON_TIMEZONE_FILE` as
`/var/lib/pi-timezones/USER/timezone.json`. The owning Remote publishes this
narrow projection from its canonical `settings.json` after CalendarStore migration,
then fences every timezone setting write with `state: "updating"` before publishing
`state: "ready"`. Projection files are own-UID, reader-group mode0640 even under
UMask0077; directories inherit the host-owned `pi-timezones-readers` group. Host
provisioning creates directories, never timezone values. Fleet/terminal sessions
read this projection without acquiring the encrypted personal settings directory.

Ready projection schema is exactly `{version:1,state:"ready",timezone:null|{zone,
source,observedAt}}`; source is `configured` or `client-observed`. A declared null
means genuinely unobserved/unset and renders `UTC +00:00; timezone-unconfigured`.
Missing, updating, unreadable or malformed authority rejects delivery. A queued
receipt waits before capacity/native custody and remains queued until authority
recovers; it is not failed or replayed. Owner Remote may also explicitly supply
its resolved `PI_PERSON_SETTINGS_DATA`/`PI_REMOTE_DATA` when no projection is
installed. Shared runners discard another session's inherited paths and metadata.

Root admission/resumption receives only authenticated asking-person timezone
metadata from the memory broker's host-declared `supervisors[].timezoneFile`.
Only the memory service has reader-group access; Root clears settings/projection
paths and consumes `PI_MODEL_DELIVERY_TIMEZONE`, not personal files. Subject names
in the request and caller-supplied metadata never select timezone authority.
Server TZ and another person's settings are never consulted.

## Cutover

Preserve IDs, native histories, accepted settings, pending receipts, executions
and owner boundaries. Never replay completed work. Existing parent links become
provenance; no existing group becomes a new object. Old active runners finish
under their accepted schema and refresh at a safe settlement boundary. Publication
owns one combined source integration, both host releases and shared Android/web
artifacts. The global budget requires an initial census before admitting new
execution; do not seed it empty beneath already-running agents.
