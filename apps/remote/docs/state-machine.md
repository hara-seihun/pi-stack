# Thread state and Remote presentation

The [unified thread design](../../../docs/threads.md) owns execution semantics. Orchestrator's `ThreadService` owns every persistent thread, its input queue, settings, cancellation and parent notifications. Remote has no execution phase machine, work dispatcher, child registry or result relay.

## Ownership and access

`server/server.ts` creates one person-owned `ThreadService` over `DATA/threads.sqlite3`, using Orchestrator's multiplexed shared Pi runner. Native JSONL files remain the conversation store. Thread IDs and parent IDs do not change when sessions unload or the supervisor restarts.

The common `/v1/threads` API is the same directory for humans, agent tools and offline-reader discovery. `/v1/thread-owner` exposes only this person's local service for explicitly configured peer wiring, so owner directories cannot recursively list each other. Remote's existing `/v1/sessions` routes translate presentation operations into that API. Root, child and fleet threads share the same `Session` response shape and transcript view. `origin` identifies person or fleet ownership for filtering; it does not select another lifecycle. `GET /v1/sessions/:sessionId/children` pages the exact owner's direct-child list through all states, including archived children, without opening Pi. The settings response includes the same children. The sidebar can show active children first and expand inactive ones without creating another registry.

The local service runs inside the person's existing Unix account and mount namespace. Remote connects to that Unix person's Orchestrator daemon using the `port` in their `~/.config/pi-orchestrator/config.json`. An ordinary person's missing port disables the peer rather than selecting the administrator daemon on port 2460. The host's UID filter prevents one account from reaching another account's endpoint. For the configured `fleetUser`, `PI_REMOTE_ORCHESTRATOR_URL` can override the fleet endpoint and the existing port 2460 default remains available. A peer failure retains its last listing and exposes an owner error; it does not change local thread execution state.

## Execution state is an observation

Remote publishes the shared `ThreadState` unchanged as `idle` or `running`, alongside `held`, which is true while a thread holds its pending messages after a confirmed stop. Live Pi events can add thinking, tool, compaction or retry display details while the thread is running, and `activeTools` names every tool running right now. These details do not control execution or add lifecycle states. An idle parent stays idle while its children run.

The client's status line is composed from those facts and never from a status field of its own:

| Reads | From |
| --- | --- |
| `Thinking`, `Running bash`, `Running bash and web_search`, `Running 3 tools`, `Compacting context`, `Retrying`, `Working` | `state: running` plus the live activity and `activeTools` |
| `Waiting on workers` | `state: idle` with running children |
| `Idle`, with an unread dot until the person opens it | `state: idle` plus `idleUnread` |
| `Stopped`, with the queue chip carrying what it holds | `held` |
| `Archived` | `archivedAt` |

A failed execution is a notice in the thread's own transcript and an unread marker on its row. There is no thread-level error field and nothing for the person to dismiss; owner-level failures, such as a naming route that cannot run, stay on the Machine screen where their owner is named.

`server/live-projection.ts` stores disposable text, thinking and bounded tool previews. These fields neither admit nor complete work. No GET request or browser selection starts a thread merely to read history. Owner inspection returns cached context or persisted native history without opening Pi.

## Messages and controls

People send with `queue`, `steer` or `hardSteer`, and the composer defaults to `queue`. Agents steer or hard steer; queueing is not available to them, so an agent's message always reaches a boundary rather than waiting behind a turn. The service owns admission and dispatch receipts. A pending message is `queued` until the runtime takes it and `dispatched` after that; whether the thread is holding is the thread's fact, and the client words it.

- Queue waits for the recipient's execution to finish.
- Steer waits for the current local tools without cancelling them.
- Hard steer confirms cancellation of current local execution before sending the selected message first. Other pending messages retain their order.
- Stop requires an explicit `descendants` boolean, cancels the selected execution scope and holds pending messages.
- Resume returns `no_pending_messages` when nothing is held. It starts no empty work.
- An explicit new message resumes a held thread with that message first. Automatic notifications stay held.

The owner also handles pending-message cancellation/promotion, settings and native session commands. Editing a user message forks through the owner, then Remote replaces its display-event projection and returns the original text to the composer. Sending is a separate operation.

Defaults come from Orchestrator. Remote's model picker restricts which configured models a destination offers; it does not resolve reasoning effort or provider speed independently.

## Remote data

`server/database.ts` stores presentation data in `supervisor.sqlite3`:

- `thread_views` contains AI unread markers, naming counters and completion receipt references. Its thread-only order seeds the first shared chat list.
- `metadata.current_chat_order` stores mixed AI/human order keys for Current Chats. Messaging current flags and snapshot version stay in the encrypted messaging store.
- Context documents and patches contain the provider-neutral display source.
- `message_facts` retains what the supervisor measured about a finished assistant message: the thinking it streamed and its response timing, joined to the message each finalizes.
- `thread_views.message_count` counts message boundaries as they happen, so naming keeps its place across a compaction that shortens the context.
- Message annotations retain meeting-transcript attachment receipts, with the thread they were attached for.

What a thread is doing right now lives in memory, in `server/session-activity.ts`: a bounded window per thread that Voice narrates from and the meeting panel shows. It is not history. A supervisor restart starts the window again, and the native transcript and captured context still hold the conversation. `GET /v1/sessions/:id/events` and the stream's `events` frame serve that window.
- Upload, inline-image and request records retain those Remote features' own custody.
- Notification rows and per-owner cursors deliver durable owner settlement receipts to clients.

The supervisor epoch fences replaced Remote instances from publishing presentation writes. It does not own execution. The Orchestrator importer transfers existing thread identities, native paths, parent links and pending/result receipts before removing the former execution tables and rebuilding presentation references. Active work must settle under its existing owner before the incompatible first cutover.

## Thread naming

Naming uses Orchestrator's durable tool-free `CompletionClient`, not a Pi process or a hidden thread. Remote saves a stable thread/message-count request ID and immutable input before submission, then reconciles the owner's receipt. Orchestrator owns provider execution and retry policy. A supervisor restart reuses the receipt rather than submitting another inference.

With an OpenAI selection, the completion owner must be explicitly permitted for the same Unix person. Without one, the thread keeps its current name and exposes a naming error. That route supports the completion facility's Luna model. Defaults come from that facility; an explicit effort in `PI_REMOTE_THREAD_NAMING_MODEL`, such as `:low`, is forwarded. Speed is standard. With a `local/ENGINE/MODEL` selection, the supervisor calls the manifest engine in place with thinking off and keeps no `naming_request` receipt; `naming_attempted_count` still advances before the call so one message count is tried once. Unsupported models and failed naming results are visible in the drawer's owner errors.

## Handoff

Orchestrator owns shared runners and session adoption. Release handoff suspends service dispatch and callbacks, detaches the shared runner connections and closes the controller database. Native execution remains with the runner. Remote stops its presentation subscriptions, HTTP server and feature workers, then exits with the supervisor's handoff code.

Session cleanup uses session-scoped runner commands, never a shared process PID. Hundreds of threads do not create hundreds of Node processes.

## Notifications

Child-idle notifications are Orchestrator messages with durable execution/work IDs, outcome and final assistant message or explicit absence. They use the same delivery operations as other input. Remote does not extract a child result from its own records or create a second parent relay.

Human notifications project each authorized owner's sequenced settlement feed. `server/thread-notifications.ts` commits the notification receipt and that owner's cursor together. Receipt IDs prevent replay from marking a viewed thread unread again. One owner's cursor cannot skip another owner's completions. `GET /v1/notifications` without a cursor establishes the current position; later requests replay up to 100 notifications. Viewing a thread clears its unread marker.

## Network synchronization

Each client holds one server-sent event stream. `POST /v1/stream` carries the subscription and answers with the stream; `POST /v1/stream/:streamId` changes the subscription and answers 204, after which the server pushes whatever the change entitles the client to. The first event is `hello` with the supervisor epoch, the stream id and the bootstrap facts (environment, home, thread-start profiles), followed by full state and the messaging inbox. A comment line every ten seconds proves the connection is alive; an aborted request drops the stream's registry entry.

State moves as deltas. The inbox projection is encoded once per version, and a stream sends the thread rows whose encoding differs from what that client holds plus the ids of rows that disappeared. The version changes when the projection changes, not when SQLite counts a write. Queued message text travels only for the thread its client has open; other rows carry counts. Archived threads, the Signal directory and the Machine screen are not in that projection: the picker pages archived threads, `GET /v1/messaging` returns the complete directory, and the dashboard travels only to streams that subscribe to it, which is also the only time it is refreshed. The messaging event carries the conversations that are recent, unread or open. Idle notifications and Voice events ride the stream when a client passes a cursor for them; `GET /v1/notifications` and `GET /v1/sessions/:id/events` remain for Android's native service and other environments.

A client that loses its stream opens a new one and receives `hello` and full state again. An epoch it does not recognize means the supervisor was replaced. Mutation responses request reconciliation instead of creating a second client-side copy of thread state.

WebSocket upgrades under `/v1/` take the same identity-router path as HTTP requests. The router checks the session, person lock and endpoint grant before opening the person's local or granted remote supervisor. It removes router credentials from the upstream URL and identifies the person with `x-pi-remote-user`. Closing either side closes the other with the same usable close code. The bridge caps messages at 1 MiB and stops forwarding new messages toward a peer while its pending sends are at least 64 KiB. It drops those messages rather than adding an application queue. Compression stays off. Signal call audio uses this path at `/v1/messaging/calls/:callId/audio`, where the supervisor connects the socket to the call service. Audio remains fixed 1920-byte binary frames and a slow browser or supervisor loses frames instead of delaying later audio.

Peer listings and inspections are derived caches. They are not another registry or execution owner. Local thread snapshots come directly from the person-owned service.

## Context and live output

Pi's model context is the interactive view. The context mirror publishes durable message boundaries; live deltas take an in-memory path. Final live text remains until the matching context replacement acknowledges it. Compaction must acknowledge its replacement, otherwise Remote clears the stale document rather than displaying removed messages.

The display projection strips provider continuation metadata and replaces inline image bytes with thread-scoped content-addressed URLs. Canonical context remains unchanged. Tool-result images load when expanded. The context mirror still writes verified byte splices into the journal, which checkpoints before its configured entry and byte limits; that is storage between the runtime and the supervisor, not what clients receive.

Clients receive transcript items. `server/transcript-items.ts` derives an ordered list from the display projection: the system prompt, each tool schema, each user message, each assistant text and thinking block, and each tool call paired with its result. An item's id is the SHA-256 of its body, so a landing result changes exactly one item. Heads are small — inline text for what is visible, a preview for what opens on expansion, bounded arguments for a tool call — and bodies come from `GET /v1/sessions/:sessionId/items/:itemId`, which is immutable and cacheable forever. The list keeps its generation while every earlier item's identity survives; compaction, a failed compaction that clears the document, a fork and tree navigation mint a new generation and the client reloads its window. `GET /v1/sessions/:sessionId/transcript` pages older heads and answers 409 with the current generation when the client's is stale. `GET /v1/sessions/:sessionId/context` still returns the canonical document for tooling.

Live text and thinking travel as appends measured against what that stream already wrote, and as a reset when the runtime shortens or clears its buffer, which happens when a captured context acknowledges the message or the thread settles. Thinking travels only to clients that opened the thinking card.

`server/live-projection.ts` and `server/tool-progress.ts` preserve current tool cards until canonical context contains their results. `server/context-journal.ts`, `server/context-display.ts`, `server/transcript-items.ts` and `server/sync.ts` own document storage, derivation and transport details.

## New/Open Chat picker

The shared browser/Android plus picker opens category choices first: Personal, Home, Archived, then configured messaging profiles. Personal and Home open model choices; a destination that offers context files shows their checklist with token counts on that same stage, and the checked names are part of the creation request. Archived and messaging profiles open their own recent-first lists. Up to eight options appear directly; larger collections have search across every option with at most twenty results. Archive search responses belong to the category and query that requested them; a late response cannot replace a newer search. The picker is an opaque full-height modal and scrolls within the visible viewport. Inbox archive search opens its Archived category with the query preserved through lazy loading; that category always keeps its search field available. Plugin icons identify messaging backends. Selecting a known human conversation reopens that conversation rather than creating a duplicate. Selecting a previous AI conversation restores it without resuming work merely to display history. Creation and send retries retain their request identities; dismissing the picker does not cancel an accepted operation or let a late response replace a newer selection.

Current Chats is an account-shared presentation list, not an execution state. X on AI chats confirms Stop with descendants before closing the root; failure leaves it current. X on human chats changes only their current flag. Incoming human messages can reopen a closed chat, but outgoing sync receipts and AI completions cannot. A reopened chat never steals local selection. Read idle AI threads can leave the list through the configured inactivity rule; unread threads protect themselves and their ancestors.

## Files and attachments

File browsing remains an environment-level lazy tree. Uploads resume from committed offsets and verify the completed hash. Draft attachments belong to their selected thread. Downloads support validators and byte ranges. Inline-image generation remains a Remote-owned feature worker with its own durable receipts; it does not keep the thread executing while an image provider works.
