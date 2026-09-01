# Pi Orchestrator

Pi Orchestrator runs unattended Pi sessions against pooled subscription accounts. One daemon owns policy and SQLite state. Each admitted run gets a separate transient user systemd unit and keeps the release that launched it until the run ends.

## Runtime model

The daemon reconciles four inputs:

- an account registry and fresh provider meter readings;
- a versioned lane manifest;
- one optional demand snapshot command for all dynamic lanes;
- explicit operator requests for direct runs and rooms.

A lane is recurring desired demand. A wave is a one-off launch. A room is a set of warm peer Pi sessions with a durable feed and direct messages. Room members have no hidden hierarchy. A coordinator prompt is only another prompt.

Workers write progress through the daemon's loopback API. Their full context remains in Pi's session JSONL. If a worker process or machine stops, the next worker reopens that same file. The run row records the immutable release path and transient unit name, so a daemon deployment does not replace live workers.

## Quota policy

Ordinary work preserves the configured reserve, blocks on stale meters, compares recent usage slope with time to reset, and admits at most one run from each new meter observation. A new account gets one calibration probe before the daemon requires meter evidence. The allocator chooses the least-spent eligible account and counts fleet, interactive, and voice leases against account and machine ceilings.

`run --force`, `wave --force`, and `room create --force` are operator-authorized urgent work. They bypass ordinary pacing but not exhausted provider quota or a provider halt. Provider boost controls multiply ordinary pacing. A multiplier of zero halts that provider.

The routing extension uses the same account registry for interactive Pi sessions. It keeps a session on one account unless that account fails. The usage extension aggregates attribution hourly and records provider meter headers.

## Configuration

Set paths with:

```text
PI_ORCHESTRATOR_CONFIG
PI_ORCHESTRATOR_LEDGER
PI_ORCHESTRATOR_AUTH
PI_ORCHESTRATOR_HOST
PI_ORCHESTRATOR_PORT
```

The JSON config may set model `profiles`, `backgroundSpendFraction`, machine and account concurrency, meter age, reconciliation periods, stall limits, `taskManifest`, `authPath`, and `agentDir`.

A lane manifest has `version: 2`, an optional `snapshotCommand`, and a `lanes` array. Every lane declares `id`, `prompt`, `cwd`, `profile`, and positive `weight`. `fixedDemand` makes demand static. The snapshot command prints one atomic object:

```json
{
  "revision": "business-state-version",
  "lanes": {
    "review": { "count": 2, "priority": 20 },
    "publication": { "count": 1 }
  }
}
```

The daemon validates the whole snapshot before publishing it. A failed snapshot keeps the last valid revision and reports the error in status.

## Operations

```bash
pi-orchestrator status
pi-orchestrator run --prompt "..." --profile standard
pi-orchestrator wave review --count 3
pi-orchestrator room create --name search --prompt "..." --members 4
pi-orchestrator room message search --message "New evidence" --wake
pi-orchestrator room close search
pi-orchestrator abort RUN_ID
pi-orchestrator kill RUN_ID
pi-orchestrator pause
pi-orchestrator resume
pi-orchestrator boost openai-codex 3
pi-orchestrator account import openai-codex-3 --provider openai-codex --credential-file credential.json
```

Import reads credentials from a file so tokens do not enter process arguments. `account remove` disables admission and removes the credential while historical attribution remains intact.

The daemon serves its public API on `127.0.0.1:2460` by default. Pi Remote consumes the package's observation API and does not query private tables.

Generated command and table lists live in [docs/reference.md](docs/reference.md). The current schema is created directly. Production upgrades use a bounded transition executable, verify the result, and then delete transition code rather than keeping a migration chain.
