# Recurring jobs

Recurring jobs start ordinary Orchestrator threads on a fixed interval. They run inside the Unix person's daemon and use that person's `ThreadService`, model broker, thread database and native session directory. They do not use cron or a second agent runtime.

## Commands

Create a job whose first run starts one hour after creation:

```bash
pi-orchestrator schedule create \
  --id hourly-review \
  --title "Hourly review" \
  --prompt "Review the work queue and handle the highest-impact item." \
  --cwd /home/person/work \
  --every 1h \
  --model sol
```

Use `--start now` for an immediate first run, or pass an ISO 8601 timestamp such as `--start 2026-09-22T09:00:00Z`. Intervals accept `s`, `m`, `h`, or `d` and range from one second through 366 days. `--thinking`, `--speed`, and `--background` use the same settings as `pi-orchestrator run`. The daemon resolves and stores a complete model, thinking and speed selection when it creates the job.

Inspect and control jobs with:

```bash
pi-orchestrator schedule list
pi-orchestrator schedule show hourly-review
pi-orchestrator schedule pause hourly-review
pi-orchestrator schedule resume hourly-review
pi-orchestrator schedule remove hourly-review --yes
```

Pause stops new occurrences without cancelling a thread that already started. Resume keeps the existing interval. Removal requires `--yes`, deletes the definition and occurrence records, and leaves previously created thread history intact.

## Execution behavior

Each occurrence creates a fresh unparented thread. Its metadata records the schedule ID and intended occurrence time. A job never starts another occurrence while its previous thread is running or has pending input.

The scheduler stores an occurrence before asking `ThreadService` to spawn it. The occurrence uses deterministic request and thread IDs. A daemon restart therefore retries the same request instead of duplicating work. Transport failures leave the occurrence pending. A terminal spawn rejection pauses the job and records the error for inspection.

Catch-up is bounded to one run. If several intervals pass during downtime or a long execution, reconciliation starts only the latest missed occurrence and advances `nextRunAt` to the first future boundary. It does not replay every missed interval.

Definitions and occurrences live in `recurring_schedule` and `schedule_occurrence` inside the person's `threads.sqlite3`. `nextRunAt`, accepted thread identity, pause state and errors survive daemon restarts.
