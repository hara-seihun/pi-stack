# Agent orchestrator

This is the machine's one path for autonomous Pi task execution. It embeds many independent Pi SDK sessions in one Node process and shares the pinned `ModelRuntime` from [`../package.json`](../package.json).

## Model

There is one concept: a **task**. A task remains eligible until an agent reports that its declared completion condition is satisfied. Every launch is another execution of that same task, not a retry or a scheduler mode.

Tasks may declare:

- a prompt, observable completion condition, and optional machine completion check;
- an exact working directory, model, and thinking level;
- a relative launch share among eligible persistent work;
- an optional time at which it first becomes eligible.

Tasks have no concurrency limit. Every eligible task can receive work whenever the governor admits another agent.

Each agent receives `task_complete`. It must report validated artifacts and whether the task itself is complete. When a machine completion check is configured, `complete=true` is only advisory until that command exits successfully; a failed check records the launch as incomplete. The tool terminates that launch immediately, preventing queued continuations from turning one launch into multiple work units. A productive `complete=false` result restores task eligibility and resets any earlier failure streak unless an idle/error sibling from the same concurrent launch wave has already established a later pause. If no claimable work unit exists, the agent reports `productive=false`; that idle result receives bounded exponential backoff without being mislabeled as an execution error. Provider-turn errors are recorded from Pi's assistant error rather than being misreported as a missing `task_complete`; a genuine launch that ends normally without a completion report receives the same bounded backoff. Only a terminal result whose launch began after the previous eligibility time may update the shared schedule, so late siblings cannot erase or repeatedly advance one wave's pause. There are no standing/scheduled/once/review/retry task types and no priorities.

## Governor

Before every launch, one governor checks:

1. measured whole-machine CPU utilization;
2. measured whole-machine available RAM;
3. measured Codex plan consumption.

There is no numeric agent cap in task state, operator configuration, or the launch interface. The governor alone decides whether another agent fits. It admits at most one new SDK session per five-second measurement tick: session startup and child-tool memory are not visible in the snapshot that precedes them, so filling all calculated slots from one snapshot would create a stale-telemetry launch wave and outrun no-work backoff.

The plan-consumption estimator queries every configured Codex account's five-hour and weekly windows, paces all remaining capacity to each reset, and uses the tighter rate for each account. Every launch is assigned to a concrete account only when that account's own allowance can hold its calibrated active burn plus the candidate. The service disables multi-pass initial spreading so the extension cannot override this governed assignment; runtime rate-limit rotation remains available. Missing or malformed plan evidence fails closed, while an unhealthy or exhausted account receives no launch.

The `chatgpt-pro` provider fail-closes fully assembled, text-only GPT-5.6 mathematical moonshots against authenticated persisted-conversation evidence. Kernel supplies one Pro-routed signed browser profile, so the governor derives capacity from that material entitlement and the provider's one in-flight lease or cooldown. It has no task/operator concurrency number or four-stream circuit. GPT-5.5 is banned by task validation. A live Pi turn on 2026-08-15 proved the full GPT-5.6 Pro invariant end to end; the campaign Pro task remains cancelled solely under operator activation policy. Verified Pro response text is recorded directly in the run ledger; tool-capable models continue to report through `task_complete`. CPU and RAM independently fail closed at their configured utilization thresholds.

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
  --share 2 \
  --prompt-file /home/kenan/project/task.md
orchestrator task set example --model openai-codex/gpt-5.6-sol --thinking xhigh --share 2 --prompt-file /home/kenan/project/revised-task.md --condition 'Exact target is admitted' --completion-check 'python3 verify-target.py'
orchestrator task cancel example
orchestrator task reopen example
```

A fully assembled text-only moonshot uses the same task interface:

```bash
orchestrator task create \
  --id moonshot \
  --cwd /home/kenan/projects-research \
  --model chatgpt-pro/gpt-5-6-pro-literal \
  --thinking max \
  --condition 'Operator cancels after enough verified candidate analyses are recorded.' \
  --prompt-file /home/kenan/projects-research/tasks/assembled-moonshot.md
```

Each verified response is an incomplete persistent-task result, so the governor replenishes the task while account entitlement and machine resources permit. Cancel the task to stop replenishment.

The systemd service is `agent-orchestrator.service`. A planned SIGTERM or restart stops new launches and drains every active SDK session to its normal completion report; it does not call Pi's abort API. The unit allows the drain up to the research lease horizon.

Every autonomous SDK `bash` call uses [`tool-shell`](tool-shell), which runs that invocation in a transient `pi-tools.slice` scope with `MemoryMax=12G`, zero swap, and `OOMPolicy=kill`. An OOM therefore terminates that tool call and returns a failed tool result while the controller and unrelated agent sessions continue. The parent user slice has an aggregate 40G/48G high/max boundary for simultaneous tool scopes. The orchestrator service itself retains `OOMPolicy=continue` as a final containment boundary.

Runtime state is canonical in `/home/kenan/data/agent-orchestrator/orchestrator.sqlite3`; Pi session JSONL is retained under `sessions/`. The SQLite database uses WAL and records tasks, launches, completion reports, whether each launch processed a real work unit, and bounded controller events. Every table has automatic millisecond `created_at` and `updated_at` columns maintained by SQLite triggers; existing rows are backfilled from their original event times.

## Validation

```bash
cd /home/kenan/tools/pi-runtime
npm test
./deploy
orchestrator check
systemctl status agent-orchestrator --no-pager
```
