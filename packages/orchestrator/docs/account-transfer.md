# Exclusive account transfer

`pi-orchestrator account transfer ID --to SSH_HOST` moves one idle Codex account between two Pi Stack hosts. Both hosts need this command installed and ordinary noninteractive SSH access. Run it on the source. Credentials travel through the SSH child's stdin, never command arguments, terminal output or a temporary export file.

```sh
pi-orchestrator account transfer-status openai-codex-12
pi-orchestrator account transfer openai-codex-12 --to converge-kenan
ssh converge-kenan pi-orchestrator account transfer-status openai-codex-12
```

The command does not submit new work, change the destination's budgets or force flags, spend a reset or adjust quota. Its explicit meter read uses the normal shared OAuth owner, including credential refresh when required. Existing queued work uses ordinary admission after the account arrives.

## Preconditions

The source account must be shared, out of cooldown, and below 100% on fresh five-hour and weekly meters. An explicitly disabled account can begin transfer without being reenabled. After checking eligibility, the command durably records the exact destination, identity and initial quota snapshot and disables admission. Fresh leases and unfinished assigned fleet runs, including parked coordinators, return a `preparing` drain report without replacing the credential. Ordinary enable is forbidden while draining. Rerun the same transfer after those users finish; the command does not poll or kill them. It leaves at least two other eligible Codex accounts on the source. A host-bound naming or application configuration must be reassigned before transfer; the transfer does not rewrite callers' model selections.

A destination [capacity reservation](account-reservations.md) can be installed before import. Transfer preserves it and does not copy a source reservation over it. Confirm required queue ordering before executing transfer; the destination enables the account as part of accepting custody.

The destination must have neither the same alias nor the same provider account identity under another alias. Non-Codex OAuth credentials do not participate in identity comparison. A transfer binds to both hosts' machine identity and canonical ledger path, not only their SSH names.

## Custody and restart recovery

A dedicated transfer lock preserves custody through drain checks and the final meter read. After all source users drain, the owning Codex sampler explicitly reads provider quota while the account remains disabled. Both declared windows must have fresh readings from that read and remain below 100%. Exhaustion or a failed read leaves the source disabled with its credential unchanged; the status reports the blocker. The command rechecks leases, identity, destination and disabled state under the shared OAuth lock before handoff.

The shared OAuth lock serializes handoff with credential refresh. The source atomically replaces its ordinary OAuth alias with an `account-transfer-out` envelope. Its credential is inert outbox custody from that instant. Provider selection and refresh cannot use the envelope. Ordinary import/remove cannot replace it, and a ledger trigger prevents enabling the departed account.

The source retains this immutable envelope only until the destination acknowledges durable receipt. There can be two stored representations during delivery, but never two usable credentials or rotation owners. The source never rolls back or reactivates its envelope. The only recovery after preparation is to complete delivery to the same destination.

The destination first saves an `account-transfer-in` envelope. It is not an OAuth credential; ordinary import/remove/refresh cannot use or overwrite it. It then imports all account facts with admission disabled, promotes the credential under the same lock, and commits the receipt and enabled state. The metadata-import receipt and final admission receipt are separate. A crash between them resumes without importing usage twice. Before metadata import, the staged alias blocks ordinary credential mutation and refresh; after promotion, recovery checks the actual credential identity against the import receipt. A retry validates the staged or current credential's provider identity. It preserves a credential already rotated after promotion, rather than replaying an obsolete token.

After a destination receipt, the source replaces its envelope with a nonsecret receipt. Repeating the same command returns the receipt. A lost SSH acknowledgement also resumes safely: the destination returns its saved receipt without reimporting facts or replacing credentials. A receiver collision leaves source admission disabled and the outbox intact, with an explicit error. Resolve the collision at its owner and rerun the same command. Do not import the credential manually.

`account transfer-status ID` prints the ledger phase, enabled flag and fresh lease IDs. It never prints the envelope. The internal `account transfer-receive inspect|receive` protocol reads JSON stdin and writes only public receipts or errors; the source command owns its invocation.

## History and quota

Transfer retains the alias, provider identity, label, concurrency, cooldown, creation time and last-admitted meter observation. It copies current meter history, hourly token attribution and closed lease history without changing timestamps or reset instants. Expired unended leases become closed at their last heartbeat in the destination snapshot. The source keeps its original historical rows and a disabled account record as provenance.

The destination needs these facts for quota pacing and calibration. Copied historical usage is not new spending; a cross-host accounting report must treat the source receipt as an ownership boundary rather than sum the two snapshots as separate usage. Provider-side quota, reset credits and redemption history belong to the unchanged provider account. Transfer never calls reset or quota mutation endpoints.

The canonical auth file owns credential envelopes. Ledger `account-transfer:*`, `account-transfer-imported:*`, `account-transfer-received:*` and `account-transfer-target:*` controls own nonsecret transfer receipts and recovery state. No transfer payload belongs in logs or documentation. Both SQLite commits and atomic auth replacements are fsynced. Implementation is [`src/auth/account-transfer.ts`](../src/auth/account-transfer.ts); tests inject failures before metadata import, after credential promotion and after destination acknowledgement.
