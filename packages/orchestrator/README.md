# pi-orchestrator

Fleet orchestration for [pi](https://github.com/badlogic/pi-mono) agents:
multi-account usage calibration, quota governance, tiered model routing, and
task scheduling. Built on pi's SDK — pi is the engine, this is the fleet
layer.

Status: early. The core calibrator is implemented; the ledger, broker, agent
host, controller, and pi extensions follow.

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

## Development

```
npm install
npm test          # scenario suite (tests/scenarios.test.ts)
npm run typecheck
```

Every test is a simulated real-world account history — the simulator knows
the hidden true rates, the calibrator only sees floored integer percents and
whatever usage events the scenario chose to log.
