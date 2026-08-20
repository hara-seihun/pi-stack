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

Accounts additionally carry a **credential-custody domain**. Provider OAuth
refresh rotates refresh tokens, so an account's credential can live in
exactly one `auth.json`; on deployments where fleet sessions run as a
different OS user than interactive sessions (a privacy boundary), each
account row is either `interactive` (bindable by the routing extension,
credential in the interactive user's auth.json) or `orchestrator` (admittable
by the broker, credential in the fleet user's auth.json). Calibration stays
machine-wide across both domains. `pi-orchestrator account list` /
`account domain <id> <domain>` manage the assignment; moving the auth.json
entry between users is the operator's paired step.

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
-- no polling. Anthropic exposes all three meters (5h, 7d, 7d_oi) on every
response; header names are verified against recorded production traffic.
Ledger location: `PI_ORCHESTRATOR_LEDGER` or
`~/.local/share/pi-orchestrator/ledger.sqlite3`.

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
  gate that references it).
- `gate`: a deliberately tiny expression over other tasks' demand
  (`ingest.demand == 0`, thresholds, `and`/`or`, parentheses — nothing
  else). Gates reference demand values only, never other gates, so cycles
  are impossible by construction. An unevaluable gate (unknown upstream
  demand, failed probe) is closed, never open. A debounce window stops
  flapping gates from launching agents prematurely.
- `tiers`: a preference-ordered subset of `light`/`standard`/`expert` — the
  substitution set the governor may satisfy a launch with. Allocation across
  eligible tasks is proportional to demand by largest remainder, honours
  tier preference with spill, never assigns more agents than work units, and
  redistributes capacity a tier-restricted task cannot use. Tier labels live
  only in launch-side tables; prompt assembly and agent-visible surfaces
  have no read path to them.

The machine-wide pause is the root of the same mechanism: a `control` row
(`launches = enabled|paused`) in the ledger, honoured by every evaluation
regardless of who restarts which process.

## Broker (`src/broker/`)

The broker owns account custody: which account and model a launch runs on,
how many concurrent sessions each account sustains, and where a failing
session moves. Everything it knows is derived from ledger facts at decision
time — sustainable percent/hour from the replayed calibrator's hazard-paced
plan (most binding meter wins), per-session burn measured from observed
meter drain over recorded session-hours. There are no hand-configured burn
constants anywhere.

An **operator boost** (`boost <family> on`, a `boost:<family>` control row) is
the one deliberate lever over that arithmetic: it multiplies the paced
sustainable rate for one provider family, so a boosted family spends its real
measured headroom faster rather than acquiring invented capacity. Everything
underneath keeps working — measurement, hazard pacing, cooldowns — and an
uncalibrated account stays in bootstrap however high the boost, because there
is nothing measured to spend faster.

An uncalibrated account is in **bootstrap**: exactly one concurrent session,
so the calibrator gets data without risking a stampede; measurement then
earns concurrency. `slotsByTier` advertises capacity for one allocation
cycle by virtually admitting scarcest-tier-first (so shared accounts are
never double-counted), capped by what eligible tasks actually demand (so a
scarce tier never hoards an account nothing wants). `failover` cools the
failing account down and re-admits the run elsewhere.

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

## Routing extension — the multi-pass successor (`src/extension/routing.ts`)

Multi-account routing for interactive pi sessions, driven entirely by the
ledger — the account table is the registry (there is no `multi-pass.json`),
and the extension replaces the old 6,000-line multi-pass with three rules:

- Every account whose id differs from its family (`anthropic-2`, ...) is
  registered as an **alias provider** delegating models, transport, and
  OAuth to the family's builtin provider; credentials resolve from pi's
  auth.json under the alias id.
- A fresh session binds to the **least-used** account of its model's family
  (max latest used-percent across meters; unread accounts sort first;
  integer-percent ties round-robin by least-recently-bound) and then stays
  **sticky**: provider prompt caches are per-account, and a mid-session
  switch throws the cache away. Resume, fork, and reload never rebind.
- Stickiness yields only to failure: on a rate-limit error the account
  cools down in the ledger (broker admission honours the same fact) and the
  session moves to the next account with a resume prompt.

Orchestrator-launched sessions set `PI_ORCHESTRATOR_ASSIGNED=1` and the
extension stays out entirely — the broker owns their custody, so exactly
one brain routes any given session. Load it by adding this repository to
`packages` in pi settings (the package also carries the usage logger).

## Operator CLI (`src/cli.ts`)

Standing math lane launches are paused, and the lane contract these tasks carry
is the first item in
[`../math-research/docs/agent-research-capability.md`](../math-research/docs/agent-research-capability.md):
run transcripts show agents ending a session at the first publishable fact.

`pi-orchestrator status | task set/list/delete | account list/add/domain |
pause | resume | boost | abort | runner | drain-runners` — thin reads and
writes against the ledger (path from `PI_ORCHESTRATOR_LEDGER`, default
`~/.local/share/pi-orchestrator/`).
`runner --max-sessions N` starts a runner process; `drain-runners` rolls
runner generations for zero-kill updates. `npm run build` emits `dist/` for
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
