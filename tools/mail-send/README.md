# Mail send

`pi-mail-send` is the owned SMTP sender. Every actual send uses the shared per-owner [ActionStore](../../packages/kenan-memory/src/actions.ts), regardless of `oneKenan`. Drafts have no action reservation or SMTP effect. This guards this command, not unrelated raw SMTP clients.

Run `pi-mail-send --help`. Credentials stay in the existing owner-held password-store route or `MAIL_BRIDGE_CREDENTIAL_FILE`; they are never copied into the action payload or receipts. The ActionStore CLI is `bun /srv/pi/runtime/node_modules/kenan-memory/src/actions-cli.ts`; `PI_KENAN_ACTION_CLI` selects an explicit installed/source CLI. The owner's configured `PI_REMOTE_PRIVATE_DIR`, `PI_REMOTE_CONFIG.unlock.mountpoint`, or absolute `PI_KENAN_ACTION_JOURNAL_DIR` supplies private storage; a missing owner/private directory refuses dispatch. The transport inherits the owning environment, never selects a different person's directory.

## Sending and inspecting

```sh
pi-mail-send --to recipient@example.test --subject 'Schedule' --body-file /path/body.txt --canonical-intent project:schedule --request-id request-identity --send
pi-mail-send --inspect-action ACTION_ID
```

`--canonical-intent` (`--intent-key`) identifies the stable purpose. If omitted, the reply's parent Message-ID identifies it, or the normalized subject does for a new message. `--request-id` is optional; a generated request ID does not evade canonical intent or recipient-slot fencing. The stable payload includes content, sender, recipients, reply headers and attachment bytes, but excludes generated Date, MIME boundaries and Message-ID. The actual Message-ID is deterministic from the gateway action ID.

Submission reserves all parsed To/Cc addresses; an atomic claim selects one sender, and a one-shot dispatch fence is checked immediately before `SMTP.send_message`. An exact existing `accepted` action can be claimed after preparation/crash-before-claim. Existing other states, recipient-held submissions, payload conflicts and denied claims are reported with the existing action/status/result without sending. Rephrasing a purpose or changing a UUID cannot contact the same unresolved recipient again, including across covered transports.

Known connection/authentication failures before send, or explicit SMTP rejection without DATA acceptance, record `failed-before-effect` and release the recipient slot. They do not automatically retry. Loss of SMTP confirmation records `uncertain`; process death after claim or SMTP acceptance before receipt leaves `inflight`. Neither state expires into replay permission. Partial recipient rejection after SMTP acceptance is `succeeded` with accepted/refused addresses, retaining the contact fence. A failed outcome commit reports `receipt-pending`; inspect rather than resend. The existing [action journal](../../docs/action-journal.md) remains a receipt projection when `oneKenan` enables it; it is not dispatch authority.

## Explicit followup

A genuinely new contact can atomically resolve the prior successful/no-effect purpose and reserve the next one, without per-action human approvals:

```sh
pi-mail-send --to recipient@example.test --subject 'Next scheduling step' --body-file /path/next.txt --canonical-intent project:next-step --request-id next-request --prior-action ACTION_ID --prior-revision REVISION --prior-resolution 'Prior purpose resolved; this is the next agreed step' --send
```

All three prior flags and a canonical intent are required. The exact inspected revision and accountable observation are recorded; unresolved uncertainty or a recipient hold cannot be cleared this way. For no-effect retry or provider-evidence reconciliation, use the shared actions CLI's `retry`/`reconcile` operations first, then rerun the exact canonical send. An inflight crash must be recovered by its owner with evidence that the old sender retired before reconciliation; absence of a receipt is not no-effect evidence.

## No-network proof

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/mail-send/test_send.py
```

Tests use synthetic addresses, fake SMTP/credential resolution, the real source ActionStore CLI and a fresh temporary private directory for each test. No real send or live personal action state is used. Coverage includes new request IDs, rephrased intent, ambiguity/crash fencing, no-effect slot release, atomic followup, partial acceptance and receipt projection. `--fixture` also runs this isolated suite. [Deployment](../../docs/one-kenan-deployment.md) owns installation/cutover.
