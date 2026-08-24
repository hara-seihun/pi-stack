# ChatGPT Pro provider for Pi

A Pi provider that drives an authenticated ChatGPT browser session, requests the Pro model, closes billable browser sessions between polls, and returns text only after persisted conversation evidence verifies Pro execution and completion.

This is a browser bridge, not an OpenAI API adapter. It depends on the `kernel` CLI, an authenticated Kernel profile, and the current ChatGPT web interface.

## Configuration

By default the provider reads `$XDG_CONFIG_HOME/pi-runtime/chatgpt-pro.json` (falling back to `~/.config/pi-runtime/chatgpt-pro.json`). Override it with `PI_CHATGPT_PRO_CONFIG`.

```json
{
  "version": 1,
  "profiles": ["chatgpt-primary"],
  "profileProviders": {
    "chatgpt-primary": "openai-codex-2"
  },
  "subscriptions": [
    {
      "provider": "openai-codex",
      "index": 2,
      "lifecycle": {
        "state": "cancelled",
        "accessUntil": "2027-01-01T00:00:00.000Z"
      }
    }
  ]
}
```

`profiles` contains one to four Kernel profile names. `profileProviders` and `subscriptions` are optional; when supplied, a cancelled entitlement is excluded before a lease could outlive its access window.

Runtime locations follow XDG conventions:

- state: `$XDG_STATE_HOME/pi-runtime/chatgpt-pro`
- audits and recovered responses: `$XDG_DATA_HOME/pi-runtime/chatgpt-pro`

Override them with `PI_CHATGPT_PRO_STATE_DIR` and `PI_CHATGPT_PRO_DATA_DIR`. Set `PI_CHATGPT_PRO_ALERTS_INBOX` to write UI-contract failures into a host-owned inbox; otherwise they are reported on stderr.

## Execution invariant

A response is accepted only when persisted ChatGPT data ties the user request and final assistant node to `gpt-5-6-pro`, records successful terminal work, shows no fallback or skipped Pro work, and identifies the final node as the conversation leaf. Unverified response text remains in the owner-only audit directory and is never returned as an answer.

The browser contract is intentionally strict. Missing model controls, changed labels, blocking dialogs, or ambiguous completion evidence fail loudly as `pro-ui-changed` rather than silently consuming another entitlement.

## Test

```sh
node --test browser.test.mjs launcher.test.mjs
```

Tests use synthetic persisted conversations and do not require credentials.
