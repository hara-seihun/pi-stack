# Pi Orchestrator

Pi Orchestrator runs unattended Pi sessions against pooled subscription accounts. One daemon owns policy and SQLite state. Each admitted run gets a separate transient user systemd unit and keeps the release that launched it until the run ends.

## Runtime model

The daemon reconciles four inputs:

- an account registry and fresh provider meter readings;
- a versioned lane manifest;
- one optional demand snapshot command for all dynamic lanes;
- explicit operator requests for direct runs and rooms.

A lane is recurring desired demand. A wave is a one-off launch. A room is a set of warm peer Pi sessions with a durable feed and direct messages. Room members have no hidden hierarchy. A coordinator prompt is only another prompt.

Workers write progress through the daemon's loopback API. Their full context remains in Pi's session JSONL. If a worker process or machine stops, the next worker reopens that same file. The run row records the immutable release path and transient unit name, so a daemon deployment does not replace live workers. Recovery adopts a still-active unit when a daemon restart races the user manager; an already-loaded inactive transient unit restarts from its recorded release instead of being redefined.

## Quota policy

Ordinary work preserves the configured reserve, blocks on stale meters, compares recent usage slope with time to reset, and admits at most one run from each new meter observation. A new account gets one calibration probe before the daemon requires meter evidence. The allocator chooses the least-spent eligible account and counts fleet, interactive, and voice leases against account and machine ceilings.

`run --force`, `wave --force`, and `room create --force` are operator-authorized urgent work. They bypass ordinary pacing but not exhausted provider quota or a provider halt. Provider boost controls multiply ordinary pacing. A multiplier of zero halts that provider.

The routing extension uses the same account registry for interactive Pi sessions. It keeps a session on one account unless that account fails. A response that reaches the provider's output-token limit is continued inside the same Pi run: the provider ended it with `stopReason=length`, so the agent did not choose to stop and the session must not settle there. This is separate from the removed fleet check-ins, which used to restart turns that agents had ended normally. The usage extension aggregates attribution hourly, one row per input, output, cache read, and cache write, and records provider meter headers. Keeping the components apart is what lets `plans()` report the share of prompt tokens a model read from cache over the last 24 hours.

## Configuration

Set paths with:

```text
PI_ORCHESTRATOR_CONFIG
PI_ORCHESTRATOR_LEDGER
PI_ORCHESTRATOR_AUTH
PI_ORCHESTRATOR_HOST
PI_ORCHESTRATOR_PORT
```

The JSON config may set model `profiles`, `backgroundSpendFraction`, machine and account concurrency, meter age, reconciliation periods, stall limits, `taskManifest`, `authPath`, and `agentDir`. The strict `astra` and `opus` profiles are always available alongside configured profiles.

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

The daemon validates the whole snapshot before publishing it. A failed probe reports the error in status and sets every dynamic lane's current demand to zero. It retains the last valid revision only as history. When demand falls, queued workers above the new count are withdrawn before admission.

## Operations

```bash
pi-orchestrator status
pi-orchestrator run --prompt "..." --profile standard
pi-orchestrator wave review --count 3
pi-orchestrator room create --name search --prompt "..." --members 4
pi-orchestrator room add search --members 2 --profile opus
pi-orchestrator room resize search --members 8
pi-orchestrator room message search --message "New evidence" --wake
pi-orchestrator room close search
pi-orchestrator abort RUN_ID
pi-orchestrator kill RUN_ID
pi-orchestrator pause
pi-orchestrator resume
pi-orchestrator boost openai-codex 3
pi-orchestrator account import openai-codex-3 --provider openai-codex --credential-file credential.json
```

`room add` creates additional members immediately and can give them a different profile from the room default. `room resize` changes the room's ongoing membership target; reducing it stops the newest non-coordinator members first.

Import reads credentials from a file so tokens do not enter process arguments. `account remove` disables admission and removes the credential while historical attribution remains intact.

The daemon serves its public API on `127.0.0.1:2460` by default. Pi Remote consumes the package's observation API and does not query private tables.

Generated command and table lists live in [docs/reference.md](docs/reference.md). A fresh ledger gets the current schema directly. A schema change ships as a bounded transition command that is deleted once both hosts have run it, so there is no migration chain to maintain.
