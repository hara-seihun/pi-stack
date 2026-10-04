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

The router reconciles replies and delivery every two seconds. Room listing reads refresh only that
person's visible rooms from their actual room execution owner. Scheduling/model/tool phases, held
state, errors and progress clocks travel with the owner snapshot to both the directory and open
conversation. Retrieval failure returns `status_error` with its cause and clears stale execution
clocks/tools, rather than presenting cached running state as healthy. The directory persists inbox,
unread, pending-question and last-message facts; execution phases and clocks remain with their
runtime owner and are refreshed after restart. The room inbox and conversation refresh while the
client is visible. These are narrow room requests, not another person's event stream. Member additions and sends serialize per room at the router. Turning the flag off preserves
the directory, outbox and native histories. Snapshot history comes from the native branch, including
pre-compaction messages, not only the current model context.

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
The fields `current`, `updatedAt`, `state`, `unreadCount` and `pendingQuestions` are optional in the
shared type for existing fixtures and older snapshots; directory responses always supply them.

## API

All public routes require this host's authenticated router session:

- `GET /v1/rooms` → `{ rooms, people }`, filtered by membership, including closed rooms; people is
  the host roster. Each room includes `{ id, title, members, current, updatedAt, state, unreadCount,
  pendingQuestions }`; `state` is `idle` or `running` and counts are nonnegative integers.
- `POST /v1/rooms` with `{ requestId: UUID, title, members: [user] }` → `{ room }`. Creator is
  included automatically; the receipt is the stable room/thread ID, including on retries.
- `GET /v1/rooms/:id` → `{ room, state, held, error?, messages, live, questions, work, thinking, context, notificationId }`.
- `POST /v1/rooms/:id/members` with `{ members: [user] }` adds people only while idle.
- `POST /v1/rooms/:id/prompt` with `{ requestId: UUID, text }` queues an authenticated utterance.
- `POST /v1/rooms/:id/questions/:questionId/answer` with the standard
  `{ selectedSuggestionIds, text, dismissed? }` accepts an authenticated public answer.
- `POST /v1/rooms/:id/abort` with `{}` stops the room turn.
- `POST /v1/rooms/:id/close` with `{}` → `{ room }`, sets only the caller's `current` to false.
- `POST /v1/rooms/:id/open` with `{}` → `{ room }`, restores only the caller's `current` to true.
- `POST /v1/rooms/:id/read` with `{}` → `{ room }`, acknowledges all inbox events currently recorded
  for the caller. A later recorded event remains unread. These three operations do not call the
  room runtime, and are available even while it is offline. Reading a snapshot with GET alone does
  not mark it read.

Nonmembership and missing rooms both return 404 at the router. Unknown people or malformed inputs
return 400. Adding while running or a conflicting creation receipt returns 409. Rooms currently
render text and full work/context; attachment/inline-file/image delivery and member removal remain
outside this slice. Root may still act on files and describe the result.

Focused checks run without live services, registries, keys or mounts:

```
bun test apps/remote/server/rooms.test.ts apps/remote/server/message-context.test.ts apps/remote/server/notifications.test.ts
npm test --workspace=pi-orchestrator -- tests/room-session.test.ts
```
