# Agent orchestrator

This is the machine's one path for autonomous Pi task execution. It embeds many independent Pi SDK sessions in one Node process and shares the pinned `ModelRuntime` from [`../package.json`](../package.json).

## Model

There is one concept: a **task**. A task remains eligible until an agent reports that its declared completion condition is satisfied. Every launch is another execution of that same task, not a retry or a scheduler mode.

Tasks may declare:

- a prompt, observable completion condition, and optional machine completion check;
- an optional work-availability probe (`--work-check`);
- an optional pre-launch dispatch command (`--dispatch`);
- an exact working directory, base model, and thinking level;
- a relative launch share among eligible persistent work;
- an optional time at which it first becomes eligible.

Tasks have no concurrency limit. Every eligible task can receive work whenever the governor admits another agent.

A dispatch command inverts launch-and-discover: after the governor admits a launch, the controller runs the command in the task's working directory with `ORCHESTRATOR_RUN_ID` set to the imminent run id. The command atomically claims one work unit under that id and prints a complete context packet on stdout; the controller appends it to the task prompt under `## Dispatched work unit`, so the session's first tokens go to the work instead of claiming and orientation. Exit 1 means nothing was claimable (the task is marked no-work; a dispatch-only task re-probes after a one-minute pause). Any other failure fails open to an ordinary launch and surfaces a throttled `dispatch-error` event. Because the claim's worker id is the run id, project reapers can free work stranded by a launch that ends without a terminal decision. Runs record whether they were dispatched, and `research-bench` tracks the dispatched fraction.

A work check is a cheap command run in the task's working directory that reports whether claimable work exists right now: exit 0 means work exists, exit 1 means none. The controller refreshes each probe on a short cadence (15 s cache) and simply does not launch a task whose probe last reported no work — no agent is spent discovering an empty queue, and no timed backoff must elapse. Because probes also run while a task sits in idle backoff, a no-work→work transition clears that backoff immediately: the arrival of work, not the passage of time, restores eligibility (recorded as a `work-available` event). Any other probe outcome — timeout, crash, unexpected exit code — fails open: the task degrades to ordinary launch-and-discover and the defect is surfaced as a throttled `work-check-error` event, so a broken probe can never silently starve its task. Idle-report backoff remains as the secondary guard when a probe claims work that agents cannot actually claim. `orchestrator status` shows probe-gated tasks as `no-work`, and `task reopen` resets the probe cache for an immediate re-check.

Each agent receives `task_complete`. It must report validated artifacts and whether the task itself is complete. When a machine completion check is configured, `complete=true` is only advisory until that command exits successfully; a failed check records the launch as incomplete. Reporting does not terminate the launch: an agent processes as many claimable work units as it can productively handle in one session and may call `task_complete` again to replace its earlier report; the final report is authoritative. A productive `complete=false` result restores task eligibility and resets any earlier failure streak unless an idle/error sibling from the same concurrent launch wave has already established a later pause. If no claimable work unit exists, the agent reports `productive=false`; that idle result receives bounded exponential backoff without being mislabeled as an execution error. Provider-turn errors are recorded from Pi's assistant error rather than being misreported as a missing `task_complete`; a genuine launch that ends normally without a completion report receives the same bounded backoff. Only a terminal result whose launch began after the previous eligibility time may update the shared schedule, so late siblings cannot erase or repeatedly advance one wave's pause. There are no standing/scheduled/once/review/retry task types and no priorities.

## Governor

Before every launch, one governor checks:

1. measured whole-machine CPU utilization;
2. measured whole-machine available RAM;
3. measured Codex and Anthropic plan consumption.

There is no numeric agent cap in task state, operator configuration, or the launch interface. The governor alone decides whether another agent fits. It admits at most one new SDK session per five-second measurement tick: session startup and child-tool memory are not visible in the snapshot that precedes them, so filling all calculated slots from one snapshot would create a stale-telemetry launch wave and outrun no-work backoff.

The plan-consumption estimator queries every configured Codex account's five-hour and weekly windows, paces all remaining capacity to each reset, and uses the tighter rate for each account. Before trusting usage from a near-expiry access token, it resolves that account through Pi's locked OAuth refresh path; an invalid one-use refresh token therefore removes the account before launch instead of allowing a stale access-token usage check to create a failure loop. It also reads cancellation lifecycle from `~/.pi/agent/multi-pass.json`: a cancelled account remains usable until its exact `accessUntil`, the cached fleet snapshot expires at that deadline, and every later launch excludes it. Provider-reported plans other than paid `pro` or `plus` are independently excluded, so a delayed or changed provider transition also fails closed. `orchestrator governor` exposes configured, retired, and healthy counts plus exact retired provider aliases. Every launch is assigned to a concrete account only when that account's own allowance can hold its calibrated active burn plus the candidate.

A configured model mix makes every `openai-codex/gpt-5.6-sol:xhigh` task a Sol-grade lane that can launch either Sol or `anthropic/claude-opus-5:xhigh` without duplicating task, claim, prompt, or completion custody. The scheduler compares projected active sessions per eligible account, so two Anthropic accounts with headroom and ten healthy Codex accounts converge to one Opus per five Sol; two versus twelve converges to one per six. It uses active allocation rather than lifetime launch history, avoiding stale debt and compensating naturally for different session lengths.

Anthropic Opus admission reads the rolling five-hour window, the shared weekly window consumed by Opus, and the Fable-scoped weekly window used by Claude Code's `/usage`. Its credential-free snapshot is atomically published at `~/data/agent-orchestrator/anthropic-plan-usage.json`, allowing Pi Remote to display these meters without independently rate-limiting the provider endpoint. For each account it admits Opus only while `2 × shared weekly remaining > Fable remaining`; at equality it stops Anthropic launches entirely. Thus 0% Fable used and 50% shared weekly used is the stop point, while 100% Fable used permits Opus to consume the shared weekly window completely. This reserves exactly enough shared capacity for all remaining Fable capacity at Fable's 1:2 shared-meter rate. Exhausted extra-usage credits do not hide untouched subscription capacity. Five-hour or shared-weekly exhaustion still stops admission, snapshots survive bounded endpoint throttling, and at most one active Opus run is assigned to each exact account. The orchestrator service locks Multi-Pass to the governor-assigned provider: hidden runtime rotation cannot corrupt per-account attribution, and a provider failure returns to the controller for observable reassignment.

Missing or malformed lifecycle, plan, usage, or OAuth evidence fails closed for the affected provider while another declared model in the mix remains independently eligible.

The `chatgpt-pro` provider fail-closes fully assembled, text-only GPT-5.6 mathematical moonshots against authenticated persisted-conversation evidence. Kernel browser profiles are admitted individually, and the governor derives capacity from their live logical leases and cooldowns. A billable browser exists only long enough to submit or perform one scheduled persisted-state read: submission browsers close immediately after successful response headers, polling occurs every twenty minutes, every polling browser closes immediately, and Kernel enforces a five-minute safety timeout. By operator request there is a machine-wide ceiling of four simultaneous Pro agents; actual concurrency is lower whenever fewer than four independently authenticated profiles are eligible. GPT-5.5 is banned by task validation. The active oracle-area Pro lane has completed a verified 135-minute turn. Pro runs only as independently governed moonshot lanes; tool-capable frontier agents do not receive an embedded Pro delegation tool. Verified standing-lane response text is recorded directly in the run ledger; tool-capable models continue to report through `task_complete`. CPU and RAM independently fail closed at their configured utilization thresholds.

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
  --work-check 'python3 tools/claimable-work.py' \
  --share 2 \
  --prompt-file /home/kenan/project/task.md
orchestrator task set example --model openai-codex/gpt-5.6-sol --thinking xhigh --share 2 --prompt-file /home/kenan/project/revised-task.md --condition 'Exact target is admitted' --completion-check 'python3 verify-target.py'
orchestrator task set example --work-check 'python3 tools/claimable-work.py'   # '' clears the probe
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

Each verified standing-lane response is an incomplete persistent-task result, so the governor replenishes the task while account entitlement and machine resources permit. Cancel the task to stop replenishment. Nested `launch_pro` calls instead return one verified response to the invoking frontier agent and share the same profile leases and four-agent machine ceiling.

The systemd service is `agent-orchestrator.service`. SIGTERM or restart stops new launches and aborts active SDK sessions through Pi before exiting; persistent tasks and leases make those work units recoverable. This keeps a long Pro turn from holding systemd in `stop-sigterm` and freezing every replacement Sol/Luna launch. The service has a bounded stop timeout as final containment.

Every autonomous SDK `bash` call uses [`tool-shell`](tool-shell), which runs that invocation in a transient `pi-tools.slice` scope with `MemoryMax=12G`, zero swap, and `OOMPolicy=kill`. An OOM therefore terminates that tool call and returns a failed tool result while the controller and unrelated agent sessions continue. The parent user slice has an aggregate 40G/48G high/max boundary for simultaneous tool scopes. The orchestrator reapplies the shell override after resource loading because Pi reloads `SettingsManager` during discovery; the machine-global `shellPath` setting supplies the same boundary to newly created sessions before a controller restart. `tool-shell` resolves the user bus itself when called from a system service. Tests cover override survival and an actual scope-contained OOM. The orchestrator service itself retains `OOMPolicy=continue` as a final containment boundary.

Runtime state is canonical in `/home/kenan/data/agent-orchestrator/orchestrator.sqlite3`; Pi session JSONL is retained under `sessions/`. The SQLite database uses WAL and records tasks, each run's actual model and exact provider assignment, completion reports, whether each launch processed a real work unit and was dispatched, and bounded controller events. `governor-blocked` logging is interval-throttled (details embed live burn numbers, so detail-sensitive throttling would log every tick), and events older than fourteen days are purged on a six-hour cadence. Every table has automatic millisecond `created_at` and `updated_at` columns maintained by SQLite triggers; existing rows are backfilled from their original event times.

## Validation

```bash
cd /home/kenan/tools/pi-runtime
npm test
./deploy
orchestrator check
systemctl status agent-orchestrator --no-pager
```

## The Pro question queue

`orchestrator/pro-questions.mjs` owns the standing GPT-5.6 Pro lane's work:

```bash
node orchestrator/pro-questions.mjs add my-question.md --id my-question
node orchestrator/pro-questions.mjs list
```

A question is one fully-assembled, self-contained, text-only prompt. The
`pro-questions` task claims one question per available Pro entitlement through
its dispatch command; for a Pro task the dispatched packet **is** the literal
prompt. Its work-check gates on both a nonempty queue and an available
entitlement, so no launch is spent when every account is resting. A question
whose run ends without a verified response requeues automatically; a verified
response moves it to `done/` with the run id, and the response text lives in
the run summary and the provider audit trail. Responses are advisory
mathematics: tool-capable campaign agents must validate anything load-bearing.
