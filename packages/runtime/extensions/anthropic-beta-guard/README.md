# Anthropic beta guard

Sends Anthropic's `context-1m-2025-08-07` beta only to models that have a
one-million-token window.

## The failure it repairs

`@pi-plugins/claude-oauth` advertises the whole Claude Code beta set on every
request. Anthropic rejects `context-1m-2025-08-07` for models that do not offer
that window, and answers:

```
400 {"type":"error","error":{"type":"invalid_request_error",
     "message":"The long context beta is not yet available for this subscription."}}
```

The message names the wrong thing. The subscription is fine and so is the
account; the header is wrong for that model. On GMKtec this made every 200K
Anthropic model — `claude-haiku-4-5`, `claude-opus-4-5` and their dated
variants — unusable on all three accounts, while every 1M model worked. Proven
2026-09-19 by sending the same request to `anthropic-3` twice, once with the
beta and once without: with it, 400; without it, a reply.

## Why it wraps fetch instead of using `before_provider_headers`

That hook fires before the plugin's headers exist, and the plugin installs a
`globalThis.fetch` wrapper that *unions* its beta list with whatever the
request already carries. A header removed above it is added back below it.

The only remaining position is underneath: this extension wraps fetch when it
loads, the plugin wraps that, and ours sees the final headers on the way out.

**Load order is therefore load-bearing.** This package must be registered
before `claude-oauth` in `config/packages.json`. The last case in
`guard.test.mjs` states that composition, so a future reorder fails a test
rather than silently restoring the bug.

## What it does and does not touch

- It reads the model id out of the outgoing body, not session state, because
  the wrapper runs below pi's request pipeline and a retry or a subagent can
  carry a different model than the session's current one.
- The context window comes from the model registry pi already loaded.
- A model the registry does not know, or a request with no such header, is left
  exactly as it was. Stripping a beta from a request that may be entitled to it
  would trade a loud failure for a quiet one.

## Test

```sh
node --test guard.test.mjs
```

End-to-end check against a real account, which is what actually proves it:

```sh
pi -p --no-tools --thinking off --no-session \
  --model anthropic-3/claude-haiku-4-5 "Reply with exactly: OK"
```
