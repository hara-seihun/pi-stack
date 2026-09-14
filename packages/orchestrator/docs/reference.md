# Generated reference

Run `npm run docs --workspace=pi-orchestrator` after changing commands or durable tables.

## Commands

- `daemon`: Run reconciliation and the local API.
- `status`: Print accounts, lanes, leases, and active runs.
- `usage-evidence`: Print a read-only 24-hour quota and token snapshot; optional --ledger FILE.
- `run`: Start one or more direct sessions.
- `wave`: Start a one-off wave from a declared lane.
- `pause / resume`: Set or clear the global launch halt; --ordinary controls only ordinary work.
- `abort / kill`: Stop one run gracefully or immediately.
- `recover`: Recover a core run interrupted by loss of its hosting worker.
- `resume RUN_ID`: Manually resume a rate-limited core run in its recorded session.
- `boost`: Set a provider pacing multiplier or halt.
- `account`: Import, refresh, remove, list, reserve, or exclusively transfer pooled accounts.

## Account operations

```text
usage: pi-orchestrator account list | import ID --provider openai-codex|anthropic --credential-file FILE [--label LABEL] [--concurrency N] | refresh ID | disable ID | enable ID | remove ID | use ID shared|voice | transfer ID --to SSH_HOST | transfer-status ID | reserve ID --metadata JSON --reason TEXT | unreserve ID | reservation ID
```

## Durable tables

- `meta`
- `account`
- `meter`
- `control`
- `lane`
- `run`
- `lease`
- `live_state`
- `usage_hour`
