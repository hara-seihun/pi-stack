# read-condensed-session

`read-condensed-session` lets one agent read another Pi session without loading raw JSONL, signatures, or abandoned branches into context.

```bash
read-condensed-session /path/to/session.jsonl
read-condensed-session --output /tmp/condensed.md /path/to/large-session.jsonl
read-condensed-session --threshold 32000 --concurrency 8 /path/to/session.jsonl
```

For a large session, use `--output FILE` and inspect the result in slices.

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

Each cache miss is a direct `ModelRuntime.complete` request with exactly one user message. It does not call `session.prompt` and sends no Pi coding prompt, tools, skills, `AGENTS.md`, extensions, or conversation history. A lightweight session bootstrap is used only to load extension-registered provider aliases and credentials. The default model is `gpt-5.6-sol`; when several authenticated providers serve it, a failed provider falls through to the next alias.

Defaults and overrides:

| Setting | Default |
|---|---|
| `--model` / `SESSION_CONDENSER_MODEL` | `gpt-5.6-sol` |
| `SESSION_CONDENSER_PROVIDER` | any authenticated provider serving the model |
| `--thinking` | `low` |
| `--concurrency` / `SESSION_CONDENSER_CONCURRENCY` | 16 |
| `--db` / `SESSION_CONDENSER_DB` | `~/.local/share/session-condenser/summaries.sqlite3` |

The cache key is the SHA-256 of the exact model prompt. Source changes, episode-boundary changes, and prompt edits therefore invalidate only the summaries they affect. Stable completed episodes keep their cache entries as a live session grows.

## Operations

```bash
npm test
./deploy
```

`deploy` tests the implementation, links the interactive command at `~/.local/bin/read-condensed-session`, publishes a self-contained fleet copy under `/srv/pi/tools/read-condensed-session`, and verifies both users can run `--help`. The deployed Pi coding-agent runtime remains the provider and credential source; this tool does not register a Pi extension.

The 2026-08-25 full-session trial condensed the `User Message Extraction` session from 3,840,059 on-disk characters to 174,849 characters, down from 404,334 with the former per-block design. It generated 17 large-block pre-summaries and 16 episode summaries with no failures. Manual inspection recovered decisions, exact paths and commits, failed approaches, benchmark values, current state, and the recent tail; all user messages and answered assistant replies remained exact.
