# Bash timeout guard

A Pi extension that rejects bash calls without a positive `timeout`, calls past the session's ceiling, and commands that detach work from their session.

The canonical managing thread (`PI_THREAD_MANAGER=1`, stamped from immutable `metadata.manager === true`) has a hard five-second maximum, with or without a UI. This also covers `converge` with `action: "bash"`. Longer work belongs to workers.

Other sessions keep their existing ceilings: a UI-attached session (`ctx.hasUI`) gets 30 minutes (1800 seconds), and an autonomous session gets 55 seconds. Hosts can replace either worker default without changing the extension. Isolated application roots are not managers unless explicitly marked.

## Configuration

- `PI_THREAD_MANAGER=1` selects the manager cap. Shared runners capture it per session, never from their first session's inherited environment.
- `PI_BASH_TIMEOUT_MAX_SECONDS` sets the ceiling in seconds and may raise or lower the worker default; it cannot raise the manager cap.
- `PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS` carries a Pi Remote thread's saved ceiling and takes precedence over `PI_BASH_TIMEOUT_MAX_SECONDS`, even when its runtime does not report `ctx.hasUI`. Pi Remote sets it when it starts the thread runtime.
- `PI_BASH_TIMEOUT_CONTEXT` appends a short host-specific explanation to the injected rule.

The extension adds the rule to the system prompt once and checks every bash tool call before execution. A long job must become faster, split into bounded foreground work, or transfer to a durable service that owns its result.

Native Pi execution also enforces the manager budget at the tool boundary when this extension is absent. Omitted, invalid and over-five-second manager shell timeouts are explicit errors before execution. The deadline signals cancellation and returns uncertainty; unfinished cleanup stays tracked, so Stop cannot acknowledge it as stopped prematurely. Durable shell scopes have their own runtime deadline. Manager Converge shell calls bound the complete SSH operation with no transport or kill grace. Workers keep their normal execution limits.

Shared runner processes are not command-kill targets; there is no separate process-age sweep.

## Test

```sh
node --test guard.test.mjs
```
