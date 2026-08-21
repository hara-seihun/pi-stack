# ChatGPT Pro provider

This extension exposes the signed-in ChatGPT web account to Pi as two fail-closed, text-only models:

- `chatgpt-pro/gpt-5-6-pro`
- `chatgpt-pro/gpt-5-6-pro-literal`

The literal model sends a single user prompt unchanged. It is the model used for fully assembled mathematical moonshots. The ordinary model serializes Pi conversation text but cannot execute Pi tools.

The deployed `pro` command is the direct interactive and print-mode entry point. It is only a thin Pi invocation using the ordinary verified model at Pro effort with local tools disabled:

```bash
pro
pro --print 'Solve this problem carefully.'
```

The equivalent explicit Pi command is:

```bash
pi --model chatgpt-pro/gpt-5-6-pro:max --no-tools
```

## Transport and verification

The provider acquires one eligible profile from the admitted Kernel pool (currently `limmy-google`), launches a direct-egress browser, attaches with Playwright over Kernel's CDP URL, and drives the genuine ChatGPT page. Kernel stealth mode is deliberately off: both its default proxy and direct egress have been tested, and direct egress avoids making proxy reputation another routing variable. It verifies the authenticated `/api/auth/session`, moves the live Intelligence slider to **Pro**, and requires the picker to show both **GPT-5.6 Sol** and **Effort Pro** before submitting.

A picker label is only request intent. The submitting browser stays open only until the conversation URL exists, the POST has returned successful response headers, and the outgoing model is confirmed as `gpt-5-6-pro`; it is then deleted immediately. ChatGPT owns the asynchronous reasoning after submission. Returned text is accepted only when a later short-lived polling browser reads a persisted conversation with all of:

- user `resolved_model_slug=gpt-5-6-pro`;
- final assistant `model_slug=gpt-5-6-pro`;
- `pro_skipped=false` plus either the earlier `pro_progress=100` marker or the current complete-reasoning proof: a successful Pro work node, positive finished duration, `reasoning_status=reasoning_ended`, ordered start/end timestamps, and one matching `working_turn_id` across work, reasoning, and final answer;
- a complete, successful end-turn leaf.

Current ChatGPT responses no longer always carry `pro_progress`, and no longer carry the older `metadata.is_complete`. The provider accepts neither omission by itself: it requires the complete-reasoning proof above when progress is absent, and proves message completion from a `current_node` with no children plus `status=finished_successfully` and `end_turn=true`. A Pro POST stream can close while server-side reasoning remains async (`async_status=3`), and ChatGPT can even emit an intermediate assistant update with `end_turn=true` while `pro_work_status=in_progress`, `reasoning_status=is_reasoning`, and progress is far below 100. Stream closure, assistant end-turn alone, and partial DOM text therefore never end a Pro provider turn. Instead, the provider opens the same authenticated profile once every twenty minutes, reads persisted state once, and deletes that polling browser immediately. Only the persisted execution invariant can return text; an explicitly finished non-Pro route terminates early for fail-closed rejection. `async_status` is retained as diagnostics rather than misclassified as message incompleteness.

Every Kernel browser is billable, so none is retained while ChatGPT reasons. Submission and each twenty-minute check use a browser with a five-minute safety timeout, normally delete it within seconds, and retry deletion before allowing cleanup to succeed. The logical entitlement lease—not a browser—remains held for the full turn. The response horizon is three hours inside a three-hour-twenty-minute lease. Persisted progress, work-node creation, and message timestamps drive an activity marker; an hour without persisted activity is treated as a server stall, and the next scheduled polling browser stops the visible response before deletion. Verified and rejected provider evidence is owner-only under `/home/kenan/data/chatgpt-pro/provider-audit/`; unverified text never reaches Pi as an answer.

`~/.pi/agent/chatgpt-pro-profiles.json` is the owner-only admitted entitlement list. It accepts one to four unique Kernel profile names, maps Codex-backed profiles to their provider aliases, and rejects any larger or malformed configuration. The mapping lets the provider honor cancellation lifecycle from `~/.pi/agent/multi-pass.json`: it stops granting new Pro leases when the remaining paid access cannot contain the full three-hour-twenty-minute lease, and removes the profile at access end. `~/.pi/agent/chatgpt-pro-pool.json` is generated owner-only state for those profiles; each profile independently holds its in-flight lease, cooldown, and last verified time. The orchestrator and frontier `launch_pro` tool read and mutate the same locked state. The machine-wide ceiling is four simultaneous Pro agents by operator request, while actual concurrency is the smaller count of independently authenticated eligible profiles. Profiles are selected round-robin (least selections first). A routed fallback to another model means the account's Pro allowance is exhausted: the account rests for a full day (`FALLBACK_COOLDOWN_MS`) while the rotation continues on the others; a verified Pro turn clears the cooldown early only in the sense that future selections resume normally.

## Authentication

Kernel Managed Auth owns the `chatgpt.com` connection attached to `limmy-google`. It uses the dedicated Limmy Google credential and has health checks plus automatic reauthentication enabled. Locate it by domain rather than persisting its generated connection id:

```bash
kernel auth connections list --domain chatgpt.com -o json
```

If it reports `NEEDS_AUTH`, call `login` on that connection and complete the hosted flow. Do not create another profile or connection as reauthentication recovery.

## Why browser automation

Codex OAuth tokens expose the Pro model in the catalog but ChatGPT routed every private-endpoint probe to GPT-5.5 Mini, including current Sentinel preparation and headed Chrome cookies. The missing boundary was a genuinely signed-in ChatGPT web session. Current independent implementations converge on that design:

- [Oracle](https://github.com/steipete/oracle) has current GPT-5.6 unified-picker support, fail-closed Pro effort selection, long-run recovery, and CDP browser control.
- [agbrowse](https://github.com/lidge-jun/agbrowse) separates send from durable polling and drives the current flat Intelligence picker.
- [pro-bridge](https://github.com/alubato0127/pro-bridge) verifies semantic assistant-turn model metadata from a real CDP browser.

This provider takes the smallest useful combination: Kernel supplies the maintained authenticated browser/profile lifecycle, Playwright supplies semantic UI control, and persisted ChatGPT conversation metadata supplies stronger execution proof than picker state or model self-identification. OpenAI's current documentation identifies Pro as GPT-5.6 Sol Pro and notes that manually selected reasoning can fall back after allowances are reached: <https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt>.

## 2026-08-17 mini-routing episode and the 2026-08-19 interstitial (resolved)

Two distinct failures overlapped and were untangled on 2026-08-19.

**Mini fast-routing (2026-08-17T04:53Z – 2026-08-18):** every submission on all
four profiles ended with `ChatGPT router resolved gpt-5-5-mini instead of
gpt-5-6-pro`. All probing during the episode used trivial canary prompts
(`Reply with exactly: PROBE-OK`), which ChatGPT is entitled to Pro-skip. The
decisive experiment — a real heavy research prompt — ran on 2026-08-19T16:32:52Z
(conversation `6a85daaa…` on `chatgpt-codex-06`, the queued A3 rank-6/7
question): the user message persisted `resolved_model_slug=gpt-5-6-pro`, Pro
work `in_progress` with real progress percentage, `reasoning_status=is_reasoning`,
all tool/assistant messages `model_slug=gpt-5-6-pro`. The fast-route condition
does not fire on real prompts; the episode either ended on its own or never
applied to genuine workloads. The four `pro-fallback`/`browser-operation`
cooldowns expired naturally. **The model-verification invariant stands as
written**: `resolved_model_slug` on the persisted user message still means the
route the backend actually took, and `pro_execution_verified` still requires
it to equal `gpt-5-6-pro`.

Residual anomalies from the episode, kept for the record: during canary probes
the stream's `server_ste_metadata` reported `fast_convo: true` with
`model_slug: gpt-5-5-mini` while assistant messages carried
`model_slug: gpt-5-6-pro`, and the composer's new `thinking_effort` request
field stayed `"standard"` across genuine slider transitions. Neither pattern
appeared on the real-prompt run. If mini-routing recurs on a real prompt,
re-run the reproduction recipe below before touching the invariant.

**Send-click interstitial (2026-08-19T16:30–16:32Z):** three consecutive turn
attempts on `chatgpt-codex-06`/`-09`/`-08` died with
`locator.click: Timeout 30000ms exceeded` on the send button: a one-time
account interstitial rendered a full-screen `#modal-beacon` backdrop
(`data-state="open"`) that intercepted pointer events. The picker had verified
Pro correctly; only the send click was blocked. The modal was gone from all
profiles ~15 minutes later (interstitials are marked shown server-side after
first render) and never appeared on `limmy-google`. The fourth attempt
submitted cleanly.

Hardening shipped 2026-08-19 in response (`browser.mjs`):

1. **`ProUiChangedError`** (`code: "pro-ui-changed"`): every element-shape
   failure — missing composer, picker button, picker content, Power menu item,
   broken slider, changed verification labels, non-Pro close state, missing or
   disabled send button, blocked send click — raises this dedicated class with
   the observed DOM text, a screenshot under
   `~/data/chatgpt-pro/provider-audit/ui-changed-*.png`, and an
   alert written to `/var/lib/machine-alerts/inbox/`. The audit record carries
   `error_code`, `ui_stage`, and `ui_screenshot`. Navigation and
   authentication failures stay generic.
2. **Deliberate modal dismissal** (`dismissBlockingModals`): before the picker
   click and before the send click, any open `#modal-beacon`/full-screen
   backdrop is dismissed via close buttons, benign-text buttons
   (Close/Dismiss/Got it/…), then Escape. An intercepted send click gets one
   dismissal-and-retry; an undismissable modal or second interception raises
   the loud `pro-ui-changed` failure. The cooldown reason `pro-ui-changed`
   is distinct from `browser-operation`.

Reproduction recipe for router questions: create a Kernel browser with
`kernel browsers create --profile-name limmy-google --save-changes --start-url
https://chatgpt.com/ --output json`, attach with `playwright-core` over
`cdp_ws_url`, drive the picker exactly as `ensureProSelection` does, capture
the `POST .../conversation` request body and the full SSE response text, and
read `server_ste_metadata` from the tail of the stream. Judge Pro execution
only from the persisted conversation (`pro_execution_verified`), never from
picker state, DOM attributes, or response speed.

## Current routing status

The original `kenan-personal` ChatGPT identity remains routed to GPT-5.5 Mini. On 2026-08-15, real Pi turns selected and verified **GPT-5.6 Sol / Pro** in the web UI and sent `model=gpt-5-6-pro`; both Kernel proxy and direct egress still persisted `resolved_model_slug=gpt-5-5-mini`. One direct stream briefly reported Pro and rendered `data-message-model-slug=gpt-5-6-pro` plus a Pro feedback control, while the authenticated persisted conversation proved the Mini route. This demonstrates why visible picker, DOM model attributes, response speed, and intermediate stream metadata are not sufficient acceptance evidence.

A second OAuth-pool identity, isolated in `limmy-google` because the simultaneous website identities are incompatible, reports a Pro plan and became the first canonical browser profile. On 2026-08-16 the activated research lane produced an authenticated persisted GPT-5.6 Pro turn that worked for 135 minutes 10 seconds and satisfied the full execution invariant. Its mathematical response explicitly did not solve the unrestricted theorem and was classified accordingly; model verification does not imply mathematical acceptance. That run exposed ChatGPT's asynchronous work lifecycle: the initial POST and intermediate assistant updates ended long before Pro work did, so the provider now waits on persisted work completion. A separate turn stalled at 71.43% and was explicitly stopped rather than accepted. OpenAI documents separate rolling allowances for Pro models but exposes no machine-readable counter or guaranteed reset interval.

## Capacity expansion

All twelve Codex OAuth subscriptions report a Pro plan, and a direct model canary on 2026-08-16 succeeded on eleven; the remaining subscription was correctly authenticated but externally quota-exhausted until its reported reset. Codex OAuth plan identity is not browser execution proof.

Proton Mail Bridge and canonical Proton Pass credentials made eight distinct ChatGPT web identities persistently available in isolated Kernel profiles. The provider admits exactly four: `limmy-google`, `chatgpt-codex-06`, `chatgpt-codex-08`, and `chatgpt-codex-09`. The latter three simultaneously returned exact canary text with `resolved_model_slug=gpt-5-6-pro`, completed Pro work, matching working-turn identities, and `pro_execution_verified=true`; their owner-only audits are under the canonical provider-audit directory. The remaining authenticated profiles are reserve identities rather than hidden capacity because the operator ceiling is four. Accounts without either reachable email or complete Google 2-Step Verification custody were not represented as operational browser entitlements.

Kernel's managed-auth connection limit is three, so email-code bootstrap connections are deliberately short-lived after a successful profile save; the durable isolated profiles remain, and Proton Mail Bridge supplies the concrete reauthentication path. A profile may enter `chatgpt-pro-profiles.json` only after the same persisted-conversation canary.

## Deployment and validation

The source of truth is this directory in `/home/kenan/tools/pi-runtime`. The runtime `deploy` flow installs the pinned `playwright-core` dependency, links this directory into Pi's global extension directory, runs tests, and validates Pi plus the orchestrator.

Registration checks do not consume Pro allowance:

```bash
pi --verbose --list-models pro
orchestrator check
orchestrator governor
```

A live validation must be a Pi request and must leave `pro_execution_verified=true` in the newest provider-audit JSON. The active research lane uses the same invariant and remains unavailable while the entitlement lease or cooldown is occupied.

Removal means deleting this source directory and its Pi extension and `~/.local/bin/pro` deploy links, removing `playwright-core` if unused, deleting the generated pool/audit state, deleting the Kernel `chatgpt.com` managed-auth connection if no other workflow uses it, and deploying again.

## Durable turns and recovery

A submission's server conversation id is captured from the POST SSE stream
(the `/c/WEB:...` URL segment is an optimistic client placeholder the backend
API rejects) and registered under
`~/data/chatgpt-pro/pending/` until the turn reaches a terminal
outcome. A router fallback (`resolved_model_slug` ≠ `gpt-5-6-pro`) is detected
from the same stream within seconds and retried on another entitlement (up to
three) instead of failing the delegation. If a controller restart or abort
kills the polling side, ChatGPT keeps reasoning server-side and the pending
record survives: the controller harvests it automatically at startup, and
`orchestrator pro-recover [--from-audits DAYS]` does the same on demand
(audit-era orphans with placeholder ids are matched to real conversations by
prompt SHA-256 against the account's recent history). Verified recovered
responses become ordinary provider audits under `~/data/chatgpt-pro/`.

## Live progress streaming

The provider streams transport phases (entitlement selection, submission,
poll cadence, verification) as a thinking block, so interactive `pro` sessions
and orchestrator transcripts show live state during a multi-hour turn instead
of silence.
