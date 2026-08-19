# Pi usage logger

This locally owned Pi extension records content-free provider and agent telemetry for every interactive, Pi Remote, prompt-evaluation, and autonomous-orchestrator session.

## State

The canonical ledger is `/home/kenan/data/pi-usage/usage.sqlite3` in SQLite WAL mode. The directory and database are owner-only. `PI_USAGE_DATA` or `PI_USAGE_DB` may override the location for tests and isolated deployments.

The ledger stores:

- session owner and engine correlation (`PI_REMOTE_SESSION_ID`, orchestrator run ID, prompt-evaluation case, or interactive session);
- model, exact provider alias, API, thinking level, service tier, every HTTP attempt and safe request-ID/rate-limit response header, first-stream and total latency, response ID, stop reasons, classified error hash, and every provider usage/cost bucket;
- system-prompt, tool-schema, provider-payload, context, response, compaction summary, tool-argument, and tool-result byte counts and SHA-256 fingerprints;
- context composition by user, assistant, thinking, tool-result, image, and tool-call volume;
- agent runs, turns, tools, assistant errors, content-free transport diagnostics, internal HTTP retries, model changes, session lifecycle, nested tool LLM usage, tree-summary usage, and compaction usage.

It never stores prompt text, response text, thinking text, tool arguments/results, credentials, cookies, raw error messages, or unrestricted response headers. Large image/base64 fields contribute only their size marker to fingerprints. Logging failures are rate-limited on stderr and never fail the model request.

The extension uses Node's built-in `node:sqlite`, one shared connection per process, WAL mode, a busy timeout, and single-row writes. The orchestrator injects a run-bound logger factory because many SDK sessions coexist in one process; the auto-discovered factory disables itself in that host to prevent duplicate records.

## Operations

```bash
pi-usage summary 24h
pi-usage summary 7d --json
pi-usage top 24h 30
pi-usage failures 24h
pi-usage doctor
```

`summary` separates cache reads from non-cache-read tokens plus output and reports HTTP retries and transport diagnostics. `top` identifies outlier session owners without exposing content. `failures` groups request, HTTP, and transport failures without printing raw errors. `doctor` verifies schema, integrity, WAL mode, and unfinished requests.

## Analyses

`analysis/` holds two re-runnable studies over the ledger, kept because both answer questions that recur whenever context or spend is discussed. Each is a plain `python3 analysis/<file>` with no arguments.

- `context-composition.py` regresses reported context tokens on measured session bytes to attribute the context window to reasoning text, opaque reasoning payloads (Anthropic thinking signatures, Codex encrypted reasoning), tool results, and tool-call arguments. The per-message byte buckets in the `request` table exclude tool-call arguments and opaque reasoning, so composition questions need the session JSONL rather than the table alone.
- `compaction-cost-model.py` replays real orchestrator sessions turn by turn under different compaction caps, pricing each turn from `models-store.json` including long-context tiers, and reports spend, prefix tokens processed, and compaction count per cap. Its uncapped column reproduces recorded spend within about 15%, which is the check that the replay is faithful.

A provider request inserted before completion remains unfinished when the process dies. This is deliberate evidence of interruption; requests older than one hour are reported as stale by `doctor`.

## Validation

```bash
node --test /home/kenan/tools/pi-runtime/extensions/pi-usage-logger/logger.test.mjs
/home/kenan/tools/pi-runtime/deploy
pi-usage doctor
```

The test runs a complete synthetic extension lifecycle, verifies request/cache/tool/compaction records, and scans the database to prove test secrets were not persisted.

Set `PI_USAGE_DISABLE=1` only for an intentionally unobserved isolated process. Prompt Eval explicitly loads this content-free logger even when experiment extensions are disabled, while keeping every other global extension out of the isolated case.
