# Bash timeout guard

A Pi extension that rejects bash calls without a positive `timeout`, calls past the session's ceiling, and commands that detach work from their session.

The ceiling depends on who is watching. A session with a UI attached (`ctx.hasUI`: the TUI and Pi Remote threads over RPC) has an operator present and may run a bounded foreground command for up to 30 minutes (1800 seconds). Autonomous sessions — embedded fleet runs, print, and json modes — keep the 55-second ceiling that the process sweep and lane pacing assume.

## Configuration

- `PI_BASH_TIMEOUT_MAX_SECONDS` may lower the session's ceiling. Larger values still resolve to the ceiling.
- `PI_BASH_TIMEOUT_CONTEXT` appends a short host-specific explanation to the injected rule.

The extension adds the rule to the system prompt once and checks every bash tool call before execution. A long job must become faster, split into bounded foreground work, or transfer to a durable service that owns its result.

Host timers run `sweep USER` every five seconds against the fleet account only. It kills a command carrying `PI_SESSION_ID` after age 50, which catches commands started by an older session or hidden behind another process. The tool timeout normally acts first at 55 seconds. Interactive sessions run as their human's account, which the sweep never touches, so their longer commands survive.

## Test

```sh
node --test guard.test.mjs
```
