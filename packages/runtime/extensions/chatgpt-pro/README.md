# ChatGPT Pro provider

This extension exposes the signed-in ChatGPT web account to Pi as two fail-closed, text-only models:

- `chatgpt-pro/gpt-5-6-pro`
- `chatgpt-pro/gpt-5-6-pro-literal`

The literal model sends a single user prompt unchanged. It is the model used for fully assembled mathematical moonshots. The ordinary model serializes Pi conversation text but cannot execute Pi tools.

## Transport and verification

The provider acquires the one reusable Kernel profile `kenan-personal`, launches a direct-egress browser, attaches with Playwright over Kernel's CDP URL, and drives the genuine ChatGPT page. Kernel stealth mode is deliberately off: both its default proxy and direct egress have been tested, and direct egress avoids making proxy reputation another routing variable. It verifies the authenticated `/api/auth/session`, moves the live Intelligence slider to **Pro**, and requires the picker to show both **GPT-5.6 Sol** and **Effort Pro** before submitting.

A picker label is only request intent. Returned text is accepted only when ChatGPT's persisted conversation has all of:

- user `resolved_model_slug=gpt-5-6-pro`;
- assistant `model_slug=gpt-5-6-pro`;
- `pro_progress=100`;
- `pro_skipped=false`;
- a complete, successful end-turn leaf.

The browser session is deleted in every outcome. Deletion saves profile changes. Verified and rejected provider evidence is owner-only under `/home/kenan/data/agent-orchestrator/pro/provider-audit/`; unverified text never reaches Pi as an answer.

`~/.pi/agent/chatgpt-pro-pool.json` is generated owner-only state for this one material browser/account entitlement. It holds the in-flight lease, cooldown, and last verified time. The orchestrator reads the same state, so it does not launch a second Pro turn while this profile is occupied. There is no unrelated numeric stream limit.

## Authentication

Kernel Managed Auth owns the `chatgpt.com` connection attached to `kenan-personal`. It uses the shared Google credential and has health checks plus automatic reauthentication enabled. Locate it by domain rather than persisting its generated connection id:

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

The browser implementation is operational but the currently authenticated ChatGPT account is still routed to GPT-5.5 Mini. On 2026-08-15, two real Pi turns selected and verified **GPT-5.6 Sol / Pro** in the web UI and sent `model=gpt-5-6-pro`. Kernel's stealth proxy produced persisted `resolved_model_slug=gpt-5-5-mini`. Direct egress briefly reported Pro in the response stream and rendered `data-message-model-slug=gpt-5-6-pro` plus a Pro feedback control, but the authenticated persisted conversation still resolved to `gpt-5-5-mini`. This demonstrates why visible picker, DOM model attributes, response speed, and intermediate stream metadata are not sufficient acceptance evidence.

The provider therefore remains fail-closed and the campaign Pro task remains cancelled. The likely remaining boundaries are account-side allowance/restriction or server routing, not missing browser mechanics. A different genuinely entitled ChatGPT web account is now a clean test: attach its managed-auth connection to a separate Kernel profile and require the same persisted invariant before adding it to capacity.

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
