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
  and the core journal. Successful sampling clears the error. Attempts are
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
- The scoped weekly meter is Fable's alone; Opus never touches it. The usage
  endpoint labels `weekly_scoped` with model `Fable`. Fable also drains
  `weekly_all`, so its weekly headroom is the smaller of those two readings on
  each account. Opus drains the session and all-models weekly meters. A scoped
  exhaustion must not prevent Opus from using an account with all-models
  headroom. On 2026-09-24 the three sampled accounts reported all-models
  utilization of 100%, 96%, 100% and Fable-scoped utilization of 73%, 63%,
  83%. Fable's usable weekly headroom was 0%, 4%, 0%, not 27%, 37%, 17%.
  The Fable plan reading requires both weekly meters to be fresh. Raw meter
  histories remain separate for spending calibration.
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
settlement; a failed repair never retries the rejected credential. Ordinary
interactive sessions can continue on an eligible sibling when shared credential
state excludes the failed account. Assigned sessions retain their admission pin.
The broker preserves the upstream error body and request ID, and returns
URL-encoded repair diagnostics in `x-pi-credential-repair`. No repair spends a
usage reset.

### Credential rejection recovery

On September 29, 2026, GMKtec account `openai-codex-8` returned `Your authentication
token has been invalidated. Please try signing in again.` on an ordinary request.
The classification omitted invalidated and revoked tokens, so routing never
attempted shared repair. Explicit `account refresh` succeeded at 19:30:54 UTC,
and a pinned `openai-codex-8/gpt-6.1-sol` request answered `OK`.

Invalidated, revoked and expired token rejects share the credential vocabulary
across ordinary and assigned routing, nested provider operations, the broker,
native completions and the provider meters. Each consumer permits one shared
compare-and-swap refresh and no second refresh of a freshly rejected token.
Broker and completion HTTP error bodies are inspected as well as status, so an
explicit token rejection in a 403 is repairable without treating every 403 as an
authentication failure. Completion replay is restricted to pre-execution HTTP
auth rejection; accepted-stream loss remains indeterminate and is never replayed.
Ambiguous inference 404 still needs the fixed usage endpoint's corroboration,
including before quarantining a fresh token rejected with 404. Explicit stream
error events also repair shared custody for subsequent callers (or quarantine a
second rejected token), but neither broker nor completion replays a stream already
accepted by the provider.

The account's shared `auth.json` OAuth entry owns `piCredentialState`. No rejected
token values are copied to a second store. A known-bad or expired access token
is marked `refresh-required` before refreshing, so process death or failed
refresh transport cannot admit it again. A transport failure retains the grant
and schedules another refresh after sixty seconds; the next due meter poll
attempts recovery, while routing and fleet/completion admission exclude it.
Transport failure during proactive refresh of a still-live token does not mark
it rejected. Network failures without any credential rejection never trigger
OAuth repair.

Definitive refresh-grant refusal (`invalid_grant`, invalidated/reused refresh
tokens or 401), an unchanged rejected access token, identity mismatch, or a second
corroborated fresh-token rejection marks `login-required`. That state survives
restarts and cooldown expiry; new admissions and automatic credential resolution
refuse it. Meters report the credential failure without spending another refresh.
`pi-orchestrator account login ALIAS` or importing a replacement credential clears
it. An explicit `pi-orchestrator account refresh ALIAS` can retry a quarantined
grant; successful refresh clears the state, failed refresh retains the appropriate
state. `account enable` and rate-limit cooldown expiry do not clear it. Shared-lock
compare-and-swap ensures late rejections of a superseded token do not quarantine
the replacement.

Randomized/early usage resets and their exploitation statistics are covered
in [openai-reset-statistics.md](openai-reset-statistics.md).
