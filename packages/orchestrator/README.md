# pi-orchestrator

Fleet orchestration for [pi](https://github.com/badlogic/pi-mono) agents:
multi-account usage calibration, quota governance, tiered model routing, and
task scheduling. Built on pi's SDK — pi is the engine, this is the fleet
layer.

Status: the core calibrator, ledger, usage-logger extension, task
eligibility layer, broker, controller, out-of-process runners, pi-SDK agent
host, routing extension (multi-pass successor), and operator CLI are
implemented, wired to operator config (tier→model maps and meter topology),
and running in production, including alias-account auth and extension-provider
models inside SDK-hosted sessions.

## Design

Agents are launched in three tiers — `light`, `standard`, `expert` — that map
to models/accounts in orchestrator configuration only. Agents are never told
their tier: a session knows which model it runs, not why. The orchestrator
owns which accounts fund which tier and how hard each plan is drawn down.

Usage that does not flow through the orchestrator still drains the same plans
(interactive pi sessions on the same machine). A pi extension logs all
machine usage; the calibrator consumes both streams. Accounts are assigned to
exactly one machine — there is no cross-machine coordination by design.

Accounts carry a **credential-custody mode**. Exclusive `interactive` and
`orchestrator` domains remain available for providers whose credential lives
in one user's `auth.json`. A shared Codex account instead keeps its only OAuth
credential in the central store beside the ledger (`auth.json`, or
`PI_ORCHESTRATOR_AUTH`): both runtimes resolve and refresh it under one
cross-process lock, so rotating refresh tokens are never duplicated.
`account share <id>` enables this mode and `account login <id>` performs a
headless device login directly into the shared store; both delete the
invoking user's copy of that credential, because custody is a move.

Shared custody must be exclusive, and the provider enforces it rather than
trusting it. Pi's resolver lets a credential stored under a provider id own
that provider: a leftover per-user `auth.json` entry for a shared alias would
otherwise resolve to no auth at all (`No API key found`), and letting the
family's own OAuth branch see that stale copy would rotate — and invalidate —
the live shared refresh token. The shared provider therefore answers both
branches from the shared store and ignores whatever copy it is handed.

## Core calibrator (`src/calibrator/`)

Learns, per account and meter, what providers refuse to tell you:

- **tokens per percent of plan** for every usage class, from integer-only
  percent readings (weighted least squares over accumulated segments; short
  timescales are refused rather than mis-estimated);
- **coupled meters**: e.g. Anthropic's fable class drains the 5h, weekly, and
  fable meters simultaneously at different rates — each meter is calibrated
  independently, so relationships like "the fable budget is 50% of the weekly
  budget" and "fable costs ~2x opus per token" are measured, never assumed;
- **unattributed drain** (usage from devices this machine cannot see) as a
  leak rate, flagged instead of corrupting token-rate estimates;
- **reset classification**: scheduled rollovers vs surprise resets, wasted
  budget accounting, and a per-account surprise hazard rate;
- **hazard-aware pacing**: spend plans front-loaded by the measured reset
  hazard (see [docs/openai-reset-statistics.md](docs/openai-reset-statistics.md));
  provider meter quirks that constrain collection are recorded in
  [docs/provider-meter-notes.md](docs/provider-meter-notes.md);
- **plan-size change detection**: silent allowance cuts between windows are
  detected and calibration restarts from the new regime.

Two estimator details matter for accuracy. Integer deltas are corrected by
carrying the estimated fractional percent across segment boundaries, so
chained observations telescope to the exact total (threshold-triggered
closes otherwise systematically overstate drain). And a reading that arrives
after an idle gap (no recorded usage for `idleSplitMs`) closes the pending
segment at the idle boundary, isolating the gap as its own observation.

## Fully instrumented machines

On a machine where every pi session loads the usage-logger extension, drain
is observed, not estimated:

- **Cost normalization**: component price ratios (input/output/cache) are
  known facts from provider pricing, so usage facts are mapped to cost units
  at replay time and each meter calibrates a single scale (cost units per
  percent). This is mix-shift invariant by construction. Estimating free
  per-component weights from integer-quantized aggregate segments is
  deliberately not attempted: it is under-identified (proven in the test
  suite by failure).
- **The idle-drain alarm**: percent drained across zero-usage gaps is
  accounted directly and model-free (`MeterStats.idleDrain`). Near zero is
  the invariant; a sustained excess means usage is escaping instrumentation
  or the account is being used off-machine.
- Accuracy is then quantization-limited: the instrumented simulation
  recovers the true scale within ~0.3% after two weeks of fleet traffic.

## Usage-logger extension (`src/extension/`)

Records every pi session on the machine into the ledger: one usage event per
token component per assistant message, attributed to the provider alias
(which is the account identity under multi-account setups), and provider
rate-limit response headers parsed into meter readings with exact timestamps
-- no polling. Interactive agent turns also hold heartbeat-backed session
leases while active. The broker counts those leases against shared-account
capacity and includes their elapsed time in measured per-session burn; a
crashed process stops counting after the lease timeout. Anthropic exposes all
three meters (5h, 7d, 7d_oi) on every response. Ledger location:
`PI_ORCHESTRATOR_LEDGER` or
`~/.local/share/pi-orchestrator/ledger.sqlite3`.

## Meter sampling (`src/meters/`)

Providers that publish no rate-limit headers need a poller, or their meters
have no source at all. Cursor's Connect stream carries no quota state, and pi
talks to Codex over a WebSocket by default, so there is no HTTP response to
carry headers there either. The controller daemon therefore samples both:
Cursor's dashboard period-usage RPC, and Codex's account usage endpoint
(`/backend-api/codex/usage`), writing ordinary meter readings for each.

Anthropic does publish headers, and they are still recorded for free by the
usage-logger — but they describe *one response*, not the account, and both
blind spots overstate headroom. The scoped weekly header
(`7d_oi`, Fable's) rides only on traffic scoped to that model, so an Opus
account has no Fable meter in the ledger at all; and no header can report a
drain that happened on another machine, so an account shared with an
off-machine client reads as idle. Both were live: the Opus account's Fable
week was fully spent and invisible, and Pi Remote's Fable card averaged the
two accounts that had a reading and presented 87% as the fleet's when the
weighted truth was 65%. `GET /api/oauth/usage` returns every bucket of the
plan on every call, whatever the account has been running and wherever it
ran, so the daemon polls it for accounts in its own credential custody and
the usage-logger polls it for each interactive user's, due-gated on the
stalest meter so a busy session cannot keep a missing bucket "fresh".

Codex was the expensive case to have missed. With no meter source at all, every
Codex account was permanently uncalibrated, which the broker correctly reads as
bootstrap and holds to one concurrent session per account — seven Pro accounts
at 8–23% of their weekly plans were the whole fleet's ceiling until the sampler
existed. Codex reports its windows with a length, so **window length names the
meter**: the operator config declares meters by window hours, a reported window
is matched to the meter of that length, and an undeclared window is reported
rather than guessed at, because a mis-named meter would calibrate one plan's
drain against another's allowance. Model-scoped `additional_rate_limits` are
not the account plan and are not read.

Readings are spaced by a sampling interval, only percentages are recorded (the
dollar "included usage" figure Cursor reports gates nothing — see
[docs/provider-meter-notes.md](docs/provider-meter-notes.md)), and no sampler
ever refreshes OAuth: an expired access token is recorded as a gap rather than
a token-family revocation. Everything downstream — calibration,
broker admission, Pi Remote's plan cards — then reads the same ledger facts it
reads for header-instrumented providers.

## Ledger (`src/ledger/`)

SQLite (via `node:sqlite`, zero dependencies) storing **facts, not
conclusions**: accounts, meter readings, usage events. Calibration is always
rebuilt by replaying stored facts through the calibrator — there is no
serialized model state, so one source of truth and calibrator improvements
apply retroactively to recorded history. Idle high-frequency readings are
deduplicated to hourly anchors; old facts are prunable because calibration
only weights recent windows.

## Tasks: demand, gates, tiers (`src/tasks/`)

A task is an action plus two observable predicates: **demand** (is there
work right now?) and, eventually, completion. Three launch-side fields
describe scheduling:

- `demand`: a constant or a cheap read-only probe command whose last stdout
  line is a work-unit count. `0` means no work; agents are never launched to
  discover idleness. Results are cached with a TTL and invalidated by task
  completion (`taskFinished` invalidates the finisher's demand and every
  gate that references it). Demand answers *whether* a lane can absorb
  another agent, and caps how many it may hold at once.
- `share`: this lane's relative claim on the fleet, default 1 — *how* the
  scarce slots are divided among the lanes that want them. It scales the
  lane's whole tier bundle: `share × tier weight` is the lane's claim on each
  tier, so two lanes at share 10 and 5 hold standard sessions 2:1. It is a
  claim, not a reservation: a lane with less work than share gives the
  remainder back the same cycle. Share and demand were one
  number until it became clear they answer different questions — a lane whose
  probe counted problems in sixes outranked a lane counting review items one
  by one, and the fleet's split was an artefact of each probe's unit rather
  than a decision anyone made.
- `gate`: a deliberately tiny expression over other tasks' demand
  (`ingest.demand == 0`, thresholds, `and`/`or`, parentheses — nothing
  else). Gates reference demand values only, never other gates, so cycles
  are impossible by construction. An unevaluable gate (unknown upstream
  demand, failed probe) is closed, never open. A debounce window stops
  flapping gates from launching agents prematurely.
- `tiers`: a weighted subset of `light`/`standard`/`expert` — the set the
  governor may satisfy a launch with, and in what proportion.
  `--tiers light:20,standard` says "one standard session per twenty light
  ones", which is how a research lane is run mostly on a cheap model with a
  deliberate trickle of an expensive one to compare against; an unweighted
  tier is weight 1, so `--tiers standard` is the ordinary single-tier lane.
  Tier labels live only in launch-side tables; prompt assembly and
  agent-visible surfaces have no read path to them.

**Allocation composes a fleet, not a launch order.** `share × tier weight` is
one number per (lane, tier) pair, and the sessions standing at any moment
should divide in proportion to those numbers. A lane at share 10 wanting
`light:20,standard:1`, beside a lane at share 5 wanting `standard`, claims
200 light and 10 standard against 5 standard — so a 43-session machine holds
40 light and 2 standard for the first lane and 1 standard for the second. The
shares divide each tier, and the mix holds inside the lane.

- The claim is a **ceiling as well as a target**: no pair holds more than its
  proportional slice of the fleet, so capacity that no claim wants stays
  unused instead of being poured into whichever lane can take it. That is the
  bug this model replaced. Share and mix used to be applied in sequence —
  share divided the launches, then the mix split each lane's launches — so a
  share-14 research lane wanting 20 light per standard was asking for one
  standard session in twenty-one *launches*, and a share-2 review lane took
  every remaining standard slot on the machine. The fleet came up almost
  entirely review agents against an operator instruction that said the
  opposite.
- A lane with **no work left** drops out of the denominator entirely, so its
  claim is redistributed among lanes that still have a backlog. Share stays a
  claim on contested capacity rather than a reservation. A tier with no
  capacity is different: the lane simply does not hold those sessions, and
  nobody else inherits them.
- **Composition is measured over a window** (1h): live sessions count as one,
  and ended ones fade linearly to nothing across the window. A queue lane
  that exits when drained turns over many times an hour while a research lane
  holds warm context for hours, so counting only live sessions would read the
  short-lived lane as idle and feed it slot after slot — and would erase the
  memory a weighted mix needs, since 20:1 is a ratio no single-slot cycle can
  express. Counting every session in the window at full weight fails the
  other way: a lane cancelled an hour ago held a phantom share of the machine
  and blocked the real over-served lane from giving anything back.
- Slots go one at a time to the pair whose next session falls earliest in
  virtual time, `(held + 1) / claim`. Splitting a cycle's slots by proportion
  instead would round every minority claim to zero — the common cycle offers
  a single slot — and 20:1 is a ratio no one cycle can express.
- **A full machine sheds** to converge. Allocation can only place slots that
  exist, so on a machine at its session ceiling a mix change would wait on
  attrition: after a lane moved from 20:1 to 5:1 its fleet sat at 46 light
  and 1 standard, with the quota for eight standard sessions idle and each
  light session good for hours. When some pair is a whole session below its
  claim and the broker could fund it, the controller asks the worst
  over-served pair to give one session back — the youngest, which has the
  least work behind it — at most one per tick. Never while slots were
  launched that tick (the machine was not full), and never for a tier whose
  quota is spent anyway.

The broker is told the same arithmetic: the tier shape it advertises is what
the claims would actually take, so scarce accounts are not held for a tier no
lane is about to ask for.

The two levers compose, which is the point: `share` decides who gets the
fleet, `boost <family> 5` decides how large the fleet is (it multiplies the
paced sustainable rate, so a family spends its real measured headroom faster
rather than acquiring invented capacity), and the lane's tier mix decides
which models those launches use. Turning one lane up to 70% and boosting the
family it runs on fills the machine with that lane's cheap tier without
touching a prompt or a task definition.

- `exitWhenDrained`: end a shift as soon as the lane's demand reaches zero
  instead of re-prompting until the session budget is spent. A research lane
  is never done and must keep its warm context; a queue lane empties its
  queue mid-shift, and `CONTINUE` then asserts work that no longer exists.
  Unknown demand — unprobed, stale (>5min), or a failed probe — never ends a
  shift: "I cannot see the queue" is not "the queue is empty". The host asks
  (`HostEvents.laneDrained`); the runner, which holds the ledger, answers.

Launch control is one lever at two scopes, both `control` rows in the ledger
and honoured by every evaluation regardless of who restarts which process:
`launches = enabled|paused` for the machine, `launches:<taskId> = paused` for
one lane. `pause --except math-review` holds every other defined lane, which
is how the fleet's whole capacity is pointed at one lane without deleting the
others' definitions. A held lane is still probed — its demand is a signal
other lanes' gates read — and running agents are never touched.

## Broker (`src/broker/`)

The broker owns account custody: which account and model a launch runs on,
how much of each account's quota a session commits, and where a failing
session moves. Everything it knows is derived from ledger facts at decision
time — sustainable percent/hour from the replayed calibrator's hazard-paced
plan (most binding meter wins), per-session burn measured from observed
meter drain over both fleet run-hours and interactive lease-hours. Active
interactive leases consume the same shared-account quota as fleet runs.
There are no hand-configured burn constants anywhere.

**Burn is measured per model, and an account's budget is a rate.** Sessions
of different models against the same quota differ by more than an order of
magnitude: a light session on this fleet moves the Codex weekly meter so
little it prices at zero, while a standard one costs about 1%/h. So the
calibrator classes usage per model (`modelClasses` splits `luna:cost` from
`sol:cost`), the ledger reports what an hour of each model's sessions
actually recorded, and the product of the two is what a session of that
model burns here. Admission then compares rates, not counts: every live
session commits its own model's burn against the account, and a candidate
launches if the meter can sustain the sum. Counting sessions instead let the
cheap model starve the expensive one — forty-six light sessions filled the
accounts' session counts, and the standard tier, costing a fraction of the
sustainable rate and asked for by an operator running a 1:5 mix, was refused
every account on the machine while the fleet ran one standard session. A
model measured as free has no quota bound at all; what bounds it is the
machine ceiling.

Burn is a quotient, so both halves are taken over the **same interval**: the
span the account's meters actually reported across, never the nominal
measurement window. A window's session-hours that no reading priced dilute
observed drain by exactly the coverage ratio, and concurrency is drain's
reciprocal — so on 2026-08-21 a Codex fleet with four hours of sampler
history behind a 48-hour window read one account's sessions as 0.05%/h
instead of 0.51%/h and advertised eleven slots where the evidence supported
one. A fresh sampler, a sampling outage, a pruned ledger, and a newly added
account all open that gap; aligning the numerator's span with the
denominator's closes it, and the session-hour minimum is then a real
evidence threshold rather than a clock.

"Most binding meter" means the meters the launch can actually drain, from
the topology's `drainedBy` classes. Anthropic's scoped weekly bucket is
Fable's alone, so an account whose Fable week is spent still has whatever
its session and all-models meters say for an Opus launch; pacing that launch
against the exhausted bucket would strand a working plan at zero capacity.
A caller that names no model — `externalCapacity`, and the `capacity`
command built on it — gets the conservative account-wide minimum over every
meter, because it has not said what it will run. Calibration replay always
carries the family's whole topology; the model narrows only which calibrated
meters get a say in the rate.

An **operator boost** (`boost <family> on`, a `boost:<family>` control row) is
the one deliberate lever over that arithmetic: it multiplies the paced
sustainable rate for one provider family, so a boosted family spends its real
measured headroom faster rather than acquiring invented capacity. Everything
underneath keeps working — measurement, hazard pacing, cooldowns — and an
uncalibrated account stays in bootstrap however high the boost, because there
is nothing measured to spend faster.

Concurrency per account is a quotient of two measurements: what the plan
sustains (percent/hour) over what one session actually costs (percent/hour of
meter drain per session-hour). An account missing **either** half runs a
single **bootstrap** session until it has earned the evidence — never as a cap
on an account that has it. Pacing itself needs no token calibration: remaining
percent over a hazard-discounted horizon is arithmetic on the provider's own
reading, and the token coefficients only ever priced that rate in tokens.
Requiring them held the whole Codex fleet at one session per account
indefinitely, because Codex publishes no per-request meter headers to pi's
transport and so never calibrates a usage class at all — seven subscriptions
with a week of headroom each, running seven agents. The plan is now always
issued; an unpriced class simply appears in no budget.

Pacing still uses the **most binding** meter, and calibration confidence still
gates the token budgets. A fresh short-window reset must never let the broker
ignore an unread weekly meter and infer dozens of slots from the short window
alone. On 2026-08-20 that exact path launched 21 Opus sessions; the
24-session worker (including five Codex sessions) reached 22.8 GiB and the
kernel OOM-killed it. That episode is also why quota is not the only bound:
sessions are hosted inside the runner's own process, the estimator can only
see provider allowance, and so a machine-wide `maxConcurrentSessions` ceiling
(operator config; systemd `--max-sessions` is the independent backstop) caps
every tier and account at once. `slotsByTier` advertises capacity for
one allocation cycle by virtually admitting until refusal (so shared accounts
are never double-counted), capped by what eligible tasks actually demand (so a
tier never hoards an account nothing wants), and handing out the turns in
demand-proportional order — weighted fair queueing over the tiers, ties to the
scarcer one. Draining the scarcest tier to exhaustion first was right while
tiers meant separate account pools; once `light` and `standard` both drew on
the same Codex subscriptions it meant standard took every account every cycle
and the light tier was advertised zero slots forever, whatever any task asked
for. `failover` cools the failing account down and re-admits the run
elsewhere.

## Controller and runners (`src/controller/`, `src/host/`)

The controller is the launch loop. Each tick: reap runs with stale
heartbeats, expire pending runs no runner claimed (aborted, not error — a
runner outage never trips task circuit breakers), evaluate the scheduler,
net demand against in-flight runs (a backlog of 3 with 2 agents on it wants
one more agent, not three), allocate broker slots, admit, and write
`pending` run rows. A per-task circuit breaker skips tasks with repeated
recent errors so a crashing task cannot hot-loop through plan capacity. The
controller holds no state of its own — every fact lives in the ledger, so
restarts lose nothing.

Runners are **separate processes** from the controller, so an orchestrator
update or crash never kills an agent, and each runner hosts **many**
embedded sessions in one node process (700 concurrent agents must not mean
700 node processes). The ledger is the only channel: the controller writes
pending runs, runners claim them with one atomic UPDATE (two runners can
never claim the same run), heartbeats and results flow back as row updates.
Runner updates use generation draining: `drain-runners` bumps a control
row; live runners stop claiming and exit when their last session ends,
while freshly started runners claim under the new generation. Nothing is
ever killed mid-run.

A hosted session **binds extensions** before its first prompt. Extensions
come alive only when a mode binds them — `bindExtensions` is what emits
`session_start` — and everything an extension sets up in response simply
never happens in a session that skips it. Hosted sessions carried the `mcp`
tool on their surface (it registers at load time) answering "MCP not
initialized" to every call, so fleet agents told to work through the math
ledger's MCP server spent their turns writing curl JSON-RPC helpers instead.
The host binds print mode: no UI, no command actions, extension errors into
the run's own transcript.

A launch is a **shift**, not a turn. A model ends its turn as soon as it
writes a summary, and the host used to end the run with it: standing research
lanes whose prompts say "submitting is a checkpoint, not an exit" were torn
down at the first checkpoint — 27 to 57 minutes in — and relaunched from an
empty context, paying re-orientation cost over and over. No prompt wording can
fix that, because the instruction addresses an agent that no longer exists by
the time it would apply. The host therefore re-prompts the same live session
(`CONTINUE` in `src/host/pi-host.ts`, a pointer back to the blocker rather
than a pep talk) until the session budget (4h) is spent, the turn errors, an
operator aborts, two consecutive turns report nothing, or the lane declares
itself drained (`exitWhenDrained`, checked against current demand before each
re-prompt). Work already banked in a
`task_complete` report survives a late error: the report is the run's record,
and only a shift that banked nothing reports as an error run.

Draining needs two runner processes alive at once, which is what the
**supervisor** (`src/host/supervisor.ts`) is for. It is the process a
service unit runs: it hosts nothing, and keeps exactly one worker of the
current generation alive as a child, spawned from the deployed CLI path so
every worker starts on the newest build. A generation bump spawns the
successor on the next tick while the superseded worker drains beside it, so
claiming never stops. Without it a drained runner *is* the unit's main
process: its replacement cannot start until its longest session ends, and
every run created in the meantime expires unclaimed — the fleet stops
launching agents while looking healthy (observed 2026-08-20, 80 minutes of
silently dropped work). Workers get distinct ids, so a crashed worker's
running rows (reaped on heartbeat timeout) never count against the
replacement's capacity. Only a supervisor update needs a full drain first,
which is why it holds no policy.

A heartbeat is not progress. The runner's heartbeat is a timer inside the
hosting process, and it keeps ticking over a session that has stopped
running: on 2026-08-21 a Grok run parked inside a Cursor provider call for 90
minutes, heartbeat healthy, `abort` requests unobservable to a turn that
never returns, holding a lane seat until the operator noticed. `PiHost`
therefore reports session activity separately (throttled to a 15-second
ledger write) and the run row keeps `progress_at`. A runner asks a run with
no progress for 20 minutes to abort, and 10 minutes later kills the session
outright — `HostManager.kill` disposes it and reports the run finished
without waiting for the provider to unwind, because a parked provider call
never unwinds. The threshold sits well above any legitimate quiet stretch: the longest are a
single tool call (fleet sessions cap bash at five minutes) and one silent
stretch of reasoning.

A session may not outlive its run row either. Every tick the runner kills
sessions the host still holds whose row is no longer `running`, so a
controller reap or an operator `kill <runId>` frees the slot and stops the
spend instead of leaving an orphan streaming against an account.

Run outcomes are classified by whose failure they are. A rate-limited
account cools down so the next run goes to a sibling. An account that cannot
authenticate at all — missing, shadowed, or rejected credential — is recorded
`aborted` (like an unclaimed run) and cooled down, never `error`: it is a
property of the account, and counting it against the task would let one dead
credential trip every task's circuit breaker and stop the fleet. A run lost
with its runner is likewise `aborted` on heartbeat timeout: process loss is
infrastructure failure, not evidence that the task itself crashes.

Run custody lives in the ledger's `run` table (launch-side only: `tier` is
recorded there for capacity accounting and never reaches a host). A task
without a `prompt` is a pure demand signal for gates and is never launched.

`PiHost` is the thin pi-SDK adapter behind the `HostManager`/`HostEvents`
interfaces: one launch = one embedded `AgentSession`, the task prompt as
first user message, a `task_complete` custom tool for the result report, a
30-second heartbeat, `dispose` on the way out. All policy lives upstream.

Models resolve in two places for one reason. Builtin-family models resolve
before the session exists, because an alias account re-homes the family model
onto its own provider id so credentials resolve per account. A model served by
an **extension provider** cannot: the extension that registers it is loaded per
session, so it exists only in that session's `modelRuntime`, and `PiHost`
resolves it there and applies the launch's thinking level. Re-homing such a
model onto an alias id is refused rather than approximated — stripping an
extension provider off a model silently sends the request to the family's
public API instead.

## Run transcripts (`src/host/transcript.ts`)

The ledger says what a run *is*; the transcript says what the agent *did*.
Each launch appends `{seq, time, type, payload}` lines to
`<runs>/<runId>/events.jsonl` (`PI_ORCHESTRATOR_RUNS`, default
`~/.local/share/pi-orchestrator/runs`), so a reader follows a long agent with a
byte cursor rather than re-reading the file. The in-flight turn is published to
`live.json` **only** while an observer's `watch` marker is fresh: watching costs
a file touch, and nobody watching costs nothing. Transcript failure never fails
a run, and transcripts older than a week are pruned when a runner starts.

A `tool_start` payload carries the tool's own arguments as an object, because a
reader renders a card from named fields — a bash `command` and its `timeout`, a
`path`, an edit count. Only genuinely oversized arguments and tool output are
flattened to bounded text, and an oversized argument becomes a labelled
`{truncated, preview}` rather than a quoted blob.

## Routing extension — the multi-pass successor (`src/extension/routing.ts`)

Multi-account routing for interactive pi sessions, driven entirely by the
ledger — the account table is the registry (there is no `multi-pass.json`),
and the extension replaces the old 6,000-line multi-pass with three rules:

- Exclusive accounts whose id differs from their family (`anthropic-2`, ...)
  are ordinary alias providers over the local `auth.json`. Shared Codex
  accounts, including the unsuffixed family id, are providers over the central
  credential store; both runtimes use the same locked refresh-token lineage.
- A fresh session binds to the **least-used** account of its model's family
  (max latest used-percent across meters; unread accounts sort first;
  integer-percent ties round-robin by least-recently-bound) and then stays
  **sticky**: provider prompt caches are per-account, and a mid-session
  switch throws the cache away. Resume, fork, and reload never rebind.
- Stickiness yields only to failure: on a rate-limit error the account
  cools down in the ledger (broker admission honours the same fact) and the
  session moves to the next account. The move happens on `agent_end`, before
  pi's own auto-retry fires, so the retry replays the interrupted turn on the
  healthy account and the agent usually never notices. The resume prompt is
  held for `agent_settled` — the point where pi guarantees no retry,
  compaction, or queued continuation is left — and is sent only if the run
  is still dead there. Telling an agent its turn "did not complete" after a
  retry already delivered the reply is a lie it then has to reason around.

Orchestrator-launched sessions set `PI_ORCHESTRATOR_ASSIGNED=1` and the
extension stays out entirely — the broker owns their custody, so exactly
one brain routes any given session. Load it by adding this repository to
`packages` in pi settings (the package also carries the usage logger).

## GPT-Live voice (`src/voice/`)

GPT-Live (`gpt-live-1-codex`) exposed as an API on top of the account
ledger. The account pool is the ledger: eligibility is Codex account rows
that are not cooling and not past paid access, intersected with the OAuth
credentials in the central shared store. Calls are spread round-robin with no per-account leases — one
account accepts concurrent GPT-Live calls — and a quota-exhausted account is
skipped until its window resets. Token refresh interoperates with pi's own
`auth.json.lock` convention.

Three consumption modes, all exported as `pi-orchestrator/voice`:

- **Library** — `VoiceBroker.negotiate(sdp, instructions)` turns a WebRTC
  SDP offer into an answer on a pooled account. The ledger rows are an
  injected `accounts` source, so any SQLite driver (node:sqlite, bun:sqlite)
  works. pi-remote consumes it this way, in-process.
- **Daemon** — `pi-orchestrator voice-broker [--listen 127.0.0.1:2457]`
  serves `GET /v1/voice` and `POST /v1/voice/offer` (`{ sdp, instructions,
  voice?, model? }` → `{ sdp, account }`) on loopback. Processes without
  credential custody — for example a read-only container on the host
  network — negotiate calls without ever seeing an OAuth token. The Converge
  meeting runtime consumes it this way.
- **Protocol helpers** — pure functions for the negotiated data channel:
  `parseDelegationCreated`, `parseTurnTranscript`, `contextAppendEvents`,
  `utf8Chunks` (500-byte context chunking).

## Operator CLI (`src/cli.ts`)

Standing math lanes are enabled. Their research-session contract and the
transcript evidence that shaped it live in
[`../math-research/docs/agent-research-capability.md`](../math-research/docs/agent-research-capability.md).
The deployed task ledger is the source of truth for definitions. In addition
to research, survey, formalization, and review, `math-curation` keeps one
light-tier work unit improving high-notability ledger titles and summaries via
T0 amendment proposals and filling the reviewed reach/advance/closure impact
rubric in coherent batches; `math-review` independently applies or rejects
both proposal kinds.

`pi-orchestrator status | capacity | usage | task set/list/delete | account list/add/domain/share/login |
pause | resume | boost | abort | kill | say | runner | drain-runners | voice-broker` —
thin reads and
writes against the ledger (path from `PI_ORCHESTRATOR_LEDGER`, default
`~/.local/share/pi-orchestrator/`).
`capacity [--provider F]` prints admission and quota facts as JSON — per
account the broker's eligible view (measured session capacity, active runs
plus interactive leases, cooldown state) and the latest reading of every
configured meter, with per-provider aggregates (free session slots bounded by
the machine ceiling, mean/minimum remaining percent, next reset). It exists
for external launchers — processes that start their own pi sessions on this
machine's pooled accounts (the Converge supervisor's workers) — so their
launch sizing reads the same ledger facts the broker admits from instead of
keeping a parallel quota model.
`usage [--hours N]` answers "what is spending our quota", which is otherwise
only answerable by forensics. Every pi session on this machine logs into this
ledger, so the split is exhaustive: fleet burn against the operator's own
interactive burn, then by lane, account, model, and largest session. The
label is not inferred — `usage_event.source` is written from
`PI_ORCHESTRATOR_ASSIGNED`, the same flag the broker sets to claim a
session's account custody, and the runner records its session id on the run
so fleet burn resolves to the lane that asked for it. Usage recorded before
that link existed was relabelled by correlating run windows, so its lane is
one `(unattributed fleet session)` bucket rather than a guess.

`kill <runId> [reason]` is the blunt end of `abort`: it ends the run row, and
the owning runner then tears the session down on its next tick. `abort` asks
the agent loop to stop and depends on the in-flight turn returning, which a
session parked inside a provider call never does.

`say <runId> <text>` is the counterpart of `abort`: it queues an operator
message in `run_message`, the runner that owns the session steers it in as a
user turn (and mirrors it into the transcript), and the CLI waits for the
`delivered_at` receipt before claiming anything. Steered rather than queued
behind the current run, because an operator correcting an agent means "from
the next turn on". A drifting agent can
be corrected mid-run instead of thrown away with its context, and a message
is never marked delivered by a process that does not hold the session.
`supervisor --max-sessions N` runs the process a service unit should own
(it spawns and replaces `runner` workers); `runner --max-sessions N` starts
a single worker directly. `drain-runners` rolls runner generations for
zero-kill, zero-gap updates. `npm run build` emits `dist/` for
the `pi-orchestrator` bin.

## Development

```
npm install
npm test          # scenario suite (tests/scenarios.test.ts)
npm run typecheck
```

Every test is a simulated real-world account history — the simulator knows
the hidden true rates, the calibrator only sees floored integer percents and
whatever usage events the scenario chose to log.
