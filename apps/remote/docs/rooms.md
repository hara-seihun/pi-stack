# Rooms

Implementation status: this is the initial room transport. The October 3 root-Kenan revision
requires room execution to be unprivileged and room work transparent, with private requests going
through root. That execution/delegation change remains integration work; this slice makes no
privilege or mount changes.

Rooms are several people from this host plus Kenan in one conversation. They are enabled only when
`host.json` has `oneKenan: true`. With the flag absent, neither room stores nor room requests are
created, and the existing inbox and transports are unchanged.

The Rooms section in Chats is shared by the browser and Android web client. Any authenticated
person can create a room and add registered people. A member can send, read the conversation,
answer Kenan's questions, and stop his work. Adding someone shares the existing room conversation;
the picker says so. Adding waits until the current turn is idle, so the audience cannot expand
under an utterance already in progress. Removing members is not implemented.

## Custody and routing

A room is always a **fresh** root thread, never a private thread made shared. Its native JSONL,
Orchestrator state and context mirror currently live in the creating person's supervisor. No
Personal context-picker files are selected. The router's host-owned directory maps its stable ID
to that supervisor and member list. The public API never exposes this custody location.

This is deliberately an indirection. The integrator may migrate the thread, transcript and room
metadata into a Kenan-owned supervisor/store later without changing clients or the room ID.
Moving it is a custody migration, not copying conversations to every member. Until then the owner
supervisor must remain available; the integration's execution/custody choice must keep it available independently of the
creator's signed-in devices. This slice does not change unit lifecycles or mounts.

Every member reaches the router under their **own** authenticated session. The router checks
membership and creates a narrow, trusted request to `/v1/room-owner/:id` on the room's supervisor.
The header identifies the actual speaker, not the custodian. The owner verifies a local router
person caller and independently checks `thread.metadata.room.members`. Requests cannot choose
another owner's port or an arbitrary thread. Direct client access to the internal owner route,
including through remote and WebSocket proxy paths, is rejected.

The room API returns only human utterances, assistant text, pending public questions and live
assistant text. It never forwards another person's inbox, bootstrap, raw context, thinking,
tool calls/results, credentials or worker reports. Room traces remain confidential because they
can contain someone else's private memory; [trace privacy](../../../docs/one-kenan.md) owns the
broader protection of existing transcript/context routes in the initial design. The root-Kenan
revision replaces hiding room traces with keeping private reads out of room execution altogether. Rooms currently render text; attachment,
inline-file/image delivery and the ordinary thread inspector are not offered here.

## Turn context and identity

`metadata.room = { id, members: [{ user, displayName }] }` is the authoritative audience.
`threadInstructions` includes it on each turn, with the instruction to apply discretion to everyone
present at once. `PI_REMOTE_ROOM_ID` identifies the setting to the shared memory tools; it does not
replace the supervisor's custody identity or memory-session credential.

Incoming human text is wrapped by the owner in a `Room sender` label using the router-authenticated
person. Context capture recognizes that label only for room sessions, records the actual sender in
message identity, and supplies it to the model. A name in a person's body cannot change the outer
sender. Question answers use a persisted owner-side speaker receipt and the same preparation path.
Native transcripts retain this sender labeling across recovery and compaction. The public snapshot
reads the native branch, including its pre-compaction messages, rather than treating the current
model context as complete room history.

## Notifications and persistence

`PI_REMOTE_ROOMS_DB` overrides the default `/var/lib/pi-remote/one-kenan/rooms.sqlite3` for staging.
The directory also owns a durable per-member notification outbox. Invitations, accepted human
messages, questions and finished assistant replies become idempotent deliveries to each member's
existing supervisor notification ledger. An unavailable member supervisor leaves delivery pending
for retry. No new cursor scheme or Android native protocol is necessary. Notification targets are
`room:UUID`; the shared client opens them as room routes and suppresses alerts for the visible room.
The creator's ordinary native completion notifications are suppressed to avoid duplicate/wrong
private-thread targets. Turning the flag off preserves the directory, outbox and conversation data.

The router reconciles room replies and notification deliveries every two seconds. The room inbox
and open conversation refresh while the client is visible. These are narrow room requests, not a
forwarded owner event stream. Member additions and sends serialize per room at the router.

## API

All public routes require the current host's authenticated router session:

- `GET /v1/rooms` → `{ rooms, people }`, filtered by membership; people is the host roster.
- `POST /v1/rooms` with `{ requestId: UUID, title, members: [user] }` → `{ room }`. The creator
  is included automatically. The request ID is the stable room/thread ID, and retries preserve it.
- `GET /v1/rooms/:id` → `{ room, state, messages, live, questions, notificationId }`.
- `POST /v1/rooms/:id/members` with `{ members: [user] }` adds people, only while idle.
- `POST /v1/rooms/:id/prompt` with `{ requestId: UUID, text }` queues an authenticated utterance.
- `POST /v1/rooms/:id/questions/:questionId/answer` accepts the standard
  `{ selectedSuggestionIds, text, dismissed? }` question answer from an authenticated member.
- `POST /v1/rooms/:id/abort` with `{}` stops Kenan and his workers.

Missing rooms and nonmembership both return 404 at the router. Unknown people or malformed inputs
return 400; adding while running or a reused conflicting creation receipt returns 409.

Focused proof: `bun test apps/remote/server/rooms.test.ts apps/remote/server/message-context.test.ts
apps/remote/server/notifications.test.ts`. No live services, registry, keys or mounts are involved.
