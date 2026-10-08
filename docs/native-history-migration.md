# Native history retirement: explicit maintenance migration

Owner: release maintenance and the owner-local unlock gate, before Remote or Orchestrator runtime startup.
Implementation: [`scripts/migrate-native-history.mjs`](../scripts/migrate-native-history.mjs).
Requires Node 24 with `node:sqlite`. Run separately for each person's owning Unix user and database pair.

## Invocation

Stop **all** controllers, supervisors, runners, Voice/Meet participants and other writers of the selected supervisor DB, thread DB and native JSONL files. Keep them stopped until this command returns `ok:true`. Run before the new supervisor's startup/event-journal retirement; startup must not remove source thinking before maintenance sees it.

Use the person's actual configured Remote data directory (`supervisor.sqlite3` and `threads.sqlite3`), or explicitly select the owning Orchestrator thread database when that is the native path authority. There is no implicit database discovery or path selection.

```sh
node scripts/migrate-native-history.mjs \
  --supervisor-db /absolute/owner/data/supervisor.sqlite3 \
  --thread-db /absolute/owner/data/threads.sqlite3 \
  --output-dir /absolute/owner/private/native-history-retirement \
  --writers-stopped
```

The output directory must be owned by the invoking user, mode `0700`, outside both input databases and native sources. Both databases and native files must belong to that user. The explicit flag asserts actual writer shutdown; it does not stop processes. Do not run another person's migration as an administrator identity. The release owner runs the command under that person's Unix user with their decrypted state mounted.

On large databases, submit this exact foreground command to the host's durable maintenance-job service, which owns its log and exit receipt. The migration uses page-wise SQLite backup, streaming file copies/hashes and record-wise JSONL processing, rather than reconstructing captured contexts. Native records and individual thinking bodies have an explicit 64 MiB ceiling; exceeding it returns an error after preserving the source. Total historical input size is not held in JavaScript memory.

## First unlock

[`pi-remote-launch`](../apps/remote/server/pi-remote-launch) runs the shipped Node 24 [`native-history-startup.mjs`](../apps/remote/server/native-history-startup.mjs) after mounting the person's encrypted folder and before starting its supervisor. This gate runs under the owning UID inside that same private mount namespace. `PI_REMOTE_CONFIG` must be an absolute version-1 person config; `PI_REMOTE_DATA` must explicitly name a normalized absolute owner data directory. An existing environment value takes precedence over the person config, matching Remote's config application. Unset, empty, relative or non-string values are configuration errors.

A fresh owner with no supervisor database needs no migration or artifacts. A native schema or completed marker needs no migration; the gate still checks retained producer generations. Current runners reporting control status `historySource: "native-jsonl-v1"` retain their normal output/reattachment custody. An old schema requires positive absence of every owner-scoped native/supervisor process and listening old control/session socket, and empty retained `.events` files. A stopped runner's nonempty spool is not treated as acknowledged. The gate does not stop writers, consume old frames, delete spools, or infer readiness from the migrated marker. Data files, mapping databases, retained references and socket directories are checked against the invoking owner. Long configured data paths use the runner's hashed `/run/user/UID/pi/HASH` socket directory too.

Maintenance may write `PI_REMOTE_DATA/native-history-readiness.json`:

```json
{"version":1,"contract":"native-history-v1","uid":1000,"dataDir":"/absolute/owner/data","state":"ready","writersStopped":true,"retainedOutput":"acknowledged"}
```

The receipt must bind the actual UID/data directory. Additional `candidate`, `legacySource` and `migratedAt` fields preserve publication provenance. A present incomplete, corrupt or differently bound receipt refuses startup. A locked owner without a receipt may proceed only after its own positive writer/output census. Even a valid receipt cannot override a live old writer or nonempty old output.

Once ready, the gate invokes the shipped migrator with explicit `supervisor.sqlite3`, `threads.sqlite3`, `native-history-retirement` and `--writers-stopped`. It gives the migration 45 seconds. A timeout is retryable; durable snapshots, preimages and prepared replacements remain owned by the migrator and are replayed on the next startup. Use the explicit durable maintenance invocation above when a database requires a longer uninterrupted snapshot. Source/mapping corruption and missing mapped native files are the migrator's preserving typed errors, not reasons to start an empty supervisor.

### Retained old producers at a locked owner's unlock

An old schema with live legacy writers or unacknowledged legacy output can select the shipped [`native-history-startup-legacy.mjs`](../apps/remote/server/native-history-startup-legacy.mjs) bootstrap only when publication has staged `/srv/pi/.pi-stack-maintenance/native-history/CANDIDATE/legacy.json`. Its version-1 manifest binds `candidate`, `legacySource`, `legacyRemote`, `legacyOrchestrator`, `bridgeModule`, `migrator`, and `node`; candidate must equal the installed Remote `.pi-stack-commit`, and both old release stamps must equal `legacySource`. These are source-only trusted deployment assets, not another person's state. The old API resolves through old Remote's own `node_modules/pi-orchestrator/src/api.ts`, preserving its module identity.

The launcher retains the decrypted mount namespace, starts that source-bound old controller with `installLegacyMaintenance({mode:"remote",autoAdvance:true,...})`, and lets its old capture listener consume/acknowledge its own frames. The bridge fences new admission, waits for old accepted work, closes old owners and their databases, migrates, and exits 75. The supervised bootstrap then reruns the startup gate before launching the original candidate command. Missing/corrupt mapped native sources, invalid config/ownership, an unbound manifest or legacy output beside an already migrated schema never select this bootstrap.

Startup emits one JSON result. Exit 75 means unresolved producer/output custody, an unready receipt, or a bounded migration timeout; source is retained. Exit 76 is the internal source-bound `legacy-required` transition handled by the launcher. Exit 78 means a configuration, ownership, schema or preserving migration failure requiring repair. Remote releases require the gate, bootstrap, migrator and this document as assets; no source checkout is needed at unlock.

Sparse first-unlock contracts, including the real namespace launcher's ordering:

```sh
node --test apps/remote/server/native-history-startup.test.mjs
```

## Durable output

- `supervisor.sqlite`: full original supervisor SQLite backup, including every row and original schema of `session_contexts`, `session_context_patches`, `captured_context_unavailable`, `captured_context_usage`, `captured_transcript_generations`, `message_facts`, and any older `events` journal. No context JSON or patch reconstruction is needed. Full backup also preserves attachment/presentation/fact provenance needed to interpret those rows.
- `threads.sqlite`: original thread SQLite backup containing the `thread.id → thread.session_file` mapping.
- `snapshot.json`: input bindings and SHA-256 hashes for both backups.
- `native/*.jsonl`: exact native source preimages, copied and fsynced before any replacements.
- `receipt.sqlite`: durable stages, per-native-file preimage/output hashes, old/new finalization keys, promoted/existing/different counts, orphan session names and source-row counts, plus the preserved source thinking join table.
- `lock.sqlite`: exclusive maintenance lock; a crashed process releases it through SQLite.

Backups, preimages and the snapshot manifest are read-only (`0400`), fsynced and hash-bound. They are custody artifacts, not runtime data sources. Keep the private directory in the owner's backup coverage; do not publish its files, put them in a source checkout, or delete it when retiring a release build. Read-only here is a maintenance invariant, not filesystem WORM enforcement against the owner.

## Transformation and retirement

Native messages are matched to source thinking by the original `messageFinalizationKey`: SHA-256 of JavaScript `JSON.stringify({role,timestamp,content})`. All branches are scanned. For a matching assistant with missing/empty thinking, the original thinking block's metadata is retained and its body is filled, or a thinking block is inserted when absent. Existing nonempty native thinking is never overwritten; a different source body stays in the supervisor snapshot and is counted separately. Native entry IDs, parent chains, message timestamps, tool calls/results, usage and other message fields stay unchanged. Unmodified JSONL records—including receipt records—remain byte-for-byte unchanged. Rewritten records' exact original bytes remain in their preimages.

Old `events` thinking facts are also eligible, using the original event-retirement `MAX(text)` grouping by session/finalization key, with existing nonempty `message_facts.thinking` taking precedence. Original event payloads remain in the immutable supervisor snapshot.

Each staged native replacement is fsynced and hashed. Its prepared receipt commits before atomic rename and directory fsync. After every relevant mapped native file is complete:

1. Take the supervisor's write lock and reject intervening writes.
2. Rekey existing `message_facts.finalizes_message` to the promoted native content hash so response metrics still join. Rekey matching surviving thinking/metrics event payloads too, so a subsequent startup migration cannot recreate stale metric joins. A conflicting destination fact key is an explicit error, not a lossy merge.
3. Drop `message_facts.thinking`, retaining response metrics and other columns.
4. Drop only the retired captured-context tables present in the original backup.
5. Record `metadata.native_history_contract = "native-history-v1"`, commit these supervisor changes together, then commit the completion receipt.

New supervisors refuse startup with `migration_required` while retired capture tables, old `message_facts.thinking`, or unpreserved thinking events remain. This also protects locked people at their next unlock. New native runners identify their protocol through successful `get_state` response `data.historySource = "native-jsonl-v1"`. Drain existing generations through their current controllers and close idle resident sessions/runners before replacing that source; their old capture frames are not part of the new runtime protocol.

A session absent from the original thread mapping is a legitimate preserved orphan: its captures/facts stay in the snapshot, it is not fabricated into a native thread, and its name/counts are recorded in `receipt.sqlite.preserved_orphans`. The JSON success result reports orphan totals, the first 20 session names, unmatched fact count and artifact paths. Inspect the receipt for the full list. Unmatched keys in readable native files likewise stay preserved, not discarded. A mapped missing/corrupt native file is a typed error and prevents schema retirement, including capture-only sessions.

## Restart and errors

Replay the **same command with the same output directory** while writers remain stopped. The original snapshots are hash-checked, completed native replacements are recognized by hash, and a prepared replacement can be resumed from its immutable preimage. A crash between supervisor commit and final receipt is recoverable because retirement-ready is recorded before the atomic supervisor transaction. Never add a runtime fallback reader for these artifacts.

An error exits nonzero with `{ok:false,error:{code,message}}`. Before supervisor retirement, its captured tables and thinking column remain intact. Already completed native replacements are individually durable and remain journaled for replay. Corrupt native sources are preserved before parsing; a missing native file's unique thinking is still preserved in the supervisor backup. Restore a missing file at its original mapped path and replay. Changed/corrupt snapshots, unexpected edits to a native source, modified supervisor data on restart, partial schema removal, and key collisions are explicit failures; do not force them through by editing hash receipts. Repair from the saved originals and retained receipts under the owning user before resuming maintenance. Snapshot-backed custody is not evidence that an unavailable native history has been repaired.

Once writers resume, this maintenance window is over. Future native appends are not the stopped migration's inputs; do not reuse the directory for an unrelated database generation.

Small contract tests:

```sh
node --test scripts/migrate-native-history.test.mjs
```
