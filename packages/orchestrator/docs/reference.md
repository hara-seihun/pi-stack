# Generated reference

Run `npm run docs --workspace=pi-orchestrator` after changing commands or durable tables.

## Commands

- `status`: Print provider accounts, leases, and active threads.
- `usage-evidence`: Print a read-only 24-hour quota and token snapshot; optional --ledger FILE.
- `run`: Spawn fresh threads with --prompt TEXT [--model MODEL] [--count N] [--ephemeral[=true|false]] [--background] [--mode live].
- `list`: List threads [--parent ID] [--state STATE] [--limit N] [--cursor CURSOR].
- `read`: Read a thread's native history: THREAD_ID [--limit N] [--cursor CURSOR].
- `send`: Send to THREAD_ID with --prompt TEXT at the next completed-output boundary.
- `close`: Cancel and archive THREAD_ID; subscribers receive cancellation.
- `cancel`: Cancel THREAD_ID's current work without closing its conversation.
- `reopen`: Restore THREAD_ID without resuming interrupted work.
- `dependencies`: Subscribe to peer results: THREAD_ID PEER_ID...; --clear releases them.
- `pause / resume`: Set or clear the global launch halt; --ordinary controls only ordinary work.
- `account`: Import, refresh, inspect capabilities, remove, list, or exclusively transfer pooled accounts.
- `peer`: List configured account-transfer peers.

## Account operations

```text
usage: pi-orchestrator account list | capabilities [ID] | import ID --provider openai-codex|anthropic --credential-file FILE [--label LABEL] | refresh ID | disable ID | enable ID | remove ID | use ID shared|voice | transfer ID --to PEER_OR_SSH_HOST [--wait-for-drain [DURATION]] | fetch ID --from PEER [--wait-for-drain [DURATION]] | transfer-status ID
```

## Durable tables

- `meta`
- `account`
- `meter`
- `control`
- `run`
- `lease`
- `usage_hour`
