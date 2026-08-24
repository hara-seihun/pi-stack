# Context guard

A Pi extension that bounds long-running conversation context before the provider rejects it.

The guard preserves a protected opening, keeps recent messages byte-for-byte, replaces older tool payloads with transcript pointers, and summarizes or deterministically compacts the middle span. Repeated cuts are monotone: already compacted residue does not expand again.

## Configuration

- `PI_CONTEXT_GUARD=off`: disable the extension.
- `PI_CONTEXT_GUARD_TRIGGER`: lower the built-in trigger for a session; it cannot raise the safety cap.
- `PI_CONTEXT_GUARD_ALERTS`: optional directory for diagnostic alert files. Without it, diagnostics remain in the session log.

Another extension may register additional opening messages as protected through the exported API. The guard still removes tool payloads from that opening so a large fetch cannot become permanently pinned.

The complete session transcript remains the source of truth. Compaction notices include its path when Pi provides one.

## Test

```sh
node --test plan.test.mjs guard.test.mjs
```
