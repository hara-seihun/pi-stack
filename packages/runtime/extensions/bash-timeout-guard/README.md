# Bash timeout guard

A Pi extension that rejects bash calls without a positive `timeout`, calls past the session's ceiling, and commands that detach work from their session.

The default ceiling depends on who is watching. A session with a UI attached (`ctx.hasUI`) gets 30 minutes (1800 seconds). Autonomous sessions get 55 seconds. Hosts can replace either default without changing the extension.

## Configuration

- `PI_BASH_TIMEOUT_MAX_SECONDS` sets the ceiling in seconds and may raise or lower the default.
- `PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS` carries a Pi Remote thread's saved ceiling and takes precedence over `PI_BASH_TIMEOUT_MAX_SECONDS`, even when its runtime does not report `ctx.hasUI`. Pi Remote sets it when it starts the thread runtime.
- `PI_BASH_TIMEOUT_CONTEXT` appends a short host-specific explanation to the injected rule.

The extension adds the rule to the system prompt once and checks every bash tool call before execution. A long job must become faster, split into bounded foreground work, or transfer to a durable service that owns its result.

Native Pi execution owns each tool's timeout and cancellation. Stop waits for local tools to stop before acknowledging. Shared runner processes are not command-kill targets; there is no separate process-age sweep.

## Test

```sh
node --test guard.test.mjs
```
