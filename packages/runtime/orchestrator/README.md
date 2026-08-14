# Agent orchestrator

This is the machine's one path for autonomous Pi task execution. It embeds many independent Pi SDK sessions in one Node process and shares the pinned `ModelRuntime` from [`../package.json`](../package.json).

## Model

There is one concept: a **task**. A task remains eligible until an agent reports that its declared completion condition is satisfied. Every launch is another execution of that same task, not a retry or a scheduler mode.

Tasks may declare:

- a prompt, observable completion condition, and optional machine completion check;
- an exact working directory, model, and thinking level;
- maximum concurrent launches;
- a relative launch share among eligible persistent work;
- an optional time at which it first becomes eligible.

Each agent receives `task_complete`. It must report validated artifacts and whether the task itself is complete. When a machine completion check is configured, `complete=true` is only advisory until that command exits successfully; a failed check records the launch as incomplete. The tool terminates that launch immediately, preventing queued continuations from turning one launch into multiple work units. A productive `complete=false` result immediately restores task eligibility and resets any failure streak; a launch that ends without a completion report receives bounded exponential backoff. There are no standing/scheduled/once/review/retry task types and no priorities.

## Governor

Before launching a bounded batch, one governor checks:

1. the operator emergency concurrency cap;
2. measured whole-machine CPU utilization;
3. measured whole-machine available RAM;
4. Codex subscription headroom when that check is enabled.

The production resource thresholds admit agents until either CPU or RAM reaches 90%. The emergency cap is deliberately far above expected resource capacity and is not the normal limiter. Quota admission is currently disabled by explicit operator configuration; when enabled, missing quota evidence blocks launching visibly and never selects a fallback model. Pi's configured provider runtime owns account authentication and routing.

## Operations

```bash
orchestrator check
orchestrator governor
orchestrator status
orchestrator runs [TASK_ID]
orchestrator task show TASK_ID
orchestrator task create \
  --id example \
  --cwd /home/kenan/project \
  --model openai-codex/gpt-5.6-luna \
  --thinking max \
  --condition 'All imported records pass the project verifier.' \
  --completion-check 'python3 tools/verify-complete.py' \
  --max-parallel 4 \
  --share 2 \
  --prompt-file /home/kenan/project/task.md
orchestrator task set example --model openai-codex/gpt-5.6-sol --thinking xhigh --max-parallel 8 --share 2 --prompt-file /home/kenan/project/revised-task.md
orchestrator task cancel example
orchestrator task reopen example
```

The systemd service is `agent-orchestrator.service`. Runtime state is canonical in `/home/kenan/data/agent-orchestrator/orchestrator.sqlite3`; Pi session JSONL is retained under `sessions/`. The SQLite database uses WAL and records tasks, launches, completion reports, and bounded controller events. Every table has automatic millisecond `created_at` and `updated_at` columns maintained by SQLite triggers; existing rows are backfilled from their original event times.

## Validation

```bash
cd /home/kenan/tools/pi-runtime
npm test
./deploy
orchestrator check
systemctl status agent-orchestrator --no-pager
```
