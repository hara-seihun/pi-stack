# Pi session readers

## Stored history reading and search

`read-thread` reads a thread's native Pi JSONL. Native history is authoritative for conversation entries, tool activity and branches. There is no portable conversation journal.

The command reads the current session and other threads without model calls, a recall cache or an index. `self` resolves Pi's built-in `PI_SESSION_FILE`, refreshed for each shell-tool invocation. An explicit JSONL path works in ordinary shells and fleet workers without a thread database. Titles and IDs resolve through the database owned by that thread service.

```bash
read-thread --path self
read-thread --work --tail 100 self
read-thread --search 'deployment decision' self
read-thread --all --search 'error|failed' --regex --limit 20 --offset 20 self
read-thread --leaf a1b2c3d4 self
read-thread --all --raw --output /tmp/session.jsonl self
read-thread --full --output /tmp/thread.md /path/to/session.jsonl
read-thread --list
read-thread "Cayley CI review"
read-thread --path "Cayley CI review"
rg -n -m 20 --max-columns 1000 --max-columns-preview 'pattern' "$PI_SESSION_FILE"
```

The default scope follows the parent chain through the newest stored entry, including all pre-compaction history. It is not Pi's compacted model context. `--leaf ID` follows an explicit entry's parent chain, including a live runtime's selected tip after tree navigation. The shared Pi package reports the session file and reader contract as generated JSON metadata in Remote and fleet system context. It omits the changing branch leaf so advancing the conversation does not change the system-prompt prefix. `--leaf ID` remains an explicit selection using an entry id from the transcript. A runtime can navigate without appending an entry, so its live leaf can differ from the newest stored entry. `--all` reads every branch in file order. Each rendered entry names its original JSONL line and entry id.

The default view omits assistant thinking and successful tool results. `--work` includes both with per-block limits of 4,000 characters and tool arguments capped at 1,000. `--full` removes those caps. `--raw` emits exact selected JSONL records, including metadata, embedded compaction checkpoints, signatures and image bytes. `--all --raw` exposes every complete stored record. It does not reconstruct missing text from opaque provider data. `--since` and `--tail` select entries before rendering or searching. A partial final JSONL line is omitted while a live writer finishes it; malformed complete lines fail with their original line number.

`--search TEXT` scans complete JSONL records, including tool results, thinking and fields omitted from the rendered view. Matching is case-insensitive literal text unless `--regex` selects a JavaScript regular expression. Search returns one excerpt per matching record, at most 1,000 source characters near the first match, with the source path, line and entry id. It defaults to 20 matches and accepts at most 50. `--offset` pages matches; an explicit continuation marker reports another page. Direct `read`, `rg`, or `--raw` can inspect the complete source. No reader writes or deletes session history; `--output` writes only the requested output file.

For title and ID lookup, `--db FILE` wins. Otherwise discovery checks `PI_THREAD_DATABASE`, then `PI_REMOTE_DATA/threads.sqlite3`. In an SSH shell it can read the current Unix user's `PI_REMOTE_DATA` from `/var/lib/pi-remote/persons/<user>.json`. Without those settings it uses `$XDG_DATA_HOME/pi-orchestrator/threads.sqlite3`, or `~/.local/share/pi-orchestrator/threads.sqlite3` when `XDG_DATA_HOME` is unset.

If a request failed before Pi wrote a session file, the default reader displays retained thread inputs and labels them as records rather than a model transcript. JSONL-only options report that no transcript exists. `self` reports an absent persistent file rather than selecting another thread. On a fresh session, Pi may not flush the file until the first assistant message.

Stored JSONL is the history source of truth. Compaction changes model context, not this reader's access to earlier entries. Removing VCC does not require deleting or converting JSONL, and reading history does not depend on VCC state.

[`packages/orchestrator/src/threads/history.mjs`](../../packages/orchestrator/src/threads/history.mjs) owns native parsing, branch selection and timestamps for the reader and thread service. [`contract.mjs`](contract.mjs) owns command syntax, option descriptions and the exported `HISTORY_MARKER`, `pi-stored-jsonl-history`. It generates `read-thread --help`; `read-thread --contract` emits the same contract as JSON without resolving a session or database. The shared Pi package reads that contract once per extension instance and adds generated JSON metadata containing it and the current session file. The metadata stays byte-identical while the branch advances. It contains command facts, not a separate behavioral prompt. An incompatible native compaction checkpoint does not replace stored history. Its notice identifies checkpoint availability, while the retained tail and raw JSONL remain accessible.

## Thread pages

Every thread can list direct subthreads and read persisted history through the common thread API. These operations do not start the target thread. The shell pages use the same native-history parser and owner database.

`--subagents` lists direct subthreads by their latest user or assistant message, not by runtime heartbeats or title updates. The default limit is 20 and only unarchived `running` threads appear. `--include-idle` also includes idle, stopped and archived subthreads. Each row includes its thread ID, model, shared lowercase thread state and last-message time. `nextCursor` continues a bounded snapshot with the same parent and idle filter.

`--json` accepts a title, UUID, unique prefix, `self` or explicit JSONL path. Its default page contains the latest ten visible transcript entries, in chronological order within that page. `nextCursor` reads the preceding page on the same active branch. New messages do not shift an ongoing read. A changed branch produces an explicit restart error. Deliberation is omitted. A preview marked `truncated` supplies `entryId`; reading that entry with `offset` and `maxChars` returns `nextOffset` until every character has been read. Threads without a Pi session file return labelled thread inputs.

The same operations are available from the shell:

```bash
read-thread --subagents --include-idle --limit 20 THREAD
read-thread --subagents --include-idle --cursor CURSOR THREAD
read-thread --json --work --limit 10 THREAD
read-thread --json --work --cursor CURSOR THREAD
read-thread --json --work --entry ENTRY --offset 0 --max-chars 16000 THREAD
read-thread --json --work --limit 10 self
```

`--json` accepts `self` or an explicit JSONL path without a thread database. `--subagents` requires database discovery; an omitted selector or `self` uses `PI_THREAD_ID`, then `PI_REMOTE_SESSION_ID`. Shell JSON pages omit successful tool results unless `--work` is present, while the model-facing `thread_read` tool includes them by default. Deliberation remains omitted from pages in either mode.

`--limit` defaults to 10 transcript entries with a maximum of 20, or 20 children with a maximum of 100. Search retains its separate default of 20 matches and maximum of 50. `--offset` counts characters with `--json --entry` and matching records with `--search`. Paged reads reject search, raw/full output, alternate branch selection, time/tail filters and output-file flags instead of silently ignoring them. `--entry` chunks use `nextOffset`; ordinary pages use `nextCursor`.

## Native record corruption and recovery

A malformed LF-terminated record is corruption, not an unfinished append. The canonical indexed reader reports its exact line, byte offset, raw length, SHA-256, `closed` state and syntax category without exporting the body or a parser snippet. Reading never skips that record. An unclosed final line remains a resume point while its writer finishes.

[`history-recovery.mjs`](../../packages/orchestrator/src/threads/history-recovery.mjs) owns `stageNativeHistoryRecordRecovery`. Recovery requires the current full byte-prefix watermark and complete raw native records recovered from their authenticated resident owner. It accepts only missing-prefix insertion: every original fragment byte must remain an exact suffix of the recovered record. Guessed headers, content edits, replacement of valid records, changed source evidence and unresolved tails are errors.

The helper writes two explicitly selected new private files: an exact byte-for-byte quarantine copy and a restored native JSONL. It fsyncs them and their directories, leaves the source untouched and returns a metadata-only `staged-not-adopted` receipt. Quarantine is evidence owned by this recovery operation, not a second history authority. The thread controller must fence every native writer before explicitly selecting a restored session. If the original owner no longer retains the missing prefix, recovery remains unresolved; a readable invented history is not a repair.

## Operations

```bash
npm test --workspace=@hara-seihun/read-condensed-session
../../deploy/tools local
```

The tools deployment links `read-thread` into the interactive and fleet users' `~/.local/bin` and publishes its source under `/srv/pi/tools/read-condensed-session`.
