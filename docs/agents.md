# Kena: one agent model

Hara's October 7, 2026 design replaces the conversation/worker hierarchy. Kenan is
a collection of kena. Each agent has a stable conversation, not a special class
selected by its launcher or storage service.

## Identity and presentation

Every newly created agent receives a random Nebulani name from
[`getRandomName`](../packages/orchestrator/src/nebulani-names.ts), independently of
its task title and UUID. The name is an immutable label, not authority or a unique
lookup key. Existing histories and thread IDs remain in their current storage
owners. In its own conversation the assistant is labelled **Kenan**. Incoming
agent messages display the sender's Nebulani name and readable message body, not
User or the native agent-envelope XML. The model still receives the explicit
agent-to-agent boundary; presentation does not turn agent input into human input.

An agent has foreground or background placement. The human's explicit opening
promotes it; agent attention requests only notify. Reading another agent through
a tool or a background subscription never promotes it. Orchestrator lanes,
schedules and agent launches create background agents through the same API.
Placement does not change tools, permissions, admission, or execution identity.

The first-class **Agents** tab lists the complete live background directory,
including quiet agents outside the recent inbox projection. Collapsible groups
use each agent's immediate launcher; scheduled/system agents and agents with no
launcher have their own groups. Task titles and optional agent-authored purpose sentences lead each row; visible
current activity and dependency reasons explain what is happening now. Names and
short IDs remain separate, secondary identity. All, Active, Waiting and Idle filters and search narrow the directory.
Completed background tasks leave the directory immediately without requiring a
human view; their results, transcripts and notification history remain preserved.
Opening a row promotes that original agent into Chats. These are presentation
groups, not worker classes, rooms, dependencies or cascading control scopes.
Notifications remains its own navigation destination.

The sidebar lists agents this agent launched. The retained `parentId` records
that provenance only: no implicit stop tree, worker class, leaf restriction or
resource exemption. There are no organizational rooms or worker groups. Existing
multi-person rooms still have their separate audience/custody contract; this
change does not publish private agent histories into them.

## Dependencies and work

An agent may subscribe to the result of any accessible peer. The subscription
persists until terminal delivery or explicit release. Explicit Close wins on either
endpoint: closing the producer delivers cancellation, and closing the subscriber
releases its subscriptions without closing peers. Agent control changes only its
own outgoing subscriptions. Provenance and room membership do not establish them.

Dependencies persist independently of a native model turn. Discussing work or
receiving an unrelated message does not erase them. Without local execution,
explicit waits and unresolved outgoing subscriptions show one **Waiting** state,
never Idle. Active execution wins over waiting reasons. Waiting holds no execution
capacity. A settled native turn is not a
completed assignment while dependent work or unanswered questions remain.
Schedules and watches must use the shared outstanding-work predicate rather than
infer completion from an empty input queue.

## Closing and reopening

Close means cancel the selected agent's execution and archive its conversation.
There is no persistent Stopped state and no cascading close based on who launched
whom. Failed cancellation is a visible failure; it never authorizes concurrent
replacement work or a false archived state. Pending input is not silently revived
on reopening. Result subscribers receive a durable cancelled terminal settlement,
including when the selected agent was waiting rather than executing.

Reopening restores the conversation, not interrupted work. Only a new explicit
assignment starts work again. Cancel-current-work is a transient operation, not
a lifecycle state: it ends the current work without archiving the conversation.

## Attention and errors

Notifications needing the person are durable history, accessible from the
Notifications tab after a transient notification disappears. Selecting one opens
the original agent. Attention cannot self-promote, release dependencies or reopen
an archived conversation.

Question loading has resource-scoped loading/ready/failed state. A question-read
failure does not mean the transport or agent is offline. Retained questions may
be shown as stale; successful recovery clears only the corresponding resource
error. Unknown questions are not an empty successful list.

## Execution budget

Across all Pi Stack hosts and owners, at most **100 agents may execute** at once.
Foreground, background, fleet, application and privileged agents share the same
budget. Dependency-waiting agents hold no execution slot. Additional runnable
work queues with a capacity reason. Forced/live model admission is not an
exemption. Execution slots and provider spending policy are independent.

The capacity authority owns durable execution custody. Restart, controller
handoff and uncertain cancellation cannot free a slot by assumption. Initial
activation requires a coordinated census of existing execution, not an empty
counter while old agents continue. An unreachable authority cannot authorize new
execution. [Capacity operations](../packages/orchestrator/docs/agent-capacity.md)
own the authority, census and managed admission; [direct executions](standalone-agent-capacity.md)
own privileged SDK requests, CLI agents and publication doctors outside ThreadService.

## Integration

The [thread API](threads.md) implements persistent identity, messages, controls,
waits and execution. Remote projects it into one shared browser/Android UI.
Orchestrator is a producer and resource admission owner, not another agent type.
Native Pi remains the execution engine; separate Unix people, encrypted folders,
application boundaries and unprivileged shared-room custody remain separate.
