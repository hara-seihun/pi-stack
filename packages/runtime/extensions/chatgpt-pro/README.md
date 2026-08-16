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

A picker label is only request intent. Returned text is accepted only when ChatGPT's persisted conversation has all of:

- user `resolved_model_slug=gpt-5-6-pro`;
- final assistant `model_slug=gpt-5-6-pro`;
- `pro_skipped=false` plus either the earlier `pro_progress=100` marker or the current complete-reasoning proof: a successful Pro work node, positive finished duration, `reasoning_status=reasoning_ended`, ordered start/end timestamps, and one matching `working_turn_id` across work, reasoning, and final answer;
- a complete, successful end-turn leaf.

Current ChatGPT responses no longer always carry `pro_progress`, and no longer carry the older `metadata.is_complete`. The provider accepts neither omission by itself: it requires the complete-reasoning proof above when progress is absent, and proves message completion from a `current_node` with no children plus `status=finished_successfully` and `end_turn=true`. A Pro POST stream can close while server-side reasoning remains async (`async_status=3`), and ChatGPT can even emit an intermediate assistant update with `end_turn=true` while `pro_work_status=in_progress`, `reasoning_status=is_reasoning`, and progress is far below 100. Stream closure, assistant end-turn alone, and partial DOM text therefore never end a Pro provider turn: it keeps the signed browser alive and polls persisted conversation state until the full execution invariant appears. Only an explicitly finished non-Pro route may terminate early for fail-closed rejection. `async_status` can remain `4` until the active browser closes and then normalize to `null`, so it is retained as diagnostics rather than misclassified as message incompleteness.

The browser session is deleted in every outcome. Deletion saves profile changes. The response wait is 2 hours 45 minutes inside a three-hour Kernel browser lifetime and matching three-hour entitlement lease, so an hour-scale Pro turn neither times out early nor permits an overlapping launch. Persisted progress, work-node creation, and message timestamps drive an activity marker; 45 minutes with no activity is treated as a server stall, the visible response is stopped before cleanup, and the entitlement cools for four hours. Verified and rejected provider evidence is owner-only under `/home/kenan/data/agent-orchestrator/pro/provider-audit/`; unverified text never reaches Pi as an answer.

`~/.pi/agent/chatgpt-pro-profiles.json` is the owner-only admitted entitlement list. It accepts one to four unique Kernel profile names and rejects any larger configuration. `~/.pi/agent/chatgpt-pro-pool.json` is generated owner-only state for those profiles; each profile independently holds its in-flight lease, cooldown, fallback streak, and last verified time. The orchestrator and frontier `launch_pro` tool read and mutate the same locked state. The machine-wide ceiling is four simultaneous Pro agents by operator request, while actual concurrency is the smaller count of independently authenticated eligible profiles. A persisted route to another model is rejected and starts a per-profile exponential allowance-probe cooldown (15 minutes up to four hours); one verified Pro turn resets that profile's backoff.

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
