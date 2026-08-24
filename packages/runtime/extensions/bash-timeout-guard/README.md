# Bash timeout guard

A Pi extension that rejects bash calls without a positive, bounded `timeout`.

## Configuration

- `PI_BASH_TIMEOUT_MAX_SECONDS`: upper bound in seconds; defaults to `1800`.
- `PI_BASH_FOREGROUND_ONLY=1`: also reject commands that detach work from the session.
- `PI_BASH_TIMEOUT_CONTEXT`: short host-specific explanation appended to the injected rule.

The extension adds the effective rule to the system prompt once and checks every bash tool call before execution. Installations choose policy through the environment rather than patching this package.

## Test

```sh
node --test guard.test.mjs
```
