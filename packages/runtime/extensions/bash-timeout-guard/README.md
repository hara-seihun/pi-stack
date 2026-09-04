# Bash timeout guard

A Pi extension that rejects bash calls without a positive `timeout`, calls past the session's ceiling, and commands that detach work from their session.

The default ceiling depends on who is watching. A session with a UI attached (`ctx.hasUI`) gets 30 minutes (1800 seconds). Autonomous sessions get 55 seconds. Hosts can replace either default without changing the extension.

## Configuration

- `PI_BASH_TIMEOUT_MAX_SECONDS` sets the ceiling in seconds and may raise or lower the default.
- `PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS` carries a Pi Remote thread's saved ceiling and takes precedence over `PI_BASH_TIMEOUT_MAX_SECONDS`, even when its runtime does not report `ctx.hasUI`. Pi Remote sets it when it starts the thread runtime.
- `PI_BASH_TIMEOUT_CONTEXT` appends a short host-specific explanation to the injected rule.

The extension adds the rule to the system prompt once and checks every bash tool call before execution. A long job must become faster, split into bounded foreground work, or transfer to a durable service that owns its result.

`sweep --dry-run` prints the same decisions without signalling anything, which is how the test exercises it against the live process table; the suite must never kill another agent's work.

Host timers run `sweep` every five seconds. It kills a command carrying `PI_SESSION_ID` after age 50 when the process lives in a `pi-orchestrator-run-*` unit, which catches commands started by an older fleet session or hidden behind another process. The tool timeout normally acts first at 55 seconds. Interactive sessions live in their person's Pi Remote unit, not a fleet run unit, so their longer commands survive even when the same account runs the fleet.

## Test

```sh
node --test guard.test.mjs
```
