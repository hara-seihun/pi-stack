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

## Anthropic

- Anthropic stamps `anthropic-ratelimit-unified-<window>-*` headers on every
  response, but a response reports only the windows *its own request* was
  metered against. The scoped weekly window (`7d_oi`) rides only on traffic
  scoped to that model, so an account running Opus emits `5h` and `7d` and
  nothing else and its scoped meter never exists. Headers are also
  machine-local: an account shared with an off-machine client reads as idle
  while its plan drains. Both gaps overstate headroom, so headers alone are
  not a meter source for this provider either — poll
  `GET https://api.anthropic.com/api/oauth/usage`, which returns every bucket
  of the plan on every call.
- That response's `limits` array is the authority. The older top-level fields
  carry no scoped weekly bucket at all (`seven_day_opus` is null on these
  plans, and is *not* this bucket), so reading them reintroduces the hole.
- The scoped weekly meter is **Fable's alone; Opus never touches it**.
  Verified from production traffic: readings on `7d_oi` begin exactly when an
  account starts running Fable and never appear for Opus-only accounts, and
  the usage endpoint labels the same bucket `weekly_scoped` on model "Fable".
  Opus drains the session and all-models weekly meters, which is why no card
  or meter may be labelled "Opus".
- Poll due-ness must be judged on the **stalest** of an account's meters. A
  running session refreshes `5h` and `7d` from headers continuously; judging
  on the freshest reading would leave the very bucket the poll exists to
  supply permanently "not due".

## OpenAI

- Codex publishes no meter state pi can observe: the default transport is a
  WebSocket, so there is no HTTP response carrying rate-limit headers. The
  account plan is readable only by polling
  `GET https://chatgpt.com/backend-api/codex/usage`, which returns each
  window's integer used-percent, its length in seconds, and its reset
  instant. Window length is the only reliable meter identity: a Pro account
  reports one weekly window and no five-hour window at all.
- `additional_rate_limits` in that response meters individual models
  (`GPT-5.3-Codex-Spark`), not the account plan. Pacing against it would
  price one model's allowance as the whole subscription.
- The endpoint sits behind a bot filter that judges how the connection is
  opened, not who is calling. The first request on a fresh node `fetch`
  (undici) connection is answered 403 with perfectly valid credentials; a
  second request on the same warm socket succeeds, so a poller walking a
  fleet of accounts sees failures that look intermittent and per-account. The
  identical request through node's own `https` module succeeds cold, every
  time — so the transport is the fix, not a retry. A default
  `User-Agent: node` is refused the same way; send a real client name.
  Expect any new node client of a chatgpt.com backend route to need both.

Randomized/early usage resets and their exploitation statistics are covered
in [openai-reset-statistics.md](openai-reset-statistics.md).
