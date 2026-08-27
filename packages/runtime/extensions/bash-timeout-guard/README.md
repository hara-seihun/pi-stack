# Bash timeout guard

A Pi extension that rejects bash calls without a positive `timeout`, calls longer than 55 seconds, and commands that detach work from their session.

## Configuration

- `PI_BASH_TIMEOUT_MAX_SECONDS` may lower the 55-second ceiling. Larger values still resolve to 55 seconds.
- `PI_BASH_TIMEOUT_CONTEXT` appends a short host-specific explanation to the injected rule.

The extension adds the rule to the system prompt once and checks every bash tool call before execution. A long job must become faster, split into bounded foreground work, or transfer to a durable service that owns its result.

Host timers run `sweep USER` every five seconds. It kills a command carrying `PI_SESSION_ID` after age 50, which catches commands started by an older session or hidden behind another process. The tool timeout normally acts first at 55 seconds.

## Test

```sh
node --test guard.test.mjs
```
