# pi-orchestrator

Fleet orchestration for [pi](https://github.com/badlogic/pi-mono) agents:
multi-account usage calibration, quota governance, tiered model routing, and
task scheduling. Built on pi's SDK — pi is the engine, this is the fleet
layer.

Status: early. The core calibrator, ledger, usage-logger extension, and task
eligibility layer are implemented; the broker, agent host, controller, and
operator extension follow.

## Design

Agents are launched in three tiers — `light`, `standard`, `expert` — that map
to models/accounts in orchestrator configuration only. Agents are never told
their tier: a session knows which model it runs, not why. The orchestrator
owns which accounts fund which tier and how hard each plan is drawn down.

Usage that does not flow through the orchestrator still drains the same plans
(interactive pi sessions on the same machine). A pi extension logs all
machine usage; the calibrator consumes both streams. Accounts are assigned to
exactly one machine — there is no cross-machine coordination by design.

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

## Development

```
npm install
npm test          # scenario suite (tests/scenarios.test.ts)
npm run typecheck
```

Every test is a simulated real-world account history — the simulator knows
the hidden true rates, the calibrator only sees floored integer percents and
whatever usage events the scenario chose to log.
