# Provider meter notes

Operational facts about subscription meters, learned from running the
predecessor sampler (plan-meter) for months. They constrain how meter
readings should be collected and interpreted here.

## General

- Meters are server-side and global per account. Two machines sampling the
  same account see the same reading; readings deduplicate by account while
  usage events sum per machine.
- Most providers report used percentage as a whole number. Short-window
  calibration against a 1% quantum is noise; the calibrator must treat a
  reading as an interval, not a point.
- History cannot be backfilled. A window that resets before it is sampled is
  unrecoverable evidence of what that window bought, which is why readings
  should be captured continuously (response headers on every request, or a
  sampler) rather than on demand.
- Never refresh OAuth tokens from a sampler. Refresh tokens are single-use;
  an independent refresh revokes the token family out from under pi. Read
  `auth.json` access tokens without refreshing and record an expired token as
  a gap.

## Normalization

The useful headline is **tokens per week per plan**: normalize every window
to seven days so Codex/Anthropic weekly windows and Cursor's monthly billing
cycle are directly comparable, and measure each account against whichever of
its meters exhausts first. Pricing account type against model (Codex Pro on
Sol vs Luna, Max 20x on Opus vs Fable) requires solving meter movement
against each account's model mix — Fable burns a half-sized scoped weekly
meter that Opus never touches (see the Anthropic topology in the calibrator
tests).

## Cursor

- Cursor publishes two counters for one cycle that disagree by roughly 13x.
  Only the percentage (`monthly`) is a limit. The dollar figure its
  dashboard calls "included usage" is a retail-value estimate that blocks
  nothing; record it as a balance, never gate on it.
- Cursor's agent stream carries no cache accounting at all, so stream-side
  usage books the whole context as fresh input and shows a zero cache-hit
  rate. That is a reporting gap, not a caching failure: the dashboard
  `GetAggregatedUsageEvents` RPC reports the real split. Cost weights for
  Cursor must be corrected from that RPC, not taken from stream usage.

## OpenAI

Randomized/early usage resets and their exploitation statistics are covered
in [openai-reset-statistics.md](openai-reset-statistics.md).
