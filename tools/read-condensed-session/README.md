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

## Model-assisted condensation

`read-condensed-session` is for a session whose local transcript remains too large after selecting a useful window. It avoids raw JSONL, signatures, and abandoned branches, but it makes model calls on cache misses and is not the default thread reader.

```bash
read-condensed-session /path/to/session.jsonl
read-condensed-session --output /tmp/condensed.md /path/to/large-session.jsonl
read-condensed-session --since 2026-08-28T15:20:00.000Z /path/to/session.jsonl
read-condensed-session --threshold 32000 --concurrency 8 /path/to/session.jsonl
```

For a large session, use `--output FILE` and inspect the result in slices.

`--since TIMESTAMP` filters the active path before condensation. The output
prints both the requested lower bound and the latest included timestamp. A
caller can use that upper bound as the next read's lower bound. Team
supervision always supplies `--since`, so each read contains only the worker's
new activity.

## Transcript shape

The command follows the active parent chain and flattens it into user text, assistant prose and thinking, tool calls, tool results, images, and compaction entries.

It retains these durable conversational anchors:

- every user message;
- the final assistant prose before each user message;
- images and compaction markers;
- recent activity beginning at the tenth-most-recent tool call.

Large thinking and tool-result bodies in the recent tail are capped at 2,000 characters, and tool-call arguments at 500, so a short session cannot become mostly one raw result.

Everything else is condensed in two passes:

1. Blocks of at least 16,000 source characters receive a focused pre-summary.
2. Each substantial anchor-to-anchor work episode is represented by its small original blocks plus those pre-summaries, packed into chunks of at most about 300,000 characters, and rewritten as a chronological episode account. Pre-summaries inform the account rather than remaining as separate visible units.

This topology follows conversational work episodes rather than the accidental boundaries between thinking and tool blocks. Small episodes below the threshold remain readable as-is.

## Model requests and cache

Each cache miss is a direct `ModelRuntime.complete` request with exactly one user message. It does not call `session.prompt` and sends no Pi coding prompt, tools, skills, `AGENTS.md`, extensions, or conversation history. A lightweight session bootstrap is used only to load extension-registered provider aliases and credentials. The default model is `gpt-6-astra`; when several authenticated providers serve it, a failed provider falls through to the next alias.

Defaults and overrides:

| Setting | Default |
|---|---|
| `--model` / `SESSION_CONDENSER_MODEL` | `gpt-6-astra` |
| `SESSION_CONDENSER_PROVIDER` | any authenticated provider serving the model |
| `--thinking` | `low` |
| `--concurrency` / `SESSION_CONDENSER_CONCURRENCY` | 16 |
| `--db` / `SESSION_CONDENSER_DB` | `~/.local/share/session-condenser/summaries.sqlite3` |

The cache key is the SHA-256 of the exact model prompt. Source changes, episode-boundary changes, and prompt edits therefore invalidate only the summaries they affect. Stable completed episodes keep their cache entries as a live session grows.

## Operations

```bash
npm test --workspace=@hara-seihun/read-condensed-session
../../deploy/tools local
```

CI tests every shared command. `deploy/tools local` links both commands into the interactive and fleet users' `~/.local/bin` and publishes the reviewed source under `/srv/pi/tools/read-condensed-session`. The release shares Pi Runtime's production dependencies. The deployed Pi coding-agent runtime remains the provider and credential source for optional condensation; neither command registers a Pi extension.

The 2026-08-25 full-session trial condensed the `User Message Extraction` session from 3,840,059 on-disk characters to 174,849 characters, down from 404,334 with the former per-block design. It generated 17 large-block pre-summaries and 16 episode summaries with no failures. Manual inspection recovered decisions, exact paths and commits, failed approaches, benchmark values, current state, and the recent tail; all user messages and answered assistant replies remained exact.
