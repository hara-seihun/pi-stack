# Messaging profiles

PiStack shows AI and human conversations together in Current Chats. They share chat selection, the plus picker, composer, attachment, pasted-document and drawing controls. Human messages use typed backend plugins and never enter a Pi session. Sending a Signal message does not start an agent or consume a model account.

## Current Chats

The current list belongs to the account and is shared across devices. The inbox ranks it by attention and recency. The selected conversation is local to each device. Closing a human chat with X removes it from Current Chats but keeps its history and connection. A fresh incoming message reopens it without stealing focus. Outgoing messages synchronized from another Signal device and replayed receive receipts do not reopen a closed chat. Explicitly choosing the conversation in the plus picker also reopens it, even if the backend is offline and only stored history is available.

Closing an AI chat stops its main agent and every descendant before removing it from the list. AI completion does not reopen it; use the picker to reopen previous chats. The existing one-hour automatic cleanup applies to AI threads, but unread idle threads are protected until read. Signal chats do not inherit an AI execution timer.

Contact/group discovery populates the picker, not Current Chats. When an existing messaging store first adopts this behavior, conversations with stored messages become current; entries with no messages remain directory choices. Later restarts preserve explicit closures. The messaging store owns each conversation's current flag and a persistent snapshot version. Backend, history, unread and current-state changes wake the supervisor's existing sync stream. Clients no longer poll a separate Messages tab.

The picker's recent order uses each conversation's latest stored message timestamp. Discovery, renaming, opening, closing and marking read do not change that timestamp; a contact with no messages has `updatedAt: 0`. Accepted local sends count immediately, including failed or uncertain sends. Confirmation replaces the provisional message timestamp with the backend's timestamp and recomputes recency. Incoming and linked-device messages cannot displace newer message activity with an older timestamp. On startup, the service rebuilds conversation timestamps from message history, repairing entries previously ranked by discovery time without changing unread or current flags.

## Account ownership and encryption

A messaging profile belongs to one PiStack person on one host. Each profile can link one messaging account. A person can have several profiles, including several Signal accounts, by assigning distinct profile IDs. Nothing is shared with another person or automatically copied to another host.

Messaging runs only for encrypted PiStack accounts. The supervisor requires `PI_REMOTE_REQUIRES_UNLOCK=true` and verifies that `PI_REMOTE_DATA/messaging` is inside `PI_REMOTE_PRIVATE_DIR`. An unencrypted account gets an explanatory setup state and no messaging database. The router's existing person session authorizes every messaging request. Client-supplied profile IDs never select another person's storage or supervisor.

The encrypted folder contains:

- `messaging/profiles.json`: profile labels, plugin selection and configuration;
- `messaging/messages.sqlite3`, including its SQLite WAL: conversations, current flags, messages, sender names and address aliases, send receipts, attachment ownership, unread markers and snapshot version;
- `messaging/attachments`: uploaded and received files;
- `messaging/backends/PROFILE_ID`: that profile's backend identity, sessions and temporary files.

These paths are relative to `PI_REMOTE_DATA`. The existing gocryptfs folder provides encryption at rest. There is no separate messaging password, shared daemon identity or machine-global Signal credential. Locking the person stops the supervisor and its Signal children, then destroys the decrypted mount. Unlocking restarts the profiles.

The browser keeps human-message drafts, drawings and attachment selections in memory only, and clears them when the person locks or changes. Messaging responses and downloads use `Cache-Control: no-store`; the messaging client does not write transcripts or credentials to IndexedDB or localStorage. Signal sessions remain on the host. Downloading a file deliberately creates a device-local copy outside PiStack's encrypted host storage. The phone still holds its PiStack unlock credential according to the existing person-session policy.

Back up the encrypted folder with the person's normal backup procedure. Preserve the folder key through its existing credential owner, not inside the folder it unlocks. Removing a profile from configuration stops its connection after a supervisor handoff, but does not erase its history. Unlink its device in Signal before deleting its encrypted profile directory if the identity is being retired.

## Configure profiles

On first opening an encrypted account, PiStack creates a private `messaging/profiles.json` with an unconfigured Signal profile. Edit this file from that person's unlocked mount namespace:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "signal-personal",
      "plugin": "signal",
      "label": "Personal Signal",
      "options": {}
    }
  ]
}
```

Profile IDs are stable local identifiers. Changing one selects a different identity directory. Profile options stay in this encrypted file, not in the root-owned person registry or the browser. An empty profiles array disables all backends. Invalid configuration produces an actionable setup error rather than starting a partially configured connection.

Apply changes through the normal supervisor handoff, not by killing the account's unit. For an administrator on a systemd host:

```sh
sudo systemctl kill --kill-whom=main --signal=HUP pi-remote@ACCOUNT.service
```

The host's supervisor wrapper owns the replacement. Accepted agent turns keep their shared runners. The messaging plugin closes its owned connection and the replacement reads the saved profiles.

## Signal

The built-in adapter uses the maintained [signal-cli](https://github.com/AsamK/signal-cli) project. Install a current host package. NixOS should declare `pkgs.signal-cli` in `environment.systemPackages`; its wrapper supplies Java and the matching native libsignal library. Do not put an unpacked foreign Linux binary in a user's temporary directory. Signal can stop accepting clients more than a few months out of date, so the package belongs to normal host maintenance.

Options are:

| Option | Meaning |
| --- | --- |
| `account` | Optional international phone number. Omit it when the profile has exactly one linked account. |
| `binary` | Optional signal-cli executable. Defaults to `signal-cli` on the supervisor's PATH. |
| `timeoutMs` | RPC deadline, default 30,000 milliseconds. |
| `callTunnelBinary` | Optional `signal-call-tunnel` executable for voice calls. Defaults to `signal-call-tunnel` on the supervisor's PATH. |
| `probeMs` | How often the adapter checks the running child, default 60,000 milliseconds. |
| `silenceMs` | Receive silence that triggers a rebuilt subscription, default 900,000 milliseconds. |

The adapter fixes state at `messaging/backends/PROFILE_ID/signal-cli`. External data directories and shared daemon sockets are rejected. Child working directory, Java temporary files, XDG configuration and caches stay inside this encrypted profile.

### Link your Signal account

Linking happens in the app, with the phone that already holds the account. Unlock your PiStack account, open the plus picker and choose Signal. While the profile has no account, the picker offers the link action and a device name, which defaults to PiStack and accepts up to 64 ordinary characters. Start the link and PiStack shows a QR code with the `sgnl://linkdevice` URI under it.

On the phone, open Signal, then Settings, Linked devices, Link new device, and scan the code. From the phone itself you can open the `sgnl://` link instead; it hands Signal the same code. The picker reports waiting, linked, failed or cancelled. On success PiStack closes the unlinked connection and restarts the profile against the new account, so the contact and group directory appears without a supervisor handoff.

There is no Signal API key, SMS code or registration PIN to give PiStack. Each code serves one attempt and expires; after a failure or a timeout, start the link again for a fresh one. Cancelling while it waits drops the attempt and its code. A profile that is already linked refuses to link a second account. Remove that device from Signal's linked devices and delete the profile's encrypted directory before reusing the profile ID. A profile that is shutting down also refuses, and closing a profile cancels a link that is still waiting.

Signal's [linked-device documentation](https://support.signal.org/hc/en-us/articles/360007320551-Linked-Devices) owns current limits. At implementation time it allows five linked devices, requires the primary phone to connect within 30 days, and unlinks a linked device after 45 days of inactivity. If all five slots are taken, unlink one from the phone before starting. Linking imports no past conversations; PiStack stores what arrives afterwards.

The adapter drives signal-cli's `startLink` and `finishLink` JSON-RPC methods. `startLink` returns as soon as the device-link URI exists, and the wait for the phone runs in the background under a ten-minute deadline. An unlinked profile keeps no running signal-cli child, so linking spawns its own child against the same encrypted profile directory. Link state reaches the browser through the existing messaging snapshot and sync stream. No account is linked automatically by deployment.

[`server/messaging/qr.ts`](../server/messaging/qr.ts) renders the code as inline SVG with the host's `qrencode`, passing the URI over the child's stdin so it never appears in process arguments. A host without `qrencode` shows the URI alone, which still works from the phone.

### Linking from a shell

Use this only when the app path cannot run, such as a picker you cannot reach or a profile you are repairing from a shell with no browser session. It links the same profile directory the app uses, so do not run it against a profile that already has a running connection. In the same person's decrypted namespace:

```sh
profile="$PI_REMOTE_DATA/messaging/backends/signal-personal/signal-cli"
mkdir -p "$profile"/{tmp,config,cache}
chmod 700 "$profile" "$profile"/{tmp,config,cache}
TMPDIR="$profile/tmp" XDG_CONFIG_HOME="$profile/config" XDG_CACHE_HOME="$profile/cache" \
  JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$profile/tmp" \
  signal-cli --data-dir "$profile" link -n PiStack
```

Keep that foreground operation alive while displaying its short-lived device-link URI as a QR code on another screen, then scan it from the phone as above. The profile directory and any temporary URI or QR file must stay in the encrypted account folder. Remove the temporary linking artifact after completion, then hand off the supervisor to start the linked profile. Reprovisioning an already active identity needs its connection stopped first.

### Supported messaging

The first adapter supports text, files, existing contacts and existing groups. New direct conversations accept an international phone number, Signal UUID or `u:username.000`. A successful send means signal-cli accepted the send; it is not a recipient read receipt.

Group authors use Signal's known nickname, contact name or profile name, in that order. The adapter loads these names at startup and contact synchronization, and applies `sourceName` updates from receive events. Hidden contacts can still supply names for group authors without appearing in the direct-chat picker. Names and verified UUID, phone-number and username aliases stay within the profile's backend and the person's encrypted store.

Message `sender` and external IDs remain stable identities. History adds `senderName` from the current directory, so existing UUID-only messages gain names after directory discovery without rewriting messages, changing unread state or reopening chats. Name changes also apply to earlier messages. An explicit nameless contact record clears its stored display name; a receive event with no name leaves the known name alone. Unknown authors keep their address instead of receiving a guessed name. The directory survives offline periods and supervisor restarts.

Contact and group pictures come from the files signal-cli has already fetched into its `avatars/` directory (`profile-<uuid>`, `profile-<number>` or `group-<id>`, without extensions). The adapter records the picture's path and modification time with the sender or conversation at discovery, contact synchronization and receive events; a contact whose photo lands after discovery shows it the next time they write. The service serves them at `GET /v1/messaging/backends/:backendId/avatars/:id`, where `id` is a conversation's `externalId` or a message's `sender`, resolving sender aliases and reading the image type from the file's first bytes; only JPEG, PNG, GIF and WebP are served. Conversations carry `avatar` and messages `senderAvatar`, the picture's version, or null/absent when there is none; a client puts the version in the URL query so a changed photo is fetched again. The inbox, the conversation header and each sender's block show the picture, falling back to the Signal glyph.

### Voice calls

A direct Signal chat has a call button. The person calls, the contact's phone rings, and they talk
using the browser's microphone and speakers. An incoming call appears wherever the person is in
Remote, with Accept and Decline. This is the person's phone call, not an agent capability: no tool
places a call, no agent joins one, and nothing dials automatically. Signal's terms prohibit
auto-dialling, and PiStack has no code path that would.

One call at a time, direct conversations only. Group calls, video and call links are not
implemented. A call is live state rather than history; PiStack stores no call log, and the snapshot
keeps an ended call for four seconds so the browser can say why it ended.

signal-cli owns the Signal side of a call and delegates media to a separate process,
`signal-call-tunnel`, which embeds RingRTC. The host supplies this binary on `PATH`; its package and build instructions belong to the host configuration. The adapter resolves it once when it starts,
without spawning anything. When it is missing the backend reports `calls: false` and the chat shows
its call button disabled, saying calling is unavailable, rather than offering a button that fails
when pressed.

Audio never touches a host sound server. The adapter starts signal-cli with
`SIGNAL_CALL_TUNNEL_AUDIO_MODE=pipe` and a socket directory inside the profile's encrypted scratch
space, so each call gets one bidirectional Unix socket carrying 48 kHz mono 16-bit PCM. The service
reads the remote party from that socket and writes the microphone into it. Nothing is recorded, and
no call audio reaches a transcription service or a model.

The browser exchanges the same PCM over a WebSocket at
`/v1/messaging/calls/:callId/audio`, in 20 ms frames of 1920 bytes. Mute is server state, so
muting survives a page reload and a dropped socket. A closed audio socket mutes a call rather than
ending it, and a reloaded page reclaims the audio by opening a new socket, which displaces the old
one. Ending a call for any reason closes the socket and releases the tunnel; so does a backend
error, a supervisor handoff or locking the person.

signal-cli ignores incoming call offers entirely unless a client has subscribed to call events, so
the adapter subscribes as soon as an account is linked and re-subscribes whenever it rebuilds a
connection after silence. Call ids are unsigned 64-bit and routinely exceed what a JavaScript
number holds exactly, so PiStack treats them as opaque strings from the JSON-RPC line onward.

A linked device has full authority to place Signal calls; Signal Desktop is one. Calls ring the
contact's phone as they would from any Signal client.

PiStack stores messages received after linking. signal-cli does not provide an old-chat-history API or restore Android backups. Contact and group synchronization does not import past messages. Reactions, message edits, deletion, group administration and remote read receipts are not implemented. Disappearing and view-once messages are omitted with a visible backend status instead of being retained forever.

The child uses newline-delimited JSON-RPC with manual receive and an explicit subscription. There is no Signal notification acknowledgement or replay cursor for PiStack to commit with its database, so an interruption between Signal receipt and PiStack persistence can lose that event. The adapter surfaces receive/persistence failures and stops the connection rather than quietly discarding errors. Reconnecting does not resubmit messages that Signal already delivered to this device.

### Connection health

A profile that stops receiving looks exactly like a profile nobody messaged, so the adapter does not wait to be told. Every `probeMs` it asks the running child to list its accounts; a child that does not answer within the RPC deadline, capped at ten seconds, becomes `error`. After `silenceMs` with no receive event of any kind it drops the subscription and takes a new one, because signal-cli reports neither a websocket that stopped delivering nor a subscription that went stale.

The service owns recovery. A backend in `error` reconnects on its own, starting five seconds later and backing off to five minutes, for as long as the supervisor runs. A profile with no linked account rechecks every thirty minutes, which also picks up an account linked from a shell without waiting for a handoff. A backend that reaches `ready` clears its backoff.

All of it is written to the supervisor's log as `[messaging PROFILE_ID]`: every status change with its detail, each reconnect delay, the child's pid and exit, the live subscription id, and each line signal-cli writes to stderr. `--scrub-log jsonRpc` keeps message content out of that stream. On a systemd host:

```sh
journalctl -u pi-remote@ACCOUNT.service -f | grep messaging
```

Before this existed, a Signal profile on this host failed to start after a supervisor handoff on 18 September 2026 and received nothing for two days. The status lived only in the messaging snapshot, nothing retried it, and no log recorded it. Messages queued for a linked device are held by Signal and delivered when it reconnects, but relinking the device discards that queue, so a silent outage plus a repair by relinking loses whatever accumulated.

Every outgoing UI request has a durable request ID. Repeating the same ID and payload returns the original receipt without a second send. A network timeout, interrupted process, ambiguous backend response or partial group delivery yields `unknown`, never an automatic retry. When Signal returns per-recipient results, uncertain delivery errors include counts by result type, such as `SUCCESS` and `NETWORK_FAILURE`, without adding recipient identifiers. Check the recipient before deciding to send again. A confirmed rejection is `failed`; the UI can explicitly retry it with a new request ID while preserving its attachment history. A changed payload with an existing ID is rejected.

## Plugin interface

[`server/messaging/plugin.ts`](../server/messaging/plugin.ts) defines `MessagingPlugin`, its factory, backend conversations, attachments and incoming messages. [`server/messaging/protocol.ts`](../server/messaging/protocol.ts) is the shared browser/server wire contract. [`server/api.ts`](../server/api.ts) owns all `/v1/messaging` routes.

A plugin exports `createMessagingPlugin(config)` and defines its `icon`, a static asset name served by PiStack. The Signal plugin uses `signal`, supplied by `web/public/signal.svg`. The supervisor passes a private profile directory and callbacks to persist conversation, sender and message events and report readiness. Plugins implement `start`, `openConversation`, `send` and `close`, declare attachment/group capabilities, and return typed success or failure results. They own external protocol parsing and transport cleanup. PiStack owns the conversation database, request receipts, draft uploads and HTTP access.

A plugin that can link an account from the app sets `linkable` and implements `startLink(deviceName)` and `cancelLink()`. `startLink` returns once the code is ready to display; later progress goes to `context.link(value)` as a `MessagingLink` with status `waiting`, `linked`, `failed` or `cancelled`. `MessagingBackendInfo` carries `linkable` and the current or last `link` to clients. The service validates the device name, refuses linking for a ready or non-linkable backend, and on `linked` closes the plugin and launches a replacement so the new account connects. A plugin without these members is unlinkable and unchanged.

The client inserts the outgoing message into the normal transcript and clears its composer before the send request finishes. Its text, attachments and layout match a sent message; only the small delivery footer says `sending`. The next draft stays editable and sendable. No pending banner or extra controls appear.

`POST …/messages` answers 202 with the message as `sending` as soon as the receipt is durable, or 200 with the stored receipt for a repeated `requestId`. HTTP and history receipts update the same message by request ID. The client learns `sent`, `failed` or `unknown` from the next snapshot version. A transport failure without a receipt or a supervisor that stops mid-send records `unknown`, the only state that offers "Check send status". That action reuses the exact request ID and payload. A confirmed failure offers "Use failed draft" on the message, leaving any newer draft untouched.

`send` returns a stable external ID and timestamp, or a failure. Use error code `unknown` whenever dispatch may have reached the remote service. Use a definite failure only when the backend confirms rejection. Incoming IDs must be stable across replay; an own sent-message synchronization event must use the same ID as the send result. Await `context.message` before releasing attachment files. It copies them into PiStack's encrypted store.

`BackendMessage.sender` is the stable author address, not a display name. Call `context.sender` with a canonical ID, known address aliases and the current display name, or `null` when a directory record explicitly has no name. The service scopes these records to the plugin's backend and resolves optional `MessagingMessage.senderName` when returning history. Sender directory changes advance the messaging snapshot version so clients refresh displayed authors. `BackendSender.avatar` and `BackendConversation.avatar` name a picture file inside `dataDir` with its modification time: `null` removes a picture the service knew, absent leaves it alone. Picture changes advance the snapshot version like names do.

For an external trusted plugin, set `plugin` to its absolute module path. It must export the same factory. A plugin is executable code running as its owning person, not an untrusted sandbox. It must keep account credentials and backend-owned state inside the supplied `dataDir`. Built-in plugins are ordinary modules under `server/messaging`.

The supervisor sends the versioned messaging snapshot as its own `messaging` event on each client's stream whenever that version moves, carrying the conversations that are recent, unread or open; the endpoints below return the complete directory. The authenticated messaging API lists profiles and conversations, opens or closes current chats, pages message history, marks local unread state, uploads draft attachments, sends with request receipts, and serves owned attachment IDs. `POST /v1/messaging/backends/:backendId/link` starts a device link with an optional `{deviceName}` body, and `DELETE /v1/messaging/backends/:backendId/link` abandons one that is waiting; both answer with the current link state, which also travels in the messaging snapshot, so clients do not poll. Messaging attachments cannot be borrowed from agent threads, other conversations or another person's account. Inline previews admit raster image formats; other files download as attachments rather than execute as app-origin HTML or SVG.

## Operations and source references

A backend's setup or connection error appears in the chat picker without breaking agent threads. Read `profiles.json` and the backend status first. Never diagnose by copying Signal credentials out of the encrypted profile. No raw protocol logging is needed; the child uses scrubbed logs and reports bounded failures.

Focused checks run in seconds:

```sh
bun test apps/remote/server/messaging/*.test.ts apps/remote/web/messaging*.test.ts
```

These use fake child processes and isolated temporary stores. They do not contact Signal or send messages. A live acceptance check must wait until the owner links a profile and names an authorized test recipient.

Protocol sources:

- [JSON-RPC transport and methods](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)
- [signal-cli commands](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc)
- [History and backup limitations](https://github.com/AsamK/signal-cli/issues/1747)
- [NixOS package owner](https://github.com/NixOS/nixpkgs/blob/master/pkgs/by-name/si/signal-cli/package.nix)
