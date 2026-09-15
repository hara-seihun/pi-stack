# Generated reference

Run `npm run docs --workspace=pi-orchestrator` after changing commands or durable tables.

## Commands

- `daemon`: Run reconciliation and the local API.
- `status`: Print accounts, lanes, leases, and active threads.
- `usage-evidence`: Print a read-only 24-hour quota and token snapshot; optional --ledger FILE.
- `run`: Spawn fresh threads with --prompt TEXT [--model MODEL] [--count N] [--background].
- `wave`: Spawn a one-off batch from a declared lane [--count N] [--background].
- `list`: List threads [--parent ID] [--state STATE] [--limit N] [--cursor CURSOR].
- `read`: Read a thread's native history: THREAD_ID [--limit N] [--cursor CURSOR].
- `send`: Send to THREAD_ID with --prompt TEXT [--delivery queue|steer|hardSteer]; defaults to steer with PI_THREAD_ID, otherwise queue.
- `stop`: Stop THREAD_ID; --descendants also stops its descendants.
- `pause / resume`: Set or clear the global launch halt; --ordinary controls only ordinary work.
- `resume THREAD_ID`: Release a stopped thread's pending messages.
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
- `usage_hour`
