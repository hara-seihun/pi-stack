# Signal agent tool

`pi-signal` is the account-scoped Signal transport for Kenan. Pi Stack's human conversation product consists of AI chats and shared [rooms](../../../docs/one-kenan.md); Signal operations are local agent tools, not inbox entries, browser subscriptions or call audio. The maintained [signal-cli](https://github.com/AsamK/signal-cli) child owns the external protocol. The encrypted transport owner supplies durable history, attachments, quotes, reactions and outbound receipts.

## Contract

Run `pi-signal --help`. Commands list configured profiles and their directory, resolve a recipient, page history, stage/download attachments, send/reply, react, and provision an explicitly authorized linked device. There is no person selector or imported browser credential.

```sh
pi-signal list
pi-signal open signal-personal +15551234567
pi-signal read CONVERSATION --limit 20
pi-signal send CONVERSATION 'Authorized message' --request-id CHOSEN_ID
pi-signal react MESSAGE_ID '👍' --request-id OTHER_CHOSEN_ID
```

CLI requests use `GET/POST /v1/agent-signal`, with exact operations declared in [`server/api.ts`](../server/api.ts). A local shell reaches the loopback router, which selects the own-person supervisor from the socket's kernel UID. Pi sessions use their own `PI_REMOTE_SERVER_URL` and verified `PI_THREAD_TOKEN`. The supervisor enforces its local caller contract. Browser sessions and remote-environment proxying cannot access this tool namespace. Own-person encrypted storage and the owner's actual instruction/consent grants still govern reading and outgoing communication; transport access is not permission to mine somebody else's side of a conversation.

`send` and `react` require a stable request ID **before** dispatch. It binds the exact payload and recipient. Duplicate IDs return the stored result without another external effect; a changed payload conflicts. Sends answer with a durable `sending` receipt (HTTP 202), not delivery. Read history for `sent`, `failed` or `unknown`. Interrupted sends and reactions become uncertain on restart and are never automatically replayed. Backend/network timeouts, partial group delivery and ambiguous responses mean `unknown`, not rejection. Inspect the existing outcome before an explicit retry with a new ID.

Outgoing attempts are durably journaled inside the encrypted account before dispatch. Completion records confirmed, failed or uncertain outcomes. Journal replay publishes records to memory, never resends an external action. Journal write failure before dispatch prevents sending; a completion-journal failure leaves the durable attempt and reports that failure. Backend acceptance is not a recipient read receipt.

Replies use `--reply-to messaging/LOCAL_MESSAGE_ID` for a confirmed message in the same conversation. Native Signal quote author/timestamp/text are retained. Reactions identify their original author/timestamp, including in groups; replayed or older incoming events cannot overwrite newer reaction state. Sender names and aliases resolve within the profile only. Unknown authors remain addresses rather than guessed names.

## Identity and retained state

Signal profiles only run for encrypted accounts. `messagingRoot` verifies that `PI_REMOTE_DATA/messaging` and its existing children resolve inside `PI_REMOTE_PRIVATE_DIR`; paths escaping the encrypted folder are errors. No shared daemon socket or external identity directory is accepted. One profile links one Signal identity, owned by one Pi Stack person on one host.

The retained encrypted store is:

- `messaging/profiles.json`: versioned profile configuration;
- `messaging/messages.sqlite3`, WAL and SHM: messages, sender aliases, durable send/reaction receipts and history revisions;
- `messaging/attachments`: owned staged and received files;
- `messaging/backends/PROFILE_ID/signal-cli`: linked identity and native attachment/session state;
- `messaging/action-journal`: durable outbound action journal.

Product retirement does not delete stored messages, old presentation columns, preview files, avatars, linked-device keys or permissions. Normal account backups continue to own these bytes. Removing a configured profile stops its connection after a supervisor handoff without deleting its history. Locking an account stops its supervisor and children before destroying the decrypted mount. Never copy profile credentials out to repair a connection.

A new account has no configured Signal profile. Provisioning is explicit. From that person's unlocked namespace, write:

```json
{"version":1,"profiles":[{"id":"signal-personal","plugin":"signal","label":"Personal Signal","options":{}}]}
```

An empty profiles array disables the transport. IDs select stable own-person backend directories. Invalid configuration is an error. Apply configuration through the normal supervisor handoff. `pi-signal link signal-personal Kenan` returns a short-lived `sgnl://linkdevice` URI. The owner authorizes it on their existing Signal primary device. No identity is linked automatically by deployment, and provisioning does not import old history. Do not relink an existing identity to repair silence: Signal may still hold queued messages for the linked device.

## Host operations

Install a current host-managed Signal CLI distribution with its matched native library and JRE on the supervisor PATH. The official Java package belongs under `/opt` or the host's package owner, not a temporary directory. `binary`, `account`, `timeoutMs`, `probeMs` and `silenceMs` remain profile options. State, Java temporary files and XDG configuration/cache stay within the encrypted profile. Signal attachment bytes stream from files; they are never base64-expanded into JSON-RPC frames.

The adapter uses manual receive, an explicit subscription and scrubbed logs. Every health probe asks the child to list accounts; receive silence rebuilds the subscription. Failed connections back off from five seconds to five minutes, and unlinked profiles recheck every thirty minutes. The transport never retries an uncertain send. A persistence failure stops the connection rather than silently losing an event. signal-cli has no acknowledgement cursor transactional with SQLite; a process interruption between external receipt and persistence can lose an incoming event.

```sh
journalctl -u pi-remote@ACCOUNT.service -f
bun test apps/remote/server/agent-signal.test.ts apps/remote/server/signal-cli.test.ts apps/remote/server/messaging/*.test.ts
```

Tests use fake child processes and isolated temporary stores; no live Signal message is sent. Publication installs `pi-signal` alongside the other account commands through [`deploy/tools`](../../../deploy/tools), with executable custody in [`deploy/remote-resources.mjs`](../../../deploy/remote-resources.mjs). Host activation must preserve signal-cli and encrypted profiles. Any host-installed Signal call-media tunnel package/service is not needed by this source; its host owner can remove it after the replacement supervisors close their children, without touching identity or message data.
