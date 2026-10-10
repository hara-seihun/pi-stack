# Thread state and Remote presentation

The [unified thread design](../../../docs/threads.md) owns execution semantics. Orchestrator's `ThreadService` owns every persistent thread, its input queue, settings, cancellation and parent notifications. Remote has no execution phase machine, work dispatcher, child registry or result relay.

## Ownership and access

`server/server.ts` creates one person-owned `ThreadService` over `DATA/threads.sqlite3`, using Orchestrator's multiplexed shared Pi runner. Native JSONL files remain the conversation store. Thread IDs and parent IDs do not change when sessions unload or the supervisor restarts.

The common `/v1/threads` API is the same directory for humans, agent tools and offline-reader discovery. `/v1/thread-owner` exposes only this person's local service for explicitly configured peer wiring, so owner directories cannot recursively list each other. Remote's existing `/v1/sessions` routes translate presentation operations into that API. All agents share the same `Session` response and transcript view. `origin` identifies backend custody only; foreground/background placement is `metadata.foreground`. Every newly created agent has a separate `agentName`; `name` remains its task title. `parentId` records who launched an agent, not an execution hierarchy. Human opening promotes the original agent into Chats; agent tools and automated inspection cannot promote it. `GET /v1/sessions?allAgents=1` resolves the complete live directory for Open agent and the Agents tab, or reports the owning resource failure. `PUT /v1/sessions/:id/placement` takes an explicit `{foreground}` and requires an authenticated person. `GET /v1/sessions/:sessionId/children` pages the exact owner's direct-child list through all states, including archived children, without opening Pi. The settings response includes the same children. The sidebar can show active children first and expand inactive ones without creating another registry.

The local service runs inside the person's existing Unix account and mount namespace. Remote connects to that Unix person's Orchestrator daemon using the `port` in their `~/.config/pi-orchestrator/config.json`. An ordinary person's missing port disables the peer rather than selecting the administrator daemon on port 2460. The host's UID filter prevents one account from reaching another account's endpoint. For the configured `fleetUser`, `PI_REMOTE_ORCHESTRATOR_URL` can override the fleet endpoint and the existing port 2460 default remains available. A peer failure retains its last listing and exposes an owner error; it does not change local thread execution state.

## Execution state is an observation

Remote projects the owner's `Thread.lifecycle` unchanged. The closed union is Idle,
Working, Waiting (typed target and timestamp; capacity and retry add the provider's reason), Cancelling, Failed (reason and
owned control), or Archived. Only owned execution has Cancel current work. Queued input,
provider backoff and durable dependencies have Cancel wait. A future recovery wake alone
leaves the thread Idle. Native execution recovery is Working, not client Reconnecting.

Web and Android consume the same lifecycle observation for lists, composer and status.
Remote's activity fields are a projection of that union, not another state machine.
Disposable native text/thinking/tool previews cannot override lifecycle. Classic wait
indicators retain dependency details; unified manager presentation uses only Idle,
Working or Typing and hides orchestration identities and controls. Launch provenance
never makes an inactive parent busy.

A failed execution is a notice in the thread's own transcript and an unread marker on its row. An owner-recorded execution failure also projects `executionError`; its reason stays visible rather than being presented as Idle. Owner-level failures follow the [error policy](errors.md): recoverable background attempts stay diagnostic; an owner that needs repair produces one compact consequence/action notice on Machine.

`server/live-projection.ts` stores disposable text, thinking and bounded tool previews. These fields neither admit nor complete work. No GET request or browser selection starts a thread merely to read history. Owner inspection returns cached context or persisted native history without opening Pi.

## Messages and controls

People send with `queue`, `steer` or `hardSteer`. Ordinary composers start with `steer`; the manager chat always sends human messages as `hardSteer` to interrupt its local turn immediately. Agents steer or hard steer; queueing is not available to them, so an agent's message always reaches a boundary rather than waiting behind a turn. The service owns admission and dispatch receipts. A pending message is `queued` until the runtime takes it and `dispatched` after that; whether the thread is holding is the thread's fact, and the client words it.

- Queue waits for the recipient's execution to finish.
- Steer waits for the current local tools without cancelling them.
- Hard steer confirms cancellation of current local execution before sending the selected message first. Other pending messages retain their order.
- **Cancel work** uses owner control `cancel` for the selected agent only, without archiving it or holding work for later continuation.
- **Close agent** uses `close`: confirm selected cancellation, discard its pending work and archive it. Launch descendants are never recursively closed. Dependencies subscribe to durable results; explicit Close wins and subscribers receive cancellation. Closing a dependent releases its subscriptions without cancelling its peers.
- Human reopening uses `open`: unarchive/promote the original agent, without replaying cancelled work. Undo has the same selected-only behavior.

The owner also handles pending-message cancellation/promotion, settings and native session commands. Editing a user message forks through the owner, then Remote replaces its display-event projection and returns the original text to the composer. Sending is a separate operation.

Defaults come from Orchestrator. Remote's model picker restricts which configured models a destination offers; it does not resolve reasoning effort or provider speed independently.

## Remote data

`server/database.ts` stores presentation data in `supervisor.sqlite3`:

- `thread_views` contains AI unread markers and thread colours. Its thread-only order seeds the first shared chat list. Startup drops the columns, `thread_naming_recovery` table and `naming` error rows that Remote's retired automatic naming left behind.
- Context documents and patches contain the provider-neutral display source.
- `message_facts` retains what the supervisor measured about a finished assistant message: the thinking it streamed and its response timing, joined to the message each finalizes.
- Message annotations retain meeting-transcript attachment receipts, with the thread they were attached for.

What a thread is doing right now lives in memory, in `server/session-activity.ts`: a bounded window per thread that Voice narrates from and the meeting panel shows. It is not history. A supervisor restart starts the window again, and the native transcript still holds the conversation. `GET /v1/sessions/:id/events` and the stream's `events` frame serve that window.
- Upload, inline-image and request records retain those Remote features' own custody.
- Notification rows and per-owner cursors deliver durable owner settlement receipts to clients.

The supervisor epoch fences replaced Remote instances from publishing presentation writes. It does not own execution. The Orchestrator importer transfers existing thread identities, native paths, parent links and pending/result receipts before removing the former execution tables and rebuilding presentation references. Active work must settle under its existing owner before the incompatible first cutover.

## Thread titles

A thread's own agent titles it with `thread_title` when the thread starts and whenever the topic has changed enough; Orchestrator records that as `metadata.titleSource: "agent"`. A person's rename through Remote is a manual pin (`titleSource: "manual"`) that the agent cannot override. Remote has no naming model, schedule, receipt or recovery state; it projects the title the thread record carries.

## Handoff

Orchestrator owns shared runners and session adoption. Release handoff suspends service dispatch and callbacks, detaches the shared runner connections and closes the controller database. Native execution remains with the runner. Remote stops its presentation subscriptions, HTTP server and feature workers, then exits with the supervisor's handoff code.

Session cleanup uses session-scoped runner commands, never a shared process PID. Hundreds of threads do not create hundreds of Node processes.

## Notifications

Child-idle notifications are Orchestrator messages with durable execution/work IDs, outcome and final assistant message or explicit absence. They use the same delivery operations as other input. Remote does not extract a child result from its own records or create a second parent relay.

Human notifications project each authorized owner's sequenced settlement, question and attention feeds into the existing durable ledger. Attention carries `kind: "attention"` and its summary unchanged, and can notify a running background agent. Notifications never promote an agent automatically. Foreground completion follows that agent's own work and dependencies, not the activity of agents it launched. Receipt and owner cursor commit together; replay cannot mark an acknowledged record unread again. `GET /v1/notifications` without `after` establishes replay position; later replay pages contain up to 100 records.

The persistent **Notifications** tab uses `GET /v1/notifications?history=1[&before=N]`, which returns `{notifications,before}` independently of replay. Each record has `status: "needs-you" | "history" | "unavailable"`; unavailable requires an `error`. Question `questionId` receipts are resolved against the original owner's current pending questions. The latest unread attention needs the person; acknowledged attention and answered/dismissed questions remain in History. Owner failure preserves the record with an explicit resource error. Opening any record opens/promotes the original thread. Viewing clears unread, not the ledger or an unanswered question. Retention is per agent: unseen/unread agents and both explicit dependency endpoints stay; launch provenance never cascades cleanup.

## Network synchronization

Each client retains a bounded replica and synchronizes it through finite `POST /v1/reconcile` requests declaring wanted resources and the revisions actually held. Its `{events}` response carries bootstrap, changed resources and the selected conversation's readiness acknowledgement after owner inspection. The entire response must validate before synchronization is healthy. A matching `selection-ready` requires the selected session, selection ID and applied state/transcript/live revisions; cached history or hello cannot acknowledge a visible conversation. After reconciliation the client attaches disposable `POST /v1/stream` push. No stream ID or retained server session is needed to select, revalidate or recover state. A comment every ten seconds keeps push alive; abort drops its registry entry.

State moves through shared reconciliation frames. Each resource revision is the hash of its actual normalized snapshot, not a count of database writes. A retained base permits a validated patch; otherwise the owner sends a complete resource. Missing patch bases forget only that resource's claimed revision and immediately reconcile without reporting connection loss. Queued message text travels only for the thread its client has open; other rows carry counts. Archived agents, quiet background agents older than an hour and Machine are not in that projection. Placement, not backend ownership, controls inclusion; selected, working and recent agents retain useful launch provenance. The first-class Agents tab and Open agent picker use the complete `allAgents=1` directory, while the `workers` wire resource supplies live fleet updates while Agents is visible and remains available to older clients. Agents groups every live background agent by its immediate launcher, with Scheduled & system and No launcher groups; these are presentation only. Running/waiting groups start expanded, and quiet groups can be expanded or searched. The directory loads on entry, manual refresh, visibility return, reconnection and every 30 seconds while visible; resource failures retain explicitly stale rows with Retry. Live stream observations update its statuses and placement without waiting for directory refresh. Old worker thread links redirect to the original agent in Chats; the old worker home redirects to Agents. The picker pages archived threads, and the dashboard travels only to streams that subscribe to it, which is also the only time it is refreshed. Idle notifications and Voice events ride the stream when a client passes a cursor for them; `GET /v1/notifications` and `GET /v1/sessions/:id/events` remain for Android's native service and other environments.

Opening, selection changes, invalidation, foreground return and network changes reconcile immediately, fencing superseded generations. Revalidation and disposable push failures do not change a healthy connection to Reconnecting. Selection freshness has its own Updating state. Finite synchronization has a five-second deadline; only its actual failure starts a five-second loss grace. Sustained failure then reports **Connection lost. Reconnecting…** until a completely validated finite response succeeds. Authentication and malformed protocol input fail explicitly without the transport grace. Push silence for thirty seconds triggers immediate finite recovery, with repeated push failures backing off to five seconds. Comments reset that silence deadline. Normal hidden clients cancel requests, push, retries and timers; intentional Voice/Meet transports remain active. Mutation responses request reconciliation instead of creating a second client-side copy of thread state.

WebSocket upgrades under `/v1/` take the same identity-router path as HTTP requests. The router checks the session, person lock and endpoint grant before opening the person's local or granted remote supervisor. It removes router credentials from the upstream URL and identifies the person with `x-pi-remote-user`. Closing either side closes the other with the same usable close code. The bridge caps messages at 1 MiB and stops forwarding new messages toward a peer while its pending sends are at least 64 KiB. It drops those messages rather than adding an application queue. Compression stays off.

Peer listings and inspections are derived caches. They are not another registry or execution owner. Local thread snapshots come directly from the person-owned service.

## Native history and live output

The interactive view is Pi's durable native conversation history. It preserves thinking, tools, exact message identities and earlier exchanges across compaction. Live deltas are disposable; a persisted native message refreshes transcript heads and clears live output. A native revision conflict during a background transcript projection keeps the last acknowledged heads and schedules a fresh coalesced projection; it is not a transport-disconnect event. Other source failures remain explicit.

The per-record display projection strips provider continuation metadata and replaces image bytes with thread-scoped content-addressed URLs. Native entries remain unchanged. Tool-result images load when expanded.

`server/transcript-items.ts` derives each requested user message, assistant text/thinking block and tool call paired with its result. An item's ID is the SHA-256 of its body. Small heads contain visible text or bounded previews; exact bodies come from `GET /v1/sessions/:sessionId/items/:itemId` with immutable caching. The generation survives append and compaction while earlier item identities remain; changing branches replaces the generation. `GET /v1/sessions/:sessionId/transcript` pages older heads and answers 409 when the client's generation is stale.

`GET /v1/sessions/:sessionId/context` streams native entries in bounded revision-pinned pages; `?leafId=ID` selects a branch. `?view=current` inspects an active runtime's effective context on demand. Reopening or exporting an inactive thread does not start execution.

`server/live-projection.ts` and `server/tool-progress.ts` preserve bounded live tool previews until native results arrive. `server/thread-transcript-source.ts`, `server/context-display.ts` and `server/source-transcripts.ts` own native-window display, projection and lazy source access. Voice reads recent native messages through the same owner inspection boundary.

## New/Open Chat picker

The shared browser/Android plus picker opens category choices first: Personal, Home, Open agent, Archived and shared Rooms. Personal and Home open model choices; a destination that offers context files shows their checklist with token counts on that same stage, and the checked names are part of the creation request. Open agent offers Background, Foreground and All filters across the complete live directory. Archived and Rooms open their own lists. Up to eight options appear directly; larger collections have search across every option with at most twenty results. Archive search responses belong to the category and query that requested them; a late response cannot replace a newer search. The picker is an opaque full-height modal and scrolls within the visible viewport. Inbox archive search opens its Archived category with the query preserved through lazy loading; that category always keeps its search field available. Selecting a previous AI conversation restores it without resuming work merely to display history. Creation and send retries retain their request identities; dismissing the picker does not cancel an accepted operation or let a late response replace a newer selection.

Current Chats is an account-shared presentation list, not an execution state. X on an agent closes only that agent; a dependency refusal leaves it current and links its explicit dependency owner. X on human chats changes only their current flag. Incoming human messages can reopen a closed chat, but outgoing sync receipts and AI completions cannot. A reopened chat never steals local selection. Read idle AI threads can leave the list through the configured inactivity rule; unread agents protect themselves, not launch ancestors.

## Files and attachments

File browsing remains an environment-level lazy tree. Uploads resume from committed offsets and verify the completed hash. Draft attachments belong to their selected thread. Downloads support validators and byte ranges. Inline-image generation remains a Remote-owned feature worker with its own durable receipts; it does not keep the thread executing while an image provider works.
