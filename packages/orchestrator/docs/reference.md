# Generated reference

Run `npm run docs --workspace=pi-orchestrator` after changing commands or durable tables.

## Commands

- `daemon`: Run reconciliation and the local API.
- `status`: Print accounts, lanes, rooms, leases, and active runs.
- `run`: Start one or more direct sessions.
- `wave`: Start a one-off wave from a declared lane.
- `room`: Create, inspect, message, or close a warm room.
- `pause / resume`: Set or clear the global launch halt.
- `abort / kill`: Stop one run gracefully or immediately.
- `boost`: Set a provider pacing multiplier or halt.
- `account`: Import, remove, or list pooled accounts.
- `usage-components`: Transition: record usage tokens per component; delete this command once both hosts have run it.

## Durable tables

- `meta`
- `account`
- `meter`
- `control`
- `lane`
- `demand_snapshot`
- `room`
- `run`
- `lease`
- `message`
- `live_state`
- `usage_hour`
