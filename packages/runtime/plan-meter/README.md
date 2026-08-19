# Plan meter

Samples Codex, Anthropic and Cursor subscription plan meters on a timer and reports meter movement beside Pi usage-ledger tokens for the same window. It exists to answer one question the token ledger cannot: **what did a period of a given subscription actually buy?** The headline figure is **tokens per week per plan**, normalized so that weekly Codex/Anthropic windows and Cursor's monthly cycle are directly comparable.

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
plan-meter report              # auto window: the span both hosts have data for
plan-meter report 24h --json
plan-meter report 6h --local   # local host only
plan-meter sample              # append a reading now
plan-meter doctor              # schema, freshness, sampling health
```

The default `auto` window starts at the latest point where **every** contributing source — each host's usage ledger and each host's meter database — already has data. A window reaching back before a host began logging would divide tokens that host never recorded by meter movement that happened anyway, understating capacity. Explicit windows (`30m`, `6h`, `7d`, ISO timestamps) skip that check.

`report` columns:

| Column | Meaning |
| --- | --- |
| `Bucket` | The limit that exhausts first, which is what capacity must be measured against. |
| `Win` | That bucket's window length: 5h, 7d, or Cursor's ~31d cycle. |
| `Start% / End%` | Meter reading at the first and last sample inside the window. |
| `Burn%` | Sum of positive deltas between consecutive samples. |
| `Rst` | Window resets observed inside the period. |
| `Tokens / Fresh+out` | Usage-ledger totals for the same account and period, summed across hosts. |
| `Tok/1%` | Tokens per one percent of the binding bucket. |
| `Tok/week` | Tokens seven days of that plan buys at the observed rate — the comparison figure. |

Burn accumulates positive deltas rather than subtracting start from end, so a period spanning a reset is measured instead of reported as negative.

The binding bucket is the largest `burn x window length`, because capacity is proportional to its reciprocal. This needs no token count and is correct across window lengths: a five-hour session bucket burning 60% still buys more per week than a weekly bucket burning 4%, since the session window refills 33.6 times a week. It also surfaces the case the vendors hide — a scoped weekly bucket, or Cursor's included-spend pool, running out long before the headline bar.

Per-provider rows pool tokens over summed weekly-equivalent burn before multiplying by the account count. Meters tick in whole percent, so a single account measured over a few hours divides its tokens by a 1-2% reading and inherits that rounding; pooling twelve Codex accounts does not.

Meters are server-side and global. An account configured on both hosts returns the same reading from each, so the reporter deduplicates meters by account while summing tokens across hosts.

## Limits

- **History cannot be backfilled.** A window that resets before its first sample is unrecoverable; a gap in the timer is a permanent gap in the record.
- An account with no meter movement in the period has no measurable per-token cost. Idle, saturated, and freshly-sampled accounts all report `n/a`, and the footer counts them.
- `Tok/1%` derived from a single one-percent tick is coarse. It stabilises over a few days.
- Cache reads dominate agent traffic, so compare `Fresh+out` when reasoning about marginal cost and `Tokens` when reasoning about throughput.
- Capacity is measured at the *observed* workload. Cursor bills cached prefixes cheaply while the ledger counts them as full input tokens, so a Cursor figure derived from long-prefix agent sessions overstates what short, diverse sessions would buy.

## Cursor reports two disagreeing counters

`GetCurrentPeriodUsage` returns both `planUsage.totalPercentUsed` and `planUsage.totalSpend` against `planUsage.limit`, over the same monthly cycle, differing by roughly 13x. They are recorded as two buckets:

- `monthly` — `totalPercentUsed`, the counter the agent orchestrator gates admission on.
- `monthly_included` — `totalSpend / limit`, the pool Cursor's own dashboard calls included usage (`displayMessage`: "You've used 34% of your included usage"). `used_units` and `limit_units` hold the raw cents.

Both track the same spend against different denominators, so `monthly_included` always burns faster and is therefore the binding bucket. Reporting it is the conservative reading and the one that matches what a Cursor user sees.

## Validation

```bash
node --test /home/kenan/tools/pi-runtime/plan-meter/plan-meter.test.mjs
plan-meter doctor
systemctl status plan-meter.timer --no-pager
```

The test drives a complete sampling round against a fake provider for all three families, asserts that an expired token becomes a gap rather than a refresh, that a scoped weekly bucket is captured, that burn survives a reset, that capacity normalizes across window lengths, and that credential material never reaches the database.

`doctor` fails when the schema drifts or no sample has landed in three hours, which is the signal that the timer has stopped.

## Deployment

GMKtec declares `plan-meter.service` and `plan-meter.timer` in `/etc/nixos/configuration.nix`. Converge carries equivalent units in `/etc/systemd/system/`, installed by root, because that host is Debian rather than NixOS. Both run as `kenan` every ten minutes with a randomised delay. The executable is symlinked to `~/.local/bin/plan-meter` by [`deploy`](../deploy).
