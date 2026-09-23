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
- Both samplers resolve credentials through `SharedOAuthAuth` in
  `src/auth/shared-oauth.ts`, exactly as interactive and fleet sessions do.
  The shared directory lock covers reading, refreshing and atomically writing
  the credential. A competing consumer rereads the rotated credential after
  taking that lock, rather than spending the same refresh token twice.
- On 2026-09-07, refusing sampler refresh stranded two idle Anthropic accounts.
  Expired tokens prevented fresh meters, and stale meters prevented the next
  session that could refresh them. Sampling now refreshes idle credentials
  automatically, without a model request or an account reset.
- Refresh failures preserve the credential and appear in `status.meterErrors`
  and the daemon journal. Successful sampling clears the error. Attempts are
  spaced by the provider's sampling interval even when credentials or requests
  fail, or an account does not report every declared bucket. Provider-rejected
  refresh credentials require a new provider-issued OAuth login.

## Normalization

The useful headline is **tokens per week per plan**: normalize every window
to seven days so windows of different lengths (5-hour, weekly, monthly) are
directly comparable, and measure each account against whichever of
its meters exhausts first. Pricing account type against model (Codex Pro on
Astra vs Luna, Max 20x on Opus vs Fable) requires solving meter movement
against each account's model mix — Fable burns a half-sized scoped weekly
meter that Opus never touches (see the Anthropic topology in the calibrator
tests).

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

### Codex credential rejection reported as 404

On September 15, 2026, `openai-codex-11` served Astra through about
17:08 UTC, then began returning `Not Found` at 17:11:32 UTC. Twelve failed
inference attempts recorded zero tokens. Native diagnostics showed a WebSocket
failure followed by SSE failure. The same account's fixed usage endpoint also
returned HTTP 404, while another account remained healthy. The rejected token
had not reached its stored expiry.

`pi-orchestrator account refresh openai-codex-11` rotated the shared credential
at 17:20:47 UTC. An immediate request through Node HTTPS to the same usage
endpoint returned HTTP 200 for the same account identity, with Pro, Astra
availability and 72% weekly use. The original meter retained only the HTTP
status, so there is no known rejection-body signature from this incident.

The fixed `https://chatgpt.com/backend-api/codex/usage` route now treats 401
and 404 as grounds for one `SharedOAuthAuth.refreshRejected` operation and
one repeat poll. Other statuses do not trigger refresh. Failure reports retain
the initial status, request ID and a bounded response excerpt alongside the
repair or second-request error. Failed attempts still obey the sampling interval.

Interactive inference only considers bare `Not Found` from the official Codex
endpoint with zero reported tokens. Native compaction applies the same endpoint
check. The ordinary-user broker owns a fixed Codex inference route and can inspect
the HTTP status directly. These consumers first check the usage endpoint with
the token used by the failed request. A 401 or 404 there corroborates credential
rejection. A healthy usage response, another status or a failed probe leaves the
inference failure intact without refreshing or replaying it. Unknown models,
custom endpoints and missing response references are not credential failures.

Each poll, broker request and compaction operation permits one repair. Interactive
sessions permit one repair per account until a request succeeds. Native
provider streams capture the token actually submitted, so a concurrent meter
refresh makes the shared lock return the replacement rather than rotate it again.
Interactive diagnostics persist as `credential-repair` session entries. A
successful repair queues the existing same-account continuation only after
settlement; a failed repair never queues another turn. The broker preserves the
upstream error body and request ID, and returns URL-encoded repair diagnostics
in `x-pi-credential-repair`. Neither path changes account affinity or spends a
usage reset.

Randomized/early usage resets and their exploitation statistics are covered
in [openai-reset-statistics.md](openai-reset-statistics.md).
