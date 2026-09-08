# Pi session readers

## Fast Pi Remote thread reading

`read-thread` is the normal way for one Pi Remote agent to read another thread. It resolves titles and ids through the current person's supervisor database, follows the active Pi branch, and renders the conversation and tool calls without making model requests.

```bash
read-thread --list
read-thread "Cayley CI review"
read-thread --work --tail 100 0a4b1d12
read-thread --path "Cayley CI review"
read-thread --output /tmp/thread.md "Cayley CI review"
```

The default view omits assistant thinking and successful tool results. `--work` includes both with per-block size limits. `--since` and `--tail` bound long sessions. `--path` prints the exact JSONL path when direct inspection is useful. The command reads `$PI_REMOTE_DATA/supervisor.sqlite3`, which Pi Remote supplies to every model process, so it selects the correct local or Converge thread store without a hard-coded personal path. In an SSH shell, it reads the current Unix user's `PI_REMOTE_DATA` from `/var/lib/pi-remote/persons/<user>.json`. If a request failed before Pi wrote a session file, the reader displays the supervisor's retained requests and events, explicitly labelled as supervisor records. `--path` still requires an existing JSONL.

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
