# Pi Orchestrator

Pi Orchestrator runs unattended Pi sessions against pooled subscription accounts. One daemon owns policy and SQLite state. Each admitted run gets a separate transient user systemd unit and keeps the release that launched it until the run ends.

## Runtime model

The daemon reconciles provider meters, weighted lanes, optional queue readiness, and explicit requests for direct runs.

A lane has a positive weight, not a worker target. Available quota determines fleet size; weights divide that capacity among eligible lanes. A wave remains a one-off batch, not a standing target. Each run ends when its agent finishes its turn.

Workers write progress through the daemon's loopback API. Their full context remains in Pi's session JSONL. If a worker process or machine stops, the next worker reopens that same file. The run row records the immutable release path and transient unit name, so a daemon deployment does not replace live workers. Recovery adopts a still-active unit when a daemon restart races the user manager; an already-loaded inactive transient unit restarts from its recorded release instead of being redefined.

## Quota policy

Ordinary work must stay within the elapsed share of each provider window's allowance, including the configured reserve. A whole-percentage-point tolerance accounts for provider rounding. Every binding meter must be fresh. A flat pair of readings cannot erase earlier overspending.

The account concurrency ceiling also uses up to six hours of same-window consumption divided by recorded session-hours, with one percentage point added for meter uncertainty. Meter history is retained for 24 hours rather than a fixed sample count. At least 15 minutes of evidence is required to move beyond one calibration session. Fleet, interactive, and voice leases share the account and machine ceilings. New work consumes at most one admission per meter observation.

Every reconciliation applies these ceilings to running workers as well as admissions. Excess workers receive an abort through the existing worker control API, save their interrupted turn, and exit. An unresponsive worker is stopped after 15 seconds. The ledger retains a `suspend:<run-id>` control with the reason and time; leases remain charged until the worker acknowledges its checkpoint or exits. A restart preserves these holds. When quota permits, the daemon reopens the same run, account, release, and Pi JSONL before creating a replacement for that lane. Paused time does not count as a stall.

`status` exposes calculated account ceilings and reasons, plus each lane's active and paused counts. Pi Remote reports held sessions as paused and excludes them from its running total.

`run --force` and `wave --force` are operator-authorized urgent work. They bypass ordinary pacing but not exhausted provider quota or a provider halt. Provider boost controls multiply ordinary pacing. A multiplier of zero halts that provider.

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

A lane manifest has `version: 2` and a `lanes` array. Every lane declares `id`, `prompt`, `cwd`, `profile`, and positive `weight`. Unknown fields are rejected, including worker targets.

Without a `snapshotCommand`, lanes are continuously eligible. An optional command reports whether each queue has unclaimed work, never how many workers to run:

```json
{
  "revision": "business-state-version",
  "lanes": {
    "review": { "ready": true },
    "publication": { "ready": false }
  }
}
```

The daemon validates the whole readiness snapshot. A missing lane or failed probe prevents new work in that lane without interrupting its already-assigned sessions. A readiness observation permits at most one launch per lane before the next 30-second refresh, allowing the worker to claim its task. Numerical counts are rejected. Lanes do not preallocate worker queues.

## Operations

```bash
pi-orchestrator status
pi-orchestrator run --prompt "..." --profile standard
pi-orchestrator wave review --count 3
pi-orchestrator abort RUN_ID
pi-orchestrator kill RUN_ID
pi-orchestrator pause
pi-orchestrator resume
pi-orchestrator boost openai-codex 3
pi-orchestrator account import openai-codex-3 --provider openai-codex --credential-file credential.json
```

`pi-orchestrator account use ID voice` reserves a Codex account for GPT Live. Fleet admission, including forced and pinned runs, and interactive routing exclude it. Pi Remote uses the reserved voice accounts when any are enabled; otherwise it uses shared Codex accounts. `account use ID shared` returns it to the shared pool. The reservation lives in the ledger's `control` table under `account-use:ID` and appears as `use` in account listings. Existing runs are not killed by this command; stop them with `kill RUN_ID` after reserving the account. Interactive sessions move off a reserved account before their next turn.

Import reads credentials from a file so tokens do not enter process arguments. `account remove` disables admission and removes the credential while historical attribution remains intact.

The daemon serves its public API on `127.0.0.1:2460` by default. Pi Remote consumes the package's observation API and does not query private tables.

Generated command and table lists live in [docs/reference.md](docs/reference.md). A fresh ledger gets the current schema directly. A schema change ships as a bounded transition command that is deleted once both hosts have run it, so there is no migration chain to maintain.
