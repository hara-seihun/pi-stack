# Plan meter

Samples Codex and Anthropic subscription plan meters on a timer and reports meter movement beside Pi usage-ledger tokens for the same window. It exists to answer one question the token ledger cannot: **what did a period of a given subscription actually buy?**

Machine-level context is in [Observability](../../../machine/observability.md).

## Why a separate record

Plan meters are server-side state on rolling windows. When a window resets, the provider discards the evidence of what the previous window cost, and neither the Pi usage ledger nor session JSONL can reconstruct it — they see tokens, never capacity. Sampling on a timer converts "how much of the plan did a day consume" from something an agent must remember to capture twice into an ordinary query.

Neither vendor publishes weekly limits, and both have changed them without announcement, so the measured burn rate is the only trustworthy figure.

## State

`/home/kenan/data/plan-meter/meters.sqlite3` on each host, WAL mode, owner-only. `PLAN_METER_DB` or `PLAN_METER_DATA` override the location for tests.

- `sample` — one row per account per poll: host, timestamp, provider alias, family, status, plan, tier, account key.
- `bucket` — one row per advertised limit bucket on that sample: used percent, reset time, window length, and unit counts for credit and overage balances.

Every bucket the provider advertises is captured, not only the ones the governor needs for admission, because any single bucket reaching 100% is what produces a 429. On Anthropic that routinely means a model-scoped weekly bucket saturating while the headline weekly bar still looks healthy.

The database holds no prompt, response, credential, or raw error text. Failures are classified (`timeout`, `network`, `http_401`, `error`) rather than stored verbatim, because provider error strings can echo a bearer token.

## Credential safety

The sampler reads `~/.pi/agent/auth.json` and never writes it, and never triggers an OAuth refresh. Refresh tokens are single-use and the agent orchestrator owns that path; an independent refresh here would revoke the token family and take accounts offline. An expired access token is recorded with status `expired` — an honest observation gap rather than a silent repair.

## Operations

```bash
plan-meter report 24h          # default view, merges converge-kenan
plan-meter report 7d --json
plan-meter report 24h --local  # local host only
plan-meter sample              # append a reading now
plan-meter doctor              # schema, freshness, sampling health
```

`report` columns:

| Column | Meaning |
| --- | --- |
| `Window` | The bucket used as denominator. Always the all-models weekly window when the provider reports one. |
| `Start% / End%` | Meter reading at the first and last sample inside the window. |
| `Burn%` | Sum of positive deltas between consecutive samples. |
| `Rst` | Window resets observed inside the period. |
| `Tokens / Fresh+out` | Usage-ledger totals for the same account and period, summed across hosts. |
| `Tok/1%` | Tokens per one percent of plan — the cost-effectiveness figure. |
| `FullPlan` | Tokens one complete window is worth at the observed rate. |

Burn accumulates positive deltas rather than subtracting start from end, so a period spanning a reset is measured instead of reported as negative. The weekly window is always the denominator when present: a five-hour window refills several times a day, so scaling its burn to 100% would describe a different period and make accounts incomparable.

Meters are server-side and global. An account configured on both hosts returns the same reading from each, so the reporter deduplicates meters by account while summing tokens across hosts.

## Limits

- **History cannot be backfilled.** A window that resets before its first sample is unrecoverable; a gap in the timer is a permanent gap in the record.
- An account with no meter movement in the period has no measurable per-token cost. Idle, saturated, and freshly-sampled accounts all report `n/a`, and the footer counts them.
- `Tok/1%` derived from a single one-percent tick is coarse. It stabilises over a few days.
- Cache reads dominate agent traffic, so compare `Fresh+out` when reasoning about marginal cost and `Tokens` when reasoning about throughput.

## Validation

```bash
node --test /home/kenan/tools/pi-runtime/plan-meter/plan-meter.test.mjs
plan-meter doctor
systemctl status plan-meter.timer --no-pager
```

The test drives a complete sampling round against a fake provider, asserts that an expired token becomes a gap rather than a refresh, that a scoped weekly bucket is captured, that burn survives a reset, and that credential material never reaches the database.

`doctor` fails when the schema drifts or no sample has landed in three hours, which is the signal that the timer has stopped.

## Deployment

GMKtec declares `plan-meter.service` and `plan-meter.timer` in `/etc/nixos/configuration.nix`. Converge carries equivalent units in `/etc/systemd/system/`, installed by root, because that host is Debian rather than NixOS. Both run as `kenan` every ten minutes with a randomised delay. The executable is symlinked to `~/.local/bin/plan-meter` by [`deploy`](../deploy).
