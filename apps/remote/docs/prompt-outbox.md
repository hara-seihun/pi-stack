# Durable AI prompt submission

The [shared browser client](../web/README.md) saves AI prompt intent independently of push synchronization. [`PromptOutbox`](../web/src/prompt-outbox.ts) owns the IndexedDB `pi-remote-prompt-outbox` database, version 1, `prompts` store. Its scope is the authenticated person, verified environment ID and bootstrap URL including browser mount. The scope contains no session credential. Locking or switching owners hides saved prompts and aborts the old owner's transport; it does not erase their intent.

Each immutable record contains the original requestId, recipient, exact JSON request body, creation time and admission outcome. Attachment paths remain in the original body text; replyTo and queue/steer/hardSteer remain unchanged. `enqueue` completes a strict-durability write transaction before HTTP may start. An unavailable/corrupt store produces an explicit error, never a volatile substitute. A scope holds at most 64 entries and 2 MiB including conservative receipt space. A full store rejects new intent; it never evicts pending or failed prompts to make room.

`submit` loads and transmits only saved prompt records. A validated server receipt proves **accepted admission**, not execution or completion. An authoritative rejection is terminal and retained. Missing acknowledgements, malformed successes, authentication failures and unavailable owners remain **pending**, with the same requestId and body. A second submit of accepted/rejected intent does not send again. `acknowledge` removes a terminal receipt only after the client has reconciled its composer/attachment state; `discard` is an explicit user abandonment and does not cancel work already accepted by the server.

Construction and listing never replay work. The active foreground App keeps a memory-only ownership map for newly submitted pending prompts and retries them on confirmed feed/synchronization recovery while visible. Stop, close/archive, lock, owner change and reload end that automatic retry ownership. `interrupt(requestId)` fences an already-started retry waiting for storage and aborts an active HTTP request without claiming server cancellation. Recovered records and interrupted submissions require **Retry same request**; the original intent is not restored as a new-send draft. Stop, Resume, slash-command endpoints, room sends, external messaging and irreversible controls cannot enter this outbox.

[`PromptOutboxStatus`](../web/src/PromptOutboxStatus.tsx) shows pending/rejected records for the selected thread. Healthy first submission has no recovery card. Pending records retain exact-identity Retry and an explicit non-cancellation Dismiss explanation; terminal rejected records can be dismissed, not replayed into a fabricated success. Accepted records are omitted from recovery UI. Copy saved text preserves the entire original body, not the compact preview; clipboard failures stay visible. Full saved text can be expanded and selected when clipboard access is unavailable.

## Server admission receipts

[`PromptAdmissions`](../server/prompt-admissions.ts), called by `POST /v1/sessions/:id/prompt` in [`server.ts`](../server/server.ts), owns `supervisor.sqlite3.prompt_admissions`. It binds each requestId to its recipient and immutable parsed input. Before calling the thread directory, it persists the fully resolved quote envelope and meeting image bytes, so retry after reply compaction or a changed video frame cannot alter the admitted request. The thread owner's request ledger remains the exactly-once admission authority. Remote persists its accepted receipt afterward; a crash between those writes reuses the same resolved input and owner requestId.

Accepted/rejected receipts survive supervisor restart and are checked before current thread archive/availability guards. Definitive validation/identity failures return an explicit `outcome: rejected` 4xx. Transport, persistence and owner-unavailable failures return `outcome: pending` 503. Failure dispatch enumerates the thread owner's `ThreadError` codes plus Remote's `forbidden` code: `unavailable`, `no_pending_messages` and `cancellation_failed` leave admission unconfirmed and retryable, rather than persisting a rejection. An undescribed code reports a protocol defect and also leaves the request unconfirmed; it cannot silently inherit a known failure's behavior. Admission response contains `accepted: true`, `workId` and the original delivery mode only after owner admission. Receipt retention is durable rather than tied to browser acknowledgement; browser dismissal does not delete the server's idempotency record.

## Focused checks

Run from the repository root:

```
bun test apps/remote/web/prompt-outbox.test.ts apps/remote/web/prompt-outbox-status.test.tsx apps/remote/server/prompt-admissions.test.ts
```

The tests cover persistence before HTTP, exact request recovery across lost acknowledgement/reload, owner fences, Stop during a pending storage read/live HTTP request, exact full-text copy, concurrent count/byte bounds, storage denial, explicit failures, command/control exclusion, durable resolved quotes/images, concurrent identities, and persistence failure both before and after owner admission. They use fake IndexedDB and SQLite receipts; they do not claim power-loss testing, real-browser quota behavior or thread execution completion.
