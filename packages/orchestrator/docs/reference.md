# Generated reference

Run `npm run docs --workspace=pi-orchestrator` after changing commands or durable tables.

## Commands

- `daemon`: Run reconciliation and the local API.
- `status`: Print accounts, lanes, leases, and active runs.
- `run`: Start one or more direct sessions.
- `wave`: Start a one-off wave from a declared lane.
- `pause / resume`: Set or clear the global launch halt.
- `abort / kill`: Stop one run gracefully or immediately.
- `boost`: Set a provider pacing multiplier or halt.
- `account`: Import, remove, list, or reserve pooled accounts.

## Durable tables

- `meta`
- `account`
- `meter`
- `control`
- `lane`
- `demand_snapshot`
- `run`
- `lease`
- `live_state`
- `usage_hour`
