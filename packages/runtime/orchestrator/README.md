# Agent orchestrator

This is the machine's one path for autonomous Pi task execution. It embeds many independent Pi SDK sessions in one Node process and shares the pinned `ModelRuntime` from [`../package.json`](../package.json).

That process is an **agent host**, and it is deliberately not the controller. The controller decides launches and owns the SQLite ledger; agent hosts own the sessions and run as transient user services under `pi-agents.slice`. Restarting or redeploying the controller therefore adopts running agents instead of ending them.

## Agent hosts

One host holds every session of its code generation. This is load-bearing: a peak wave is hundreds of simultaneous agents — the system is expected to reach roughly 700 — and one Node process per agent would cost an order of magnitude more memory than the machine has. Sessions share one process, one `ModelRuntime`, and one extension load; the host is the unit of code generation, not the unit of agent.

A host is pinned to a **code fingerprint**: a hash of the orchestrator sources, provider manifest, pinned runtime manifest/lockfile, and loaded extensions. The controller keeps exactly one host accepting launches per fingerprint:

- a live host whose fingerprint matches is the current host;
- a live host whose fingerprint differs is marked `draining` — it keeps its sessions, claims nothing new, and exits once empty;
- if no current host exists, the controller starts one and launches wait one or two ticks for it.

The entire control plane is this ledger, not IPC. A host claims `pending` runs addressed to it, heartbeats itself and its runs, honours an operator abort recorded on a run, and self-retires when idle (ten minutes normally, five seconds while draining). Because control is data, a host started by an earlier controller incarnation — running earlier code — remains fully governable by the replacement, and a controller crash cannot end a single agent.

Liveness is a heartbeat plus, only for an already-stale row, one bounded `systemctl --user is-active` check, so a host paused under heavy load is never mistaken for a dead one. A host that really stopped without retiring has its runs interrupted and its quota handed back for the restart window. A `pending` run that no host claims within three minutes is interrupted the same way.

`pi-agents.slice` is declared in `/etc/nixos/configuration.nix` and inherits the exact memory boundary this session population already had inside the controller; a tighter bound would be a new binding limit whose OOM victim is a host holding every session of its generation. The controller itself keeps a much smaller bound because it no longer holds sessions, and agent tool calls remain in `pi-tools.slice`, so the agent slice covers session context rather than child computations. Resource governing sums the controller cgroup and the agent slice — derived from the slice's nested cgroup path, since systemd reads each dash in `pi-agents.slice` as a level — so admission still measures every agent.

## Observation streams

Each run gets an append-only transcript at `~/data/agent-orchestrator/runs/<run-id>/events.jsonl`: the dispatched prompt, thinking, assistant messages, timed tool calls with bounded output, notices, and a terminal `settled` entry. Appends are buffered per run, so hundreds of simultaneous agents cost one buffered write per active run.

Partial (pre-message) output is **demand-driven**. A reader touches `watch` in the run directory; only while that marker is fresh does the host publish `live.json` with the current activity, live text, live thinking, and active tools. Nobody watching costs nothing. Pi Remote is the reader: see [its agent observation surface](../../../projects/pi-remote/README.md). Streams are purged with the fourteen-day event retention.

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

[`providers.json`](providers.json) is the single declaration of provider prefixes and governor adapters, model IDs/thinking/labels, mixed-model alternatives, agent display order, and plan-card metrics. Adding a model or recombining an existing provider adapter is a manifest edit rather than coordinated scheduler and client edits. A genuinely new quota protocol still requires one meter adapter, but it feeds the same adaptive launch algorithm and manifest-driven clients.

A dispatch command inverts launch-and-discover: after the governor admits a launch, the controller records an active lifecycle reservation, runs the command in the task's working directory with `ORCHESTRATOR_RUN_ID` set to the imminent run id, then atomically transfers that reservation into the running launch. The command atomically claims one work unit under that id and prints a complete context packet on stdout; the controller appends it to the task prompt under `## Dispatched work unit`, so the session's first tokens go to the work instead of claiming and orientation. Exit 1 means nothing was claimable (the unused reservation is removed and the task is marked no-work; a dispatch-only task re-probes after a one-minute pause). Any other failure terminalizes the reservation, fails open to an ordinary launch, and surfaces a throttled `dispatch-error` event. Because the claim's worker id is the reserved run id, project reapers can free work whenever dispatch aborts or the eventual launch ends, without a wall-clock lease deadline. Runs record whether they were dispatched, and `research-bench` tracks the dispatched fraction.

A work check is a cheap command run in the task's working directory that reports whether claimable work exists right now: exit 0 means work exists, exit 1 means none. The controller refreshes each probe on a short cadence (15 s cache) and simply does not launch a task whose probe last reported no work — no agent is spent discovering an empty queue, and no timed backoff must elapse. Because probes also run while a task sits in idle backoff, a no-work→work transition clears that backoff immediately: the arrival of work, not the passage of time, restores eligibility (recorded as a `work-available` event). Any other probe outcome — timeout, crash, unexpected exit code — fails open: the task degrades to ordinary launch-and-discover and the defect is surfaced as a throttled `work-check-error` event, so a broken probe can never silently starve its task. Idle-report backoff remains as the secondary guard when a probe claims work that agents cannot actually claim. `orchestrator status` shows probe-gated tasks as `no-work`, and `task reopen` resets the probe cache for an immediate re-check.

Each agent receives `task_complete`. It must report validated artifacts and whether the task itself is complete. When a machine completion check is configured, `complete=true` is only advisory until that command exits successfully; a failed check records the launch as incomplete. Reporting does not terminate the launch: an agent processes as many claimable work units as it can productively handle in one session and may call `task_complete` again to replace its earlier report; the final report is authoritative. A productive `complete=false` result restores task eligibility and resets any earlier failure streak unless an idle/error sibling from the same concurrent launch wave has already established a later pause. If no claimable work unit exists, the agent reports `productive=false`; that idle result receives bounded exponential backoff without being mislabeled as an execution error. Provider-turn errors are recorded from Pi's assistant error rather than being misreported as a missing `task_complete`; a genuine launch that ends normally without a completion report receives the same bounded backoff. Only a terminal result whose launch began after the previous eligibility time may update the shared schedule, so late siblings cannot erase or repeatedly advance one wave's pause. There are no standing/scheduled/once/review/retry task types and no priorities.

## Governor

Before every launch, one governor checks:

1. measured whole-machine CPU utilization;
2. measured whole-machine available RAM;
3. measured consumption for every metered provider declared in the provider manifest.

There is no numeric agent cap in task state, operator configuration, or the launch interface. The governor alone decides whether another agent fits. Codex, Anthropic, and Cursor all call the single `DistributedQuotaFeedback.adaptiveAssignment()` implementation for load summation, sustainable allowance, fractional cold admission, account selection, and pressure; provider adapters only normalize credentials, meters, eligible accounts, and burn estimates. It admits at most one new SDK session per five-second measurement tick: session startup and child-tool memory are not visible in the snapshot that precedes them, so filling all calculated slots from one snapshot would create a stale-telemetry launch wave and outrun no-work backoff.

Every installation queries each configured Codex account independently and controls only its own launches from the shared provider meters; installations exchange no census, process state, or coordinator messages. The controller paces each binding provider window to 100% at its exact reset time, keeps a private adaptive share for every exact account, and updates that share from the ratio between sustainable burn and observed aggregate burn. Account-local shares make partially overlapping pools valid: an account present on one machine converges toward a full local share, while an account present on several machines divides itself through common meter feedback. Genuinely new cold capacity uses a private bounded permit rather than granting one unconditional worker per machine. Once admitted, Sol, Opus, and Cursor Grok capacity becomes a durable, bounded quota lease in SQLite. A short controller restart restores the interrupted task/model/account assignment one-for-one after fresh raw-headroom and account-local sensor-circuit checks. An interrupted governor lease that cannot be restored safely immediately returns to its model lane without its task/account pin, allowing healthy cold capacity to proceed instead of blocking the scheduler; task-scoped operator grants remain pinned. After a productive session boundary, the lease returns to its model lane without a task or account pin, so durable weighted launch age rotates scarce serial capacity across eligible responsibilities instead of repeatedly relaunching one task. Task-scoped operator grants remain pinned to their declared task and provider. Local predicted burn that does not appear in the provider meter trips a fail-closed consistency circuit. A later real meter advance clears that circuit. Provider windows without a reported reset timestamp are treated as rolling meters: monotone utilization advances remain comparable even though their synthetic pacing deadline moves at every poll, while a utilization decrease starts a new baseline. Anthropic's countdown-derived reported reset boundaries are normalized to their intended minute because its endpoint legitimately alternates by one second; without that normalization, real monotone usage would appear to belong to a new window on every poll.

Sol and Luna retain conservative configured burn priors, but private balanced routing excitation across independently metered accounts accumulates an instrumental-variable estimate for every model/thinking pair. Allocation and calibration carry independent schema versions, so invalidating a poisoned estimator cannot erase healthy account shares. Unknown reporting delay is selected over a bounded lag window, and admission uses the larger of the configured prior and the learned two-standard-error upper confidence bound. Quantized meter noise cannot activate a learned coefficient before 2,000 observations spanning at least five days (roughly one full week at the simulator's five-minute cadence), and the estimator learns a multiplier on the configured burn prior rather than confusing that dimensionless multiplier with percentage points per hour. Routing excitation is zero-sum across each machine's available accounts, so it changes attribution information without increasing average work. Controller state and private seeds live in `~/data/agent-orchestrator/codex-distributed-governor.json`; incompatible state versions reset conservatively, and `orchestrator governor` reads that state without mutating it.

Before trusting usage from a near-expiry access token, the governor resolves that account through Pi's locked OAuth refresh path; an invalid one-use refresh token therefore removes the account before launch instead of allowing a stale access-token usage check to create a failure loop. It also reads cancellation lifecycle from `~/.pi/agent/multi-pass.json`: a cancelled account remains usable until its exact `accessUntil`, the cached fleet snapshot expires at that deadline, and every later launch excludes it. Provider-reported plans other than paid `pro` or `plus` are independently excluded, so a delayed or changed provider transition also fails closed.

The manifest's model mix makes every `openai-codex/gpt-5.6-sol:xhigh` task a Sol-grade lane that can launch Sol, `anthropic/claude-opus-5:xhigh`, or Cursor Grok 4.6 (`cursor/grok-4.6:xhigh`) without duplicating task, claim, prompt, or completion custody. There is no model ratio: all provider gates evaluate every candidate independently, and the admitted provider with the lowest projected consumption-to-allowance pressure runs the task. Cursor's `-max` alias is deliberately not used because its live catalog has the same 256K context and effort parameters as ordinary Grok 4.6. Cursor reserves the final 2% of included plan usage and derives capacity continuously from usage remaining, time to billing reset, active predicted burn, observed meter movement, and the same private adaptive-share and frozen-meter circuit used by the other metered providers. It has no configured parallel-agent count. Missing OAuth, model-catalog, paid-plan, usage, or meter-consistency evidence closes only the Cursor gate while Sol and Opus remain independently eligible.

Anthropic Opus admission reads the common rolling five-hour meter, the common weekly meter consumed by both models, and Fable's additional half-sized weekly meter. Autonomous runs never use Fable; interactive Fable is external demand visible in both common meters. The governor reads `/api/oauth/profile` and records each account's authoritative `rate_limit_tier` plus an explicit weekly-capacity weight: Max 5x is `1` and Max 20x is `2`. Other tiers fail closed because their weekly scaling has not been established. Its credential-free snapshot is atomically published at `~/data/agent-orchestrator/anthropic-plan-usage.json`, allowing Pi Remote to display weekly-capacity-weighted meters without independently rate-limiting the provider endpoint.

For each account it admits Opus only while `2 × shared weekly remaining > Fable remaining`; at equality it stops Opus on that account. Thus Fable-only use can put Fable at 100% and shared weekly at 50%, while Opus-only use can put shared weekly at 100% and Fable at 0%. The controller reserves the shared capacity needed to finish all remaining Fable allowance, and independently applies decentralized meter feedback to the shared five-hour and weekly resources. Opus admission compares its configured percentage-point burn per active hour directly with Anthropic's sustainable burn allowance; Sol activity does not enter that calculation. Private per-account shares prevent two noncommunicating orchestrators from each claiming the whole Anthropic pool. State lives in `~/data/agent-orchestrator/anthropic-distributed-governor.json`. Exhausted extra-usage credits do not hide untouched subscription capacity, and snapshots survive bounded endpoint throttling. Opus has no fixed per-account concurrency ceiling: like Codex, each account admits repeated launches while aggregate predicted local burn fits its decentralized metered allowance. The orchestrator service locks Multi-Pass to the governor-assigned provider: hidden runtime rotation cannot corrupt attribution, and a provider failure returns to the controller for observable reassignment.

Missing or malformed lifecycle, plan, usage, or OAuth evidence fails closed for the affected provider while another declared model in the mix remains independently eligible.

Each installation also owns persistent OpenAI and Anthropic allowance controls in its local orchestrator SQLite ledger. Normal mode is `1×`. Boosted mode multiplies that installation's final decentralized allowance and sustainable-rate target by `5×`; it does not disable raw quota headroom, OAuth, consistency, CPU/RAM, per-account, or model-policy gates. The setting is machine-local, so changing GMKtec does not change `converge-kenan`. Pi Remote's web and Android drawers operate the GMKtec settings directly.

The `chatgpt-pro` provider fail-closes fully assembled, text-only GPT-5.6 mathematical moonshots against authenticated persisted-conversation evidence. Kernel browser profiles are admitted individually, and the governor derives capacity from their live logical leases and cooldowns. A billable browser exists only long enough to submit or perform one scheduled persisted-state read: submission browsers close immediately after successful response headers, polling occurs every twenty minutes, every polling browser closes immediately, and Kernel enforces a five-minute safety timeout. By operator request there is a machine-wide ceiling of four simultaneous Pro agents; actual concurrency is lower whenever fewer than four independently authenticated profiles are eligible. GPT-5.5 is banned by task validation. The active oracle-area Pro lane has completed a verified 135-minute turn. Pro runs only as independently governed moonshot lanes; tool-capable frontier agents do not receive an embedded Pro delegation tool. Verified standing-lane response text is recorded directly in the run ledger; tool-capable models continue to report through `task_complete`. CPU and RAM independently fail closed at their configured utilization thresholds.

## Operations

```bash
orchestrator check
orchestrator governor
orchestrator governor-control status
orchestrator governor-control set openai on
orchestrator governor-control set anthropic off
orchestrator status
orchestrator quota list
orchestrator quota grant --provider openai-codex-3 --model openai-codex/gpt-5.6-sol --thinking xhigh --hours 2
orchestrator quota grant --provider cursor --model cursor/grok-4.6 --thinking xhigh --hours 2
orchestrator quota revoke LEASE_ID
orchestrator runs [TASK_ID]
orchestrator agents            # live hosts, their code generation, and every running agent
orchestrator agent stop RUN_ID # ask the owning host to abort one agent
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

The systemd service is `agent-orchestrator.service`. SIGTERM or restart stops new launches and exits; it does **not** touch agent hosts, so every running agent keeps working, writes its own result into this ledger, and is adopted by the replacement controller. A deployment that changes code starts a fresh host generation and lets the superseded one drain as it empties. Interrupting an agent is now an explicit act: `orchestrator agent stop RUN_ID` records the request and its host aborts that session, and stopping a host unit aborts only its own sessions. Persistent tasks still make work units recoverable, and a genuinely lost host's active quota leases become short-lived handoffs that restore recently established provider occupancy. Operator quota grants use the same bounded lease path, remain subject to exact-account raw headroom and consistency circuits, and are visible/revocable through `orchestrator quota`; they are explicit capacity assertions, not an unconditional cold-start baseline. Because a long Pro turn now lives in a host rather than the controller, it can never hold systemd in `stop-sigterm` and freeze replacement Sol/Luna launches. The service has a bounded stop timeout as final containment. `PI_RUNTIME_SKIP_RESTART=1 ./deploy` validates and installs source without disrupting the running controller; systemd masking is not a substitute because an enabled masked unit still reports enabled on these hosts. On `converge-kenan`, `agent-orchestrator-keeper.service` uses systemd `Upholds=` to restore the controller after an ordinary stop; a maintenance window must stop the keeper and controller together, then start the keeper to resume normal operation.

Every autonomous SDK `bash` call uses [`tool-shell`](tool-shell), which runs that invocation in a transient `pi-tools.slice` scope with `MemoryMax=12G`, zero swap, `OOMPolicy=kill`, and `RuntimeMaxSec=3600`. An OOM or an exhausted wall-clock ceiling therefore terminates that tool call and returns a failed tool result while its agent host, the controller, and unrelated agent sessions continue. Raise the ceiling for a genuinely long build with `PI_TOOL_TIMEOUT_SECONDS`; the ceiling exists so no single command can hold an agent lane and its share of the tool slice indefinitely, and does not replace the far tighter per-command timeouts agents set themselves. The parent user slice has an aggregate 24-core CPU quota and 40G/48G memory high/max boundary for simultaneous tool scopes, preserving eight logical CPUs for agents and host services. The command guard treats processes remaining after the command shell exits as an invalid detached job, terminates them inside their existing scope, and fails the tool call; durable background work must instead be an owned systemd service or orchestrator task. The orchestrator reapplies the shell override after resource loading because Pi reloads `SettingsManager` during discovery; the machine-global `shellPath` setting supplies the same boundary to newly created sessions before a controller restart. `tool-shell` resolves the user bus itself when called from a system service, restarts an unavailable owning user manager, and thaws a shared tool slice left frozen by a malformed diagnostic before launching the next scope. Tests cover override survival, transient-bus recovery, frozen-slice recovery, detached-job rejection, and an actual scope-contained OOM. The orchestrator service itself retains `OOMPolicy=continue` as a final containment boundary.

Runtime state is canonical in `/home/kenan/data/agent-orchestrator/orchestrator.sqlite3`; its `governor_control` rows own the machine-local `1×`/`5×` provider settings, and its `agent_host` rows plus each run's `host_id`/`host_state`/`heartbeat_at` own host custody and launch delivery. Pi session JSONL is retained under `sessions/`, and read-only observation transcripts under `runs/`. The SQLite database uses WAL and records tasks, each run's actual model and exact provider assignment, completion reports, whether each launch processed a real work unit and was dispatched, and bounded controller events. `governor-blocked` logging is interval-throttled (details embed live burn numbers, so detail-sensitive throttling would log every tick), and events older than fourteen days are purged on a six-hour cadence. Every table has automatic millisecond `created_at` and `updated_at` columns maintained by SQLite triggers; existing rows are backfilled from their original event times.

## Distributed-governor simulator

[`distributed-governor-simulator.mjs`](distributed-governor-simulator.mjs) tests quota control and causal attribution when an unknown number of machines share all or part of an account pool but exchange no runtime state. It contains three experiments:

- shared-meter feedback tests whether every installation independently scaling against the same aggregate burn keeps quota consumption paced to reset;
- private, balanced account-routing instruments test whether one installation can recover model costs and its own contribution from quantized per-account meters while every other installation is latent noise, including the deployed twelve-account/six-account overlap;
- coupled Anthropic simulations test Max 5x/20x accounts, common five-hour consumption, shared weekly Opus/Fable consumption, Fable's half-sized independent weekly limit, external interactive Fable bursts, and autonomous Opus from two to twenty hosts.

The control experiment deliberately shows that a single integer aggregate meter can govern total burn but cannot practically attribute model costs. The calibration experiment adds zero-sum routing excitation across the independently metered accounts, pooling enough equations to recover the expected two-machine case without consuming extra quota.

The adversarial suite includes arrivals and departures, synchronized bursts, changing model costs, delayed and missing meter updates, hidden non-Pi consumption, 100 and 1,000 simultaneous cold starts, a frozen-meter consistency circuit, cloned machine identities, a consumer deliberately correlated or anti-correlated with another machine's private routing code, and an unbounded-population first-pulse counterexample. It records unsafe and non-identifiable cases rather than weakening their assertions.

```bash
node orchestrator/distributed-governor-simulator.mjs
node --test orchestrator/distributed-governor-simulator.test.mjs
```

## Validation

```bash
cd /home/kenan/tools/pi-runtime
npm test
./deploy
orchestrator check   # includes a real transient-unit launch through the agent host launcher
orchestrator agents
systemctl status agent-orchestrator --no-pager
systemctl --user list-units 'pi-agent-host-*'
```

`orchestrator check` fails closed when the user manager, `pi-agents.slice`, or the transient-unit path is unusable, so the controller cannot end up deciding launches it has no way to perform.

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
