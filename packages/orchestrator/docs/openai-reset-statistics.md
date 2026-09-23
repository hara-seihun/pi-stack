# OpenAI surprise-reset statistics and the pacing policy

Provider-issued surprise resets are a measured phenomenon, not folklore. This
records what is publicly known (as of 2026-08) and how the calibrator exploits
it.

## Mechanics (confirmed by OpenAI support/staff statements)

- A reset returns usage to 100% remaining and **restarts the 7-day window from
  the next use**. The displayed reset date moves later.
- Unspent balance is **lost, not banked**. Resets are replacements, never
  top-ups ("if you had already consumed 50% of your weekly allowance, you will
  be back at 100% ... and the usage window will restart" — openai/codex#13330).
- The weekly limit is a rolling 7-day usage window anchored at first use, not a
  calendar week (OpenAI_Support, community thread 1364615).
- Resets are sometimes conditional: the 2026-04-28 "ALL paid plans" reset
  excluded some accounts' weekly meters (openai/codex#20395). Treat every reset
  as observable only through the meter itself.
- Referral-banked resets exist and reset both the 5h and weekly windows.

## Observed cadence (public reports, 2026)

Mar 3 (incident compensation), Apr 28, Jun 3, Jul 9 (rollout issue), Aug 9,
Aug 11 ("performative reset"). Users report windows surprise-reset "three or
four times" within a couple of months. Empirical rate: roughly one surprise
reset every 2–4 weeks, occasionally twice within one week.

Default hazard prior for OpenAI weekly meters: **λ ≈ 1/14 per day**. The
calibrator measures λ per account from classified surprise resets and the
prior only matters before enough history exists.

## The pacing policy

Budget planned for time `t` from now survives with probability `exp(-λt)`.
The sustainable spend rate therefore divides remaining budget by the expected
usable horizon instead of the scheduled horizon:

```
T_eff = (1 - exp(-λT)) / λ        (= E[min(T, Exp(λ))])
rate  = remaining / T_eff          (> remaining / T whenever λ > 0)
```

Recomputed continuously this front-loads spend: early in a fresh window the
rate approaches `remaining × λ`, late in the window it approaches naive
pacing. Monte Carlo (tests/scenarios.test.ts S9b) confirms the trade-off
triangle:

- hazard pacing strictly reduces wasted budget versus naive even pacing;
- a binge policy (spend everything in 2 days) wastes less still, but starves
  the final 5 days of every surprise-free window;
- hazard pacing is the unique point with **zero starved hours** and full spend
  by window end.

The waste reduction at λ = 1/14/day is ~9% of plan per window; it grows with
λ·T (at λ = 1/7 it is ~20%). "Use more of the plan toward the start of the
week" is exactly what the formula produces, with the aggressiveness tied to
the measured reset frequency rather than a hardcoded curve.

## Sources

- https://community.openai.com/t/weekly-limits-reset-date-suddenly-changed/1364615
- https://community.openai.com/t/codex-rate-limits-reset-for-all-paid-plans-on-august-9-and-again-on-monday/1389643
- https://community.openai.com/t/questions-about-an-unexpected-codex-usage-reset-and-new-quota-period/1382610
- https://github.com/openai/codex/issues/13330, #16423, #17925, #19987, #20395
- https://help.openai.com/en/articles/11369540-using-codex
