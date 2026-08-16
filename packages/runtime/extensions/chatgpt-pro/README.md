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

The provider acquires the one reusable Kernel profile `limmy-google`, launches a direct-egress browser, attaches with Playwright over Kernel's CDP URL, and drives the genuine ChatGPT page. Kernel stealth mode is deliberately off: both its default proxy and direct egress have been tested, and direct egress avoids making proxy reputation another routing variable. It verifies the authenticated `/api/auth/session`, moves the live Intelligence slider to **Pro**, and requires the picker to show both **GPT-5.6 Sol** and **Effort Pro** before submitting.

A picker label is only request intent. Returned text is accepted only when ChatGPT's persisted conversation has all of:

- user `resolved_model_slug=gpt-5-6-pro`;
- final assistant `model_slug=gpt-5-6-pro`;
- `pro_skipped=false` plus either the earlier `pro_progress=100` marker or the current complete-reasoning proof: a successful Pro work node, positive finished duration, `reasoning_status=reasoning_ended`, ordered start/end timestamps, and one matching `working_turn_id` across work, reasoning, and final answer;
- a complete, successful end-turn leaf.

Current ChatGPT responses no longer always carry `pro_progress`, and no longer carry the older `metadata.is_complete`. The provider accepts neither omission by itself: it requires the complete-reasoning proof above when progress is absent, and proves message completion from a `current_node` with no children plus `status=finished_successfully` and `end_turn=true`, read only after the response stream itself has finished. `async_status` can remain `4` until the active browser closes and then normalize to `null`, so it is retained as diagnostics rather than misclassified as message incompleteness.

The browser session is deleted in every outcome. Deletion saves profile changes. Verified and rejected provider evidence is owner-only under `/home/kenan/data/agent-orchestrator/pro/provider-audit/`; unverified text never reaches Pi as an answer.

`~/.pi/agent/chatgpt-pro-pool.json` is generated owner-only state for this one material browser/account entitlement. It holds the in-flight lease, cooldown, fallback streak, and last verified time. The orchestrator reads the same state, so it does not launch a second Pro turn while this profile is occupied. A persisted route to another model is rejected and starts an exponential allowance-probe cooldown (15 minutes up to four hours); one verified Pro turn resets that backoff. There is no unrelated numeric stream limit.

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

A second OAuth-pool identity, isolated in `limmy-google` because the two simultaneous website identities are incompatible, reports a Pro plan and has completed persisted genuine GPT-5.6 Pro turns. It is the canonical browser profile for this provider. A live Pi turn reproduced the full invariant end to end and recorded `pro_execution_verified=true` in provider audit. On 2026-08-16 ChatGPT changed short Pro turns from the earlier `pro_progress=100` schema to the complete-reasoning schema documented above; a fresh persisted turn proved that schema, while the immediately following request was genuinely routed to GPT-5.5 Mini and correctly rejected. OpenAI documents separate rolling allowances for Pro models but exposes no machine-readable counter or guaranteed reset interval. The campaign task remains cancelled solely because Hara has not activated that lane.

## Capacity expansion

Only `limmy-google` is an admitted Pro entitlement. Other locally owned Limmy login records exist in canonical Proton Pass custody but have not proved a Pro subscription. Kernel currently permits three managed-auth connections, all used by the Pro profile, primary Google, and Wealthsimple. Candidate credentials created during investigation were deleted rather than retained without an owning connection, and existing operational connections were not displaced. A future additional profile requires a real managed-auth slot and the same persisted-conversation canary before it may enter provider capacity.

## Deployment and validation

The source of truth is this directory in `/home/kenan/tools/pi-runtime`. The runtime `deploy` flow installs the pinned `playwright-core` dependency, links this directory into Pi's global extension directory, runs tests, and validates Pi plus the orchestrator.

Registration checks do not consume Pro allowance:

```bash
pi --verbose --list-models pro
orchestrator check
orchestrator governor
```

A live validation must be a Pi request and must leave `pro_execution_verified=true` in the newest provider-audit JSON. Only then may the cancelled research Pro task be reopened.

Removal means deleting this source directory and its Pi extension and `~/.local/bin/pro` deploy links, removing `playwright-core` if unused, deleting the generated pool/audit state, deleting the Kernel `chatgpt.com` managed-auth connection if no other workflow uses it, and deploying again.
