# Agent orchestrator

This is the machine's one path for autonomous Pi task execution. It embeds many independent Pi SDK sessions in one Node process and shares the pinned `ModelRuntime` from [`../package.json`](../package.json).

## Model

There is one concept: a **task**. A task remains eligible until an agent reports that its declared completion condition is satisfied. Every launch is another execution of that same task, not a retry or a scheduler mode.

Tasks may declare:

- a prompt and observable completion condition;
- an exact working directory, model, and thinking level;
- maximum concurrent launches;
- a relative launch share among eligible persistent work;
- an optional time at which it first becomes eligible.

Each agent receives `task_complete`. It must report validated artifacts and whether the task itself is complete. An incomplete result leaves the task eligible after bounded backoff. There are no standing/scheduled/once/review/retry task types and no priorities.

## Governor

Before each launch one governor checks:

1. the operator concurrency cap;
2. available RAM and CPU load;
3. current Codex subscription headroom against explicit measured model burn rates.

Missing or stale quota evidence blocks launching visibly; it never selects a fallback model. Pi's configured provider runtime owns account authentication and routing.

## Operations

```bash
orchestrator check
orchestrator status
orchestrator runs [TASK_ID]
orchestrator task show TASK_ID
orchestrator task create \
  --id example \
  --cwd /home/kenan/project \
  --model openai-codex/gpt-5.6-luna \
  --thinking max \
  --condition 'All imported records pass the project verifier.' \
  --max-parallel 4 \
  --share 2 \
  --prompt-file /home/kenan/project/task.md
orchestrator task set example --max-parallel 8 --share 2
orchestrator task cancel example
orchestrator task reopen example
```

The systemd service is `agent-orchestrator.service`. Runtime state is canonical in `/home/kenan/data/agent-orchestrator/orchestrator.sqlite3`; Pi session JSONL is retained under `sessions/`. The SQLite database uses WAL and records tasks, launches, completion reports, and bounded controller events.

## Validation

```bash
cd /home/kenan/tools/pi-runtime
npm test
./deploy
orchestrator check
systemctl status agent-orchestrator --no-pager
```
