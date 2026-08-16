# ChatGPT Pro provider

This extension exposes the signed-in ChatGPT web account to Pi as two fail-closed, text-only models:

- `chatgpt-pro/gpt-5-6-pro`
- `chatgpt-pro/gpt-5-6-pro-literal`

The literal model sends a single user prompt unchanged. It is the model used for fully assembled mathematical moonshots. The ordinary model serializes Pi conversation text but cannot execute Pi tools.

## Transport and verification

The provider acquires the one reusable Kernel profile `limmy-google`, launches a direct-egress browser, attaches with Playwright over Kernel's CDP URL, and drives the genuine ChatGPT page. Kernel stealth mode is deliberately off: both its default proxy and direct egress have been tested, and direct egress avoids making proxy reputation another routing variable. It verifies the authenticated `/api/auth/session`, moves the live Intelligence slider to **Pro**, and requires the picker to show both **GPT-5.6 Sol** and **Effort Pro** before submitting.

A picker label is only request intent. Returned text is accepted only when ChatGPT's persisted conversation has all of:

- user `resolved_model_slug=gpt-5-6-pro`;
- assistant `model_slug=gpt-5-6-pro`;
- `pro_progress=100`;
- `pro_skipped=false`;
- a complete, successful end-turn leaf. Current ChatGPT responses no longer carry the older `metadata.is_complete`; the equivalent persisted proof is a `current_node` with no children plus `status=finished_successfully` and `end_turn=true`, read only after the response stream itself has finished. `async_status` can remain `4` until the active browser closes and then normalize to `null`, so it is retained as diagnostics rather than misclassified as message incompleteness.

The browser session is deleted in every outcome. Deletion saves profile changes. Verified and rejected provider evidence is owner-only under `/home/kenan/data/agent-orchestrator/pro/provider-audit/`; unverified text never reaches Pi as an answer.

`~/.pi/agent/chatgpt-pro-pool.json` is generated owner-only state for this one material browser/account entitlement. It holds the in-flight lease, cooldown, and last verified time. The orchestrator reads the same state, so it does not launch a second Pro turn while this profile is occupied. There is no unrelated numeric stream limit.

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

A second OAuth-pool identity, isolated in `limmy-google` because the two simultaneous website identities are incompatible, reports a Pro plan and has completed a persisted genuine GPT-5.6 Pro turn (`resolved_model_slug=model_slug=gpt-5-6-pro`, progress 100, not skipped, successful complete end turn). It is the canonical browser profile for this provider. A subsequent live Pi turn reproduced the full invariant end to end and recorded `pro_execution_verified=true` in provider audit. The campaign task remains cancelled solely because Hara has not activated that lane.

## Deployment and validation

The source of truth is this directory in `/home/kenan/tools/pi-runtime`. The runtime `deploy` flow installs the pinned `playwright-core` dependency, links this directory into Pi's global extension directory, runs tests, and validates Pi plus the orchestrator.

Registration checks do not consume Pro allowance:

```bash
pi --verbose --list-models pro
orchestrator check
orchestrator governor
```

A live validation must be a Pi request and must leave `pro_execution_verified=true` in the newest provider-audit JSON. Only then may the cancelled research Pro task be reopened.

Removal means deleting this source directory and its deploy link, removing `playwright-core` if unused, deleting the generated pool/audit state, deleting the Kernel `chatgpt.com` managed-auth connection if no other workflow uses it, and deploying again.
