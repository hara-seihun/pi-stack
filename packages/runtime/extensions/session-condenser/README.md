# session-condenser

A pi extension registering one tool, `read_condensed_session`: read another agent's session `.jsonl` as a hierarchically condensed transcript. Long blocks get individual summaries (pass 1); every stretch of small blocks between them is then compacted into a single prose block written with the condensed neighbors as context (pass 2). User messages, the assistant replies they answered, and the most recent ten tool calls stay verbatim.

Built for agents supervising or collaborating with other agents (clique/observer designs): a raw session file is 10–100x larger than what a reader needs, and almost all of that mass is thinking blocks and tool output.

## How it works

1. Parse the session file and walk the parent chain from the last entry, so abandoned branches are excluded and compaction entries are rendered as markers. Flatten the path into one ordered sequence of block items (user messages, assistant text, thinking, tool calls, tool results).
2. Mark the anchors that are never condensed: every user message, the assistant prose immediately preceding each user message (the reply the user actually read), and everything from the 10th-most-recent tool call onward — the verbatim tail overrides everything.
3. **Pass 1**: every non-anchor block at or over the threshold (default 4000 chars) is summarized individually. Thinking keeps decisions, findings with exact identifiers, dead ends, next step, and surviving doubts; outputs and payloads keep load-bearing values. The per-summary cost is ~1.5–2 k chars regardless of input, so only big blocks are worth an individual summary.
4. **Pass 2**: each maximal row of blocks pass 1 left untouched whose combined mass clears the threshold becomes one summarization job. The compactor sees the condensed neighbor on each side — the pass-1 summary of the block before and after, marked context-only — plus all the row's blocks, and writes one prose block that replaces the row. Rows over 150 KB are packed into ≤150 KB chunks, one summary each. Rows below the threshold stay verbatim: a summary would cost more than it saves.
5. All jobs, both passes, are deduplicated by SHA-256 of their exact input and looked up in the summary database first. Anything already summarized — by any earlier read, of any session — is free; sibling lane sessions share identical replayed blocks. Misses run in parallel (default 16 concurrent in-process model calls, no subprocesses) with kind-specific prompts in [`prompts.mjs`](prompts.mjs).
6. Render the transcript. A compacted row appears as `[10:24 → 10:41] condensed row · 37 blocks (14 tool calls) · 84,120 chars · summarized:` followed by its prose; a pass-1 block as `[75,892 chars · summarized]` under its own header. Failed summarization is loudly marked with the error and the first 800 chars — failures are visible, never silent.

The `output_file` parameter writes the transcript to a file and returns only statistics; use it when the condensed result is itself large.

## Summarizer model

Default `gpt-5.6-sol` — effectively free on the codex subscription accounts, which is right for a summarizer that runs constantly. (`claude-haiku-4-5` was the original choice, measured against 43–76k-char opus/fable thinking blocks 2026-08-25: ~20x compression with identifiers intact, ~30 s per block; the cache still holds those summaries.) The tool prefers the calling session's own provider when it serves that model, then any other authenticated provider serving it — the same model id is typically available through several alias accounts, and any one account can be out of usage at a given hour (account 1 was, the day this was built), so on a failed call the run advances to the next provider rather than dying with the first exhausted account.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_CONDENSER_MODEL` | `gpt-5.6-sol` | Summarizer model id |
| `SESSION_CONDENSER_PROVIDER` | any authenticated provider serving the model | Pin one provider (disables the candidate walk) |
| `SESSION_CONDENSER_DB` | `~/.local/share/session-condenser/summaries.sqlite3` | Summary cache (SQLite, per user) |
| `SESSION_CONDENSER_CONCURRENCY` | `16` | Parallel summarizer calls |

The cache is content-addressed and never invalidated: a job's input text is its identity, so a stale entry is impossible. Changing the *prompts* does not re-summarize existing entries; delete the database if summaries produced by an older prompt should be regenerated. Memoization stays stable as a live session grows: pass-1 hashes depend only on block text, row-chunk hashes depend on the row's blocks plus its pass-1-summarized neighbors (themselves cached), and chunks pack greedily from row start — so only rows near the still-moving end re-summarize on a re-read.

## Tests

```sh
node --test condense.test.mjs
```
