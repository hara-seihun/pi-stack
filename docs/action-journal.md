# Kenan action journal

Owner: `packages/kenan-memory/src/journal.ts`. This is part of the [one-Kenan build](one-kenan.md). It records actions at their sending boundary, never by asking the model to remember them. All capture is gated by host JSON `oneKenan: true`; absent/false leaves the existing send behavior intact.

## Captured boundaries

- `MessagingService.dispatch`: Signal and every Remote messaging backend, text/attachment sends, reactions, and outgoing call initiation, with confirmed/failed/uncertain outcomes. Existing receipt replay never sends or journals twice.
- `PhoneBroker.execute`: `sms.send`, `call.dial`, `calendar.insert`, and `notifications.reply`. A successful Android response means command acceptance, **not** carrier delivery or a connected call.
- `CalendarStore.handle`: owned event create/update/delete, occurrence changes/deletions, and undo restoration, after the SQLite mutation commits. Subscription refreshes and settings are not outward event writes.
- Telephone service: physical SIM and Vonage dial dispatch after Voice preparation. A provider accepting the dial is not evidence somebody answered. Only the approved call purpose is summarized, not recordings/private history.
- PiStack publication owner: durable intent before deployment begins, confirmed item after all configured host release proofs and the publication receipt. Interrupted/partial releases retain an attempt, not a fabricated complete publication.
- `tools/mail-send/main`: SMTP acceptance including partial refused-recipient information; rejected SMTP requests are failed, lost SMTP confirmation is uncertain. Attachments are not copied to shared memory.

Outward actions bypassing these owners (a browser sending through webmail, raw `signal-cli`, direct SMTP scripts, unrelated publication tools) cannot be intercepted by this journal. Call acceptance/hangup, calendar feed/subscription administration and arbitrary shell/browser sends are not captured as outbound-send events. This is not a shell-command parser claiming to capture arbitrary side effects.

## State and delivery

Every attempt is fsync-written before dispatch. Ordinary-UID processes use their existing private mount's `.kenan-actions` (from `PI_REMOTE_PRIVATE_DIR` or `PI_REMOTE_CONFIG.unlock.mountpoint`), even when an inherited environment points at a root-only shared spool. Root services use `PI_KENAN_ACTION_JOURNAL_DIR` (otherwise `/var/lib/pi-stack/kenan-actions`). Directories are 0700, receipts 0600. A failed intent write prevents sending. After dispatch the settled outcome gets its own fsync-written receipt. An outcome-write failure does **not** turn a successful send into a retryable failure: Remote exposes a journal warning, mail reports success plus “do not resend”, and publication records a warning on its successful receipt. The durable attempt remains as uncertainty.

Receipts contain `MemoryInput` from `packages/kenan-memory/src/contract.ts`: person acted for, thread/room setting where supplied, action/outcome, recipient/affected-person tags, event time and a whitespace-compacted 800-character summary. Private-category keywords and explicit `obviouslyPrivate`/`PI_KENAN_ACTION_PRIVATE=1` mark an item private. Keyword tagging is conservative assistance, not a comprehensive semantic privacy classifier; Kenan's discretion still governs disclosure.

An attempt item says expressly that it is not proof of sending. A confirmed item contains the outcome and the boundary's native receipt reference. Memory `source.externalId` is stable per attempt/outcome. S1's person/external-ID idempotency and forget tombstones make replay safe, including replay after forgetting.

Long-lived boundaries start a bounded background drain. The owning deployment must also run `bun /srv/pi/runtime/node_modules/kenan-memory/src/journal-cli.ts drain --all` as the household root-agent service on startup and a periodic timer, so reboot/outage receipts are not stranded. The machine-wide drain scans its own spool and `.kenan-actions` under known, currently mounted encrypted person folders from `PI_REMOTE_PERSONS_DIR`; it never creates a spool in an unmounted folder. This does not require Unix UID 0: filesystem access permits reading/deleting receipts, and the memory service's write-only publisher capability permits attributed writes. The service identity must already have access to the person spools through its owning custody configuration; scanning grants no new access. The drain transfers custody only after S1 returns `ok:true`, then deletes that receipt. Service/credential/filesystem failures leave receipts intact and the drain exits nonzero; the timer owner can surface failure without resending any outward action.

`PI_KENAN_MEMORY_PUBLISHER_TOKEN_FILE` (or systemd credential `kenan-memory-publisher`) supplies a write-only service credential. It is preferred for the machine-wide spool. With no readable publisher credential, person-side journals send without an authentication header and rely on S1's verified loopback socket UID mapping; inherited supervisor/session tokens are deliberately ignored because durable receipts can outlive their thread. The client cannot read or forget with this credential. No token is stored in a journal receipt or process argument. `PI_KENAN_MEMORY_URL` selects a staging service; `PI_STACK_HOST_CONFIG`/`PI_STACK_HOST_FILE` select the host gate.

## Mail custody and cutover

`pi-mail-send` is additive in the tools manifest; deployment does not replace existing `mail-send` links while the host flag is off. `deploy/one-kenan` cutover points the known `/home/kenan/tools/mail-send/main`, registered people/operator `~/.local/bin/mail-send`, and existing `~/tools/mail-send/main` routes at `/srv/pi/tools/mail-send/main` (`toolsRoot` overrides the public tool root). `mailSendRoutes` adds other absolute routes. Transaction state retains exact original bytes, modes/ownership and symlink targets for rollback, not a second unowned mail implementation. Prepare and ordinary source publication do not change these routes. Both mail and publication default to `/srv/pi/runtime/node_modules/kenan-memory/src/journal-cli.ts`; `PI_KENAN_ACTION_JOURNAL_CLI` overrides it for staging.

Focused checks:

```
bun test packages/kenan-memory/tests/journal.test.ts apps/remote/server/action-journal.test.ts apps/remote/server/messaging/service.test.ts deploy/action-journal.test.ts
python3 tools/mail-send/test_send.py
```

Staging email fixture (never sends mail or reads Pass): set the host gate, journal directory, memory URL/publisher credential, `PI_KENAN_PERSON=alice`, and `PI_KENAN_ACTION_JOURNAL_CLI` to the staged CLI. Run `python3 tools/mail-send/test_send.py --fixture`, drain the journal, then search “Gaétane” as Bob through his authenticated memory client. Only SMTP and credential retrieval are mocked; the real mail composition/sending boundary and journal are exercised.
