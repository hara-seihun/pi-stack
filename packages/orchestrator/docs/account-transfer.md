# Exclusive account transfer

`pi-orchestrator account transfer ID --to PEER` moves one idle Codex account from the current host. `pi-orchestrator account fetch ID --from PEER` moves it to the current host. Both hosts need this command installed and noninteractive SSH access. Credentials travel through the SSH child's stdin, never command arguments, terminal output or a temporary export file.

```sh
pi-orchestrator account transfer-status openai-codex-1
pi-orchestrator account transfer openai-codex-1 --to peer --wait-for-drain 10m
pi-orchestrator account fetch openai-codex-1 --from peer --wait-for-drain 10m
```

The command does not submit new work, change the destination's budgets or force flags, spend a reset or adjust quota. Its explicit meter read uses the normal shared OAuth owner, including credential refresh when required. Existing queued work uses ordinary admission after the account arrives.

## Peer hosts

The host config selected by `PI_ORCHESTRATOR_CONFIG`, deployed at `/var/lib/pi-orchestrator/config.json` on Pi Stack hosts, can name account-transfer peers:

```json
{
  "peers": {
    "peer": {
      "sshHost": "peer-host",
      "returnRoute": {
        "sshHost": "return-host",
        "port": 22022
      }
    }
  }
}
```

`sshHost` is the local SSH alias for reaching the peer. `account transfer --to` resolves a peer name through this registry and still accepts a raw SSH alias. `pi-orchestrator peer list` prints the configured names and routes without opening a connection.

A `returnRoute` is required to fetch from a peer that cannot open SSH to the current host. Its `sshHost` is the alias that the peer uses for the current host while the fetch is running. Its port is a loopback port on the peer. Fetch starts SSH with `ControlMaster=no`, `ControlPath=none`, `ExitOnForwardFailure=yes` and `-R 127.0.0.1:PORT:127.0.0.1:22`. It then runs the existing transfer command on the peer with the return alias as its destination. The reverse forward belongs to that SSH process and closes when the remote transfer command exits. Fetch does not install a daemon or persistent tunnel.

A peer name is required for fetch because a raw SSH alias does not describe the return route. Each host can use a different registry entry for the same physical peer. The custody envelope remains bound to machine identity and ledger path rather than these operational names.

## Drain waiting

Without `--wait-for-drain`, transfer and fetch report `preparing` when leases or unfinished runs still use the source account. `--wait-for-drain` waits for up to ten minutes. It also accepts an explicit duration with `ms`, `s`, `m` or `h`, up to 24 hours. The source retries every five seconds. Every retry resumes the recorded preparation and retains its transfer ID and destination.

Drain waiting never stops a lease or run. A timeout exits with the transfer ID and current blockers while leaving the account disabled in `preparing` custody. Quota blockers and provider read failures are not drain work, so the command reports them without polling.

## Preconditions

The source account must be shared, out of cooldown, and below 100% on every quota window the provider reports. Some Codex plans expose only a weekly window; transfer does not require a nonexistent five-hour meter. An explicitly disabled account can begin transfer with stale readings without being reenabled. Before the credential leaves, the explicit post-drain provider read must refresh every retained window. After checking shared eligibility, the command durably records the exact destination, identity and initial quota snapshot and disables admission. Fresh leases and unfinished assigned fleet runs, including parked coordinators, return a `preparing` drain report without replacing the credential. Ordinary enable is forbidden while draining. Rerun the same transfer after those users finish, or use `--wait-for-drain` to poll without killing them. It leaves at least two other eligible Codex accounts on the source. A host-bound naming or application configuration must be reassigned before transfer; the transfer does not rewrite callers' model selections.

A destination [capacity reservation](account-reservations.md) can be installed before import. Transfer preserves it and does not copy a source reservation over it. Confirm required queue ordering before executing transfer; the destination enables the account as part of accepting custody.

The destination rejects an occupied alias or the same provider account identity under another alias. A completed departure is the exception: its disabled account row and nonsecret receipt allow the same identity to return under the same alias. A disabled account without that departure provenance still collides, as does a pending outgoing envelope. Complete its original acknowledgement before returning the account. Non-Codex OAuth credentials do not participate in identity comparison. A transfer binds to both hosts' machine identity and canonical ledger path, not only their SSH names.

## Custody and restart recovery

A dedicated transfer lock preserves custody through drain checks and the final meter read. After all source users drain, the owning Codex sampler explicitly reads provider quota while the account remains disabled. Both declared windows must have fresh readings from that read and remain below 100%. Exhaustion or a failed read leaves the source disabled with its credential unchanged; the status reports the blocker. The command rechecks leases, identity, destination and disabled state under the shared OAuth lock before handoff.

The shared OAuth lock serializes handoff with credential refresh. The source atomically replaces its ordinary OAuth alias with an `account-transfer-out` envelope. Its credential is inert outbox custody from that instant. Provider selection and refresh cannot use the envelope. Ordinary import/remove cannot replace it, and a ledger trigger prevents enabling the departed account.

The source retains this immutable envelope only until the destination acknowledges durable receipt. There can be two stored representations during delivery, but never two usable credentials or rotation owners. The source never rolls back or reactivates its envelope. The only recovery after preparation is to complete delivery to the same destination.

The destination first saves an `account-transfer-in` envelope. It is not an OAuth credential; ordinary import/remove/refresh cannot use or overwrite it. It then imports all account facts with admission disabled, promotes the credential under the same lock, and commits the receipt and enabled state. The metadata-import receipt and final admission receipt are separate. A crash between them resumes without importing usage twice. Before metadata import, the staged alias blocks ordinary credential mutation and refresh; after promotion, recovery checks the actual credential identity against the import receipt. An incomplete delivery retry validates the staged or current credential's provider identity. It preserves a credential already rotated after promotion, rather than replaying an obsolete token.

After a destination receipt, the source records it by transfer ID and replaces its envelope with that nonsecret receipt. Repeating the same command returns the receipt. A lost SSH acknowledgement also resumes safely: the destination returns its saved receipt without reimporting facts or replacing credentials, even after it has sent the account elsewhere. A retry of an earlier source acknowledgement likewise returns its saved receipt without changing the current credential or transfer phase. These receipts acknowledge historical delivery, not current ownership.

A received account can depart again, either back to its previous host or onward to another host. Each departure gets a new transfer ID, source endpoint and drain snapshot. Only a `preparing` state resumes an unfinished drain; a `received` state starts a new one. Returning custody replaces the previous disabled account metadata while retaining transfer receipts and merging history. It uses the same inert staging, metadata transaction and credential promotion as a first delivery. Source receipts from releases before per-transfer sent history are retained by ID before return staging replaces the alias.

A receiver collision leaves source admission disabled and the outbox intact, with an explicit error. Resolve the collision at its owner and rerun the same command. Do not import the credential manually.

`account transfer-status ID` prints the ledger phase, enabled flag and fresh lease IDs. It never prints the envelope. The internal `account transfer-receive inspect|receive` protocol reads JSON stdin and writes only public receipts or errors; the source command owns its invocation.

## History and quota

Transfer retains the alias, provider identity, label, concurrency, cooldown, creation time and last-admitted meter observation. It copies current meter history, hourly token attribution and closed lease history without changing timestamps or reset instants. Expired unended leases become closed at their last heartbeat in the destination snapshot. The source keeps its original historical rows and a disabled account record as provenance.

On a return, existing meter observations must match. Lease IDs must describe the same account, kind, run and start time; matching leases retain their latest heartbeat and closure. Hourly usage keeps the larger cumulative token count for each attribution key, rather than adding the incoming snapshot to its earlier copy. Exclusive custody means every successive owner inherits that count before adding its own usage, including usage in the same hour. Repeated visits and receipt retries therefore do not count imported usage twice. Conflicting meter or lease history aborts the metadata transaction with the credential still staged and admission disabled.

The destination needs these facts for quota pacing and calibration. Copied historical usage is not new spending; a cross-host accounting report must treat the source receipt as an ownership boundary rather than sum the two snapshots as separate usage. Provider-side quota, reset credits and redemption history belong to the unchanged provider account. Transfer never calls reset or quota mutation endpoints.

The canonical auth file owns credential envelopes. Ledger `account-transfer:*`, `account-transfer-imported:*`, `account-transfer-received:*`, `account-transfer-sent:*` and `account-transfer-target:*` controls own nonsecret transfer receipts and recovery state. No transfer payload belongs in logs or documentation. Both SQLite commits and atomic auth replacements are fsynced. Implementation is [`src/auth/account-transfer.ts`](../src/auth/account-transfer.ts); tests cover return and onward transfers, historical receipt retries, alias and identity collisions, and failures before metadata import and after credential promotion on both first and returning deliveries.
