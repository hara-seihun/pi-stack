# Persistent agents and threads

[The kena model](agents.md) owns the product contract. One agent has one stable
thread ID, native Pi conversation, workspace, complete model settings and storage
owner. Foreground/background is placement, not a class of agent. Orchestrator,
Remote, schedules, tools and the CLI use the same ThreadService operations.

## Identity, custody and placement

New threads receive an immutable Nebulani `agentName`, separate from the mutable
conversation title and UUID. Historical unnamed threads retain their identity;
a name is not an authorization credential. `parentId` records the agent that
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

`lastUserMessageAt` records accepted explicit input without an agent sender.
Automatic notices, agent messages, tool activity, naming and settlements do not
change it. Imports retain original timestamps. Creation time orders threads with
no person input.

Imported settings are complete model/thinking/speed values. Invalid settings
return `invalid_request` before creating work; bulk import rolls back atomically.
Only creation/control override requests resolve partial preferences.

## State and work

Native execution and assignment completion are distinct. `running` includes
accepted runnable input, admission, startup, execution and cancellation until
confirmed. `waiting` describes an agent with a durable dependency but no local
execution. `idle` is genuinely available with no current work. Archived agents
retain history but accept no automatic execution. There is no persistent Stopped
product state.

Execution activity names observed phases: queuing, admission, opening, inference,
tools, compaction, cancellation or provider recovery. Missing instrumentation is
a status defect, not a reason to invent Idle or Working. The same state feeds
status pills, lists, notification policy and recurring producers. See
[explicit dispatch](state-dispatch.md) and [runtime wire](runtime-wire.md).

A native turn ending does not finish an assignment that still has a dependency or
unanswered question. Settlements with `assignmentPending` are not completion
results for peer awaiting. The synchronous `threadHasOutstandingWork` predicate
covers execution, queued input, waits, dependencies and recovery wakes; callers
also inspect durable questions before declaring completion.

## Dependencies

`control({ action: "dependencies", threadId, threadIds })` replaces an agent's
outgoing peer dependencies. Agent callers can change only their own edges.
Dependencies reference accessible peers, not only agents they launched. Cycles
and invalid/inaccessible targets are rejected.

A dependency A → B protects **both A and B** from close/archive. A refusal uses
`dependency_conflict` with the actual edges, so the person can visit A and ask it
to resolve or release the dependency. Creator provenance alone protects neither
endpoint. An unrelated message or recovery wake does not erase dependency
protection. Dependency changes and close must enforce the invariant at the owner,
not just in a client's confirmation dialog.

`thread_wait` sets a scheduling wait and ends the native turn without polling:

```json
{"action":"set","kind":"agents","reason":"Need the implementation result","threadIds":["peer-id"]}
```

The other variants identify `jobId`, `publicationId`, or a collaborator
`fromThreadId`. Every variant has a concrete reason and dependency identity;
there is no available-for-assignment or generic external wait. Peer waits use
optional owner settlement cursors in `after`. `clear` releases the caller's wait
and outgoing dependency protection. Explicit dependencies can also be managed
without suspending current execution.

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

- `close`: cancel and archive only the selected agent. Dependencies veto it.
  Failed cancellation leaves visible custody and never permits overlapping work.
- `reopen`: restore the conversation without resuming interrupted or queued work.
- `open`: human opening also promotes foreground placement.
- `cancel`: end the selected agent's current work without archiving it or leaving
  a persistent stopped state.
- `placement`: explicit human-controlled foreground/background change.
- `rename`: pin a nonblank conversation title against automatic naming. This does
  not rename the agent's Nebulani identity.
- `settings`: future model/thinking/speed preferences; `effectiveSettings` names
  already accepted current/queued work.
- `retryWaiting`: apply selected settings to dormant provider/admission waiting
  work without interrupting genuinely live work or bypassing real quota refusal.

Retained Stop/restore requests select only the named agent; old descendant or
resume flags never revive a cancellation tree or replay archived input. A closed
agent's old pending messages do not resume simply because the person reopened it.

Ephemeral creation is retention policy, not another kind of agent. It may archive
only after the assignment really settles: no active work, dependencies, waits,
wakes, attention awaiting the person or unanswered questions. Foreground and
unread human attention remain discoverable. Automatic retention cannot bypass
explicit dependency protection.

## Questions and attention

`request_user_input_async` stores independently answerable questions with stable
IDs, suggestions and optional recommendation. Answers arrive as correlated human
messages at a safe boundary. Dismissal explicitly skips the question; it does not
authorize a suggestion. Questions survive turn settlement and restart.

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
that limit. Model quota pacing and execution slots are distinct policies.

Model settings resolve centrally. New delegated agents use Sol/high/standard
unless explicitly configured; Luna uses max thinking. Models are not prohibited
merely because the requesting agent itself was launched by another agent.
Machine model availability applies to new creation, while accepted existing
settings and historical attribution survive policy changes. Actual provider
exhaustion, reservations and readiness remain independent admission constraints.

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

## Cutover

Preserve IDs, native histories, accepted settings, pending receipts, executions
and owner boundaries. Never replay completed work. Existing parent links become
provenance; no existing group becomes a new object. Old active runners finish
under their accepted schema and refresh at a safe settlement boundary. Publication
owns one combined source integration, both host releases and shared Android/web
artifacts. The global budget requires an initial census before admitting new
execution; do not seed it empty beneath already-running agents.
