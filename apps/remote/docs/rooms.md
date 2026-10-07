# Rooms

Rooms are several people from this host plus an unprivileged Kenan in one conversation. They are
enabled only when `host.json` has `oneKenan: true`. With the flag absent, neither room stores nor
room requests are created; the existing inbox and transports are unchanged.

Rooms appear alongside regular chats in the same Needs you, Working and Quiet inbox rows in the
browser and Android web client. Any authenticated person can create a room and add registered people. Members can send, read the conversation and
its thinking/work/context, answer Kenan's questions, and stop his turn. Adding someone shares the
existing room conversation; the picker says so. Adding requires the room to be idle, so an audience
cannot expand under an utterance already in progress. Removing members is not implemented.

## Custody and routing

A room is always a **fresh** root conversation thread, never a private thread made shared. It lives
in the dedicated `pi-rooms` supervisor, under its own unprivileged Unix account and state directory.
It has no keys, private folder mounts or personal context files. The host router owns a directory
mapping stable room IDs to the execution custodian and roster. The authenticated creator is recorded
separately; the creator is not the room's execution identity. Changing the custody location later
is a data migration, not a client API change or a copy into each member's private store.

The initial implementation briefly used creator-supervisor custody in source, before the root-Kenan
revision. If such a staged directory exists, its `creator` column is populated from the original
owner without deleting anything. Those room rows require explicit custody migration before they
can run; they never fall back to executing with the creator's private access. No real room data
was created by this slice and no live services or mounts were changed.

Each member reaches the router under their **own** authenticated session. The router checks
membership and creates a narrow trusted request to `/v1/room-owner/:id` on `pi-rooms`. The header
identifies the actual speaker. The owner verifies a local router person caller and checks
`thread.metadata.room.members` independently. Clients cannot choose another port or an arbitrary
thread. Direct access to the internal owner route, including via remote and WebSocket proxy paths,
is rejected. Per-person supervisors accept only the internal notification-delivery operation;
they cannot create or execute rooms.

## Transparent room execution and root requests

`PI_REMOTE_ROOMS_RUNTIME=1`, fixed custodian `PI_REMOTE_SENDER_ID=pi-rooms`, and a server-bound
`PI_REMOTE_ROOM_ID=threadId` select the room execution boundary in `pi-session`. Missing or
mismatched identity fails closed. Discovered extensions, skills, templates and instruction files
are disabled. The exact initialized model-facing tool set is checked:

- `ask_kenan`
- `request_user_input_async`

There are no local file/shell tools, general thread discovery/history/messaging tools or direct
memory tools. This also prevents one room from reading another room's files or history under the
shared service UID. The client sees all room-local thinking, tool requests/results, notices and
context. Native session records use their actual type names instead of anonymous “notice” rows.
Snapshots expose stopped state and the latest failed execution's error, including failures before
any user message reaches native history; a failed room must not masquerade as an empty idle chat. Root does file operations, actions and private-memory work; only his chosen reply comes
back through `ask_kenan`. Root histories are not part of the room snapshot.

`metadata.room = { id, members: [{ user, displayName }] }` is the audience. The runtime fetches turn
instructions on every turn, so membership changes do not become stale process environment. Each
incoming human message has an owner-generated `Room sender` label using the router-authenticated
person. The private-chat identity path does not interpret this label. Question answers use a
persisted speaker receipt and the same input preparation. A member's name in request text does not
grant that member's individual authority to the collective room.

Root memory admission uses the **current host directory**, not an audience claimed in a request:
`roomAudienceResolver` in `server/room-audience.mjs` uses Node's read-only SQLite API and returns
`{roomId,people}` only for the authenticated `pi-rooms` custodian and a ready matching room row.
An unknown room token throws instead of downgrading to a private/person audience. The shared memory
service wires it with `PI_KENAN_ROOM_AUDIENCE_MODULE`; root admission and finalization must use
this callback. The source does not expose credentials or a client registration route.

## Runtime configuration

The service entrypoint is `bun /srv/pi/pi-remote/server/rooms-main.ts`. Deployment owns the
`pi-rooms` account, models/broker configuration and service unit. The launcher refuses root and the
administrator, checks the flag and fixed config user, and fixes its workspace/profile to room state.

- `PI_REMOTE_CONFIG=/etc/pi-stack/rooms.json`: standard version-1 config, `user: "pi-rooms"`.
- Home/state: `/var/lib/pi-rooms`; `PI_REMOTE_DATA` overrides state for staging.
- `PI_AGENT_DIR=/var/lib/pi-rooms/agent`: model and broker settings, not a person's credential files.
- Listener: `PI_REMOTE_PORT=18822`, loopback only; fixture may use another loopback port.
- Router: `PI_REMOTE_ROOMS_OWNER_URL=http://127.0.0.1:18822`, a validated loopback HTTP origin.
- Router directory: `PI_REMOTE_ROOMS_DB=/var/lib/pi-remote/one-kenan/rooms.sqlite3`.
- Memory service: `PI_KENAN_ROOM_AUDIENCE_MODULE=/srv/pi/pi-remote/server/room-audience.mjs` and
  the same `PI_REMOTE_ROOMS_DB`; its UID needs read/traverse on the directory, DB, WAL and SHM.
- The memory auth registry provisions a supervisor capability for `pi-rooms`. Its token is loaded
  privately by the service; persons never receive it. Session tokens bind the current room thread.

There is no creator-private runtime fallback when the room service or root request channel is down.
The room listener's UID gate admits root and `pi-rooms`: the room runner must fetch its own
`/v1/sessions/:id/instructions` before every turn. Blocking that self-connection rejects input
before a native user message or model request exists (`thread_rejected: fetch failed`). Ordinary
person UIDs remain excluded from the internal listener and use the authenticated router.

## Notifications and persistence

The router directory also owns a durable per-member notification outbox. Invitations, accepted
human messages, questions and finished assistant replies become idempotent deliveries to each
member's existing supervisor ledger. An unavailable member leaves delivery pending for retry.
The existing cursor and Android native protocol are unchanged. Targets are `room:UUID`; the shared
client opens room routes and suppresses notifications for the visible room. The ordinary native
completion target is suppressed to avoid a duplicate private-thread target.

The router follows each ready room's authenticated owner change feed. Native thread events and row
changes invalidate that room; active bursts coalesce over one second, and unchanged idle rooms do
not trigger history reads. Startup and reconnect hydrate current owner evidence. Replies and
questions still reconcile into the durable outbox without any browser connected. Undelivered
notifications retry every 30 seconds; failed owner subscriptions/retrievals back off up to 30 seconds.
Room listing reads hydrate only missing owner evidence for that person's rooms. Scheduling/model/tool phases, held
state, errors and progress clocks travel with the owner snapshot to both the directory and open
conversation. Retrieval failure returns `status_error` with its cause and clears stale execution
clocks/tools, rather than presenting cached running state as healthy. The directory persists inbox,
unread, pending-question and last-message facts; execution phases and clocks remain with their
runtime owner and are refreshed after restart. One router-owned revision stream serves room discovery and the selected conversation while the
client is visible. It sends directory and member-filtered snapshot revisions only on change; unchanged
reconnect cursors produce no repeated invalidation. The client fetches changed resources, using
bounded revision patches rather than resending the whole unchanged history. Hidden clients close
this stream, cancel snapshot reads/retries, and resume from their cursor. These are narrow room
requests, not another person's event stream; intentional Meet/voice resources are unaffected. Member additions and sends serialize per room at the router. Turning the flag off preserves
the directory, outbox and native histories. Snapshot history comes from the native branch, including
pre-compaction messages, not only the current model context. Opening a room reads the newest
32 native visible records through the indexed source, never the entire history or captured context.
`paging` supplies the exact source revision, total, start/end indexes (end exclusive), `hasOlder`
and `nextBefore`. Older page replaces the displayed window; Latest page restores the tail. A selected
older page stays visible when new work arrives, but further paging requires returning to the latest
revision. Revision conflicts return 409 instead of stitching different branches. Chat, thinking,
tool results and notices retain native identities; input receipts are transparent work, while
materialized user records are chat, including when those records fall on separate pages.
The inspector identifies the selected page's scope and source revision; it does not serialize a
full captured context.

Closing a room is a per-person inbox choice, not a stop, archive, membership removal or change of
custody. The directory retains both open and closed rooms so the picker can reopen them. `current`
defaults to true for pre-existing rows. The directory's `room_inbox` table persists each person's
visibility and read marker, independently of the shared room runtime. Closing does not mark read;
opening does not mark read; reading does not change visibility or answer pending questions.

`unreadCount` counts idempotent inbox events since that person's read marker: invitations/member
additions, other members' accepted messages/answers, new questions and finished Kenan replies. It
is independent of push delivery success. A newly recorded event reopens the room for its recipients;
retries and repeated ticks of the same reply/question do not. Sending or answering also restores the
sender's room. `updatedAt` is an epoch-millisecond activity timestamp, not a poll, read or close time.
The fields `current`, `updatedAt`, `state`, `unreadCount`, `readThrough` and `pendingQuestions` are optional in the
shared type for existing fixtures and older snapshots; directory responses always supply them.

## A person's own Kenan

The installed `pi-room` CLI lets a person's own threads list/read their rooms and post as that person's Kenan:

```
pi-room list
pi-room read ROOM_ID --last 5
pi-room read ROOM_ID --last 0 --work  # all chat and transparent work in this <=32-record page
pi-room read ROOM_ID --before INDEX --revision REVISION --limit 32 --work
pi-room send ROOM_ID 'Message' --request-id UUID
pi-room create 'Own test room'      # only the caller, never invites anyone else
```

Owner: `server/agent-rooms.ts` and `server/room-cli.ts`. The local router accepts
`GET /v1/agent-rooms`, `GET /v1/agent-rooms/:id`, `POST /v1/agent-rooms/:id/prompt`
and own-only `POST /v1/agent-rooms`. It resolves the client socket's Unix UID from
`/proc/net/tcp{,6}` and maps it to registered Unix people. Headers, query hints,
environment names and browser/thread tokens do not choose the person. Root,
`pi-kenan`, `pi-rooms`, unregistered UIDs and non-loopback callers are not admitted.
Missing UID evidence fails closed. This does not grant root a person-impersonation route.

These requests reuse the same directory, membership checks and trusted room-owner
transport as member clients; the internal listener and filesystem permissions are unchanged.
Responses include the authenticated `person`. Nonmembers cannot enumerate, read or post.
Reads expose one bounded page plus `paging`; use its `nextBefore` and `revision` to request earlier
records. `--last` selects chat messages within that page, not the entire source; output reports
`historyScope: "page"`, `pageMessages` and `shownMessages`. `--last 0` means every chat message in
the page, not an unbounded download. `--work` includes that page's thinking, tools and notices.
Agent-created rooms are own-only; inviting other people stays with the human UI.
Other room controls and remote-environment proxy paths are not agent endpoints.
`PI_ROOM_URL` selects only a loopback HTTP router origin (default port 8788).

Posts are stamped from the current server roster as `{user: PERSON, displayName:
"NAME's Kenan", agent: true}`. Human prompt payloads cannot select this attribution.
The native room history and member clients retain this sender. A requestId durably
binds actor, sender kind and text; conflicting reuse returns 409, and accepted replay
returns `replayed:true` without dispatching a second input, even across router restart.
A lost acknowledgement is uncertain: inspect and retry only with the same requestId.
Acceptance means queued input, not a completed room turn. Reads do not acknowledge
unread events, reopen a closed room or alter membership.

`pi-room send` journals intent before dispatch and records confirmed/failed/uncertain
acceptance through the person's own [action journal](../../../docs/action-journal.md),
using server-reported membership, not `USER`. Intent-custody failure prevents dispatch;
outcome-journal failure reports a warning without asking for a resend. Raw HTTP sends
bypassing the CLI require the normal manual action record.

## API

The member-client public routes require this host's authenticated router session:

- `GET /v1/rooms` → `{ rooms, people }`, filtered by membership, including closed rooms; people is
  the host roster. Each room includes `{ id, title, members, current, updatedAt, state, unreadCount,
  pendingQuestions, readThrough }`; `state` is `idle` or `running` and counts are nonnegative integers.
- `GET /v1/rooms/changes?cursor=REVISION` → single-line JSON SSE frames
  `{ cursor, directory, rooms: { [memberRoomId]: snapshotRevision } }`. Revisions describe current
  state, not an append-only log; a reconnect hydrates any changed resource without replaying
  intermediate states. The router aborts the feed when its authenticated session is revoked.
- Directory and snapshot GETs accept `?sync=1&have=REVISION` for the shared reconcile frame
  (`full` or `patch`), or HTTP 304 when unchanged. Authorization precedes reconciliation; publisher
  history is partitioned by actor and bounded to 64 MiB/128 entries, with two historical bases per
  resource and a 32 MiB value ceiling. A missed/evicted base rehydrates in full. The selected client
  body owner holds at most one 32 MiB resource. Plain GETs retain the ordinary CLI/agent response.
- `POST /v1/rooms` with `{ requestId: UUID, title, members: [user] }` → `{ room }`. Creator is
  included automatically; the receipt is the stable room/thread ID, including on retries.
- `GET /v1/rooms/:id?before=INDEX&limit=N&revision=REVISION` →
  `{ room, state, held, error?, messages, paging, live, questions, work, thinking, notificationId }`.
  Without `before`, reads the latest page. `limit` is 1..32 (initial size 32); `before` is an exclusive
  nonnegative native-record index, and `revision` fences the native source. `paging` is
  `{ revision, total, start, end, hasOlder, nextBefore }`. Old pages do not change notification
  reconciliation or the room's latest snapshot revision. Both member and agent routes forward the
  page query unchanged after validation.
- `POST /v1/rooms/:id/members` with `{ members: [user] }` adds people only while idle.
- `POST /v1/rooms/:id/prompt` with `{ requestId: UUID, text }` queues an authenticated utterance.
- `POST /v1/rooms/:id/questions/:questionId/answer` with the standard
  `{ selectedSuggestionIds, text, dismissed? }` accepts an authenticated public answer.
- `POST /v1/rooms/:id/abort` with `{}` stops the room turn.
- `POST /v1/rooms/:id/close` with `{}` → `{ room }`, sets only the caller's `current` to false.
- `POST /v1/rooms/:id/open` with `{}` → `{ room }`, restores only the caller's `current` to true.
- `POST /v1/rooms/:id/read` with `{ through: readThrough }` → `{ room }`, acknowledges only the
  inbox cursor displayed to the caller. A later recorded event remains unread. `{}` explicitly
  acknowledges all events recorded at processing time; invalid/ahead cursors return 400. These three operations do not call the
  room runtime, and are available even while it is offline. Reading a snapshot with GET alone does
  not mark it read.

Nonmembership and missing rooms both return 404 at the router. Unknown people or malformed inputs
return 400. Adding while running or a conflicting creation receipt returns 409. Rooms currently
render text and page-scoped work with explicit earlier-history navigation; attachment/inline-file/image delivery and member removal remain
outside this slice. Root may still act on files and describe the result.

Focused checks run without live services, registries, keys or mounts:

```
bun test apps/remote/server/rooms.test.ts apps/remote/server/agent-rooms.test.ts apps/remote/web/room-sync.test.ts apps/remote/server/message-context.test.ts apps/remote/server/notifications.test.ts
npm test --workspace=pi-orchestrator -- tests/room-session.test.ts
```
