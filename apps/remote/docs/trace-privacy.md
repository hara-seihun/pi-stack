# Traces and confidence

With the host's `oneKenan` flag enabled, Kenan can read information about several people while
answering one person. Thinking and tool results can therefore reveal information he holds in
confidence. Those traces are withheld by the server, not merely hidden in the interface.

For ordinary viewers, traces wait until the turn finishes. If the turn touched only their own
things, the thinking and tool cards appear then. A turn that read memory about another person,
accessed another person's files, or took place in a room shows a quiet privacy note instead.
User messages and Kenan's chosen replies remain visible. System context, arguments, partial output,
tool-result images, and tool errors are also withheld when they could disclose confidential content.

A later turn can reason from private information already retained in the conversation without
reading it again. Accordingly, once another person's information has entered a thread, subsequent
traces stay withheld, including after compaction or a server restart. Earlier clean turns remain
visible. Shell commands, browser sessions, delegated history and other opaque tools cannot be
certified own-only; they receive the same conservative treatment. Start a fresh conversation to
obtain clean traces again.

The registry-marked machine administrator keeps live traces, including in private conversations:
she already has raw access to everything those traces could reveal. This is an explicit
`machineAdministrator: true` property in the root-owned person registry, not an inference from the
shared Kenan execution UID. Do not grant it simply to enable a trace preference.

## Delivery contract

The same policy covers SSE live thinking and activity, paged transcript heads and lazy item bodies,
full-context work cards, Voice catch-up and meeting activity, notification payloads and native
history/export access. Redaction happens before content hashes, previews or image URLs are made.
Old withheld item and image hashes cannot be fetched from the current generation. Notification
records contain public notification fields, never extra execution payloads.

Ordinary person clients cannot fetch raw native history/model inspection or invoke native export
commands through either thread HTTP API. Their normal Remote context/transcript view remains
available in redacted form. Native JSONL/HTML exports and supervisor trace stores cannot be
retrieved through file delivery, including native exports copied out of their original directory.
Intentionally shared ordinary files remain deliverable. This is a trace boundary, not a decision
about the contents of Kenan's chosen replies or a general-purpose information-flow sandbox.

## Implementation and operations

- `server/trace-privacy.ts` owns classification and redaction.
- `server/context-display.ts` applies it after restoring streamed thinking, before image registration.
- `server/server.ts` applies it to client projections, activity and files.
- `packages/orchestrator/src/threads/trace-access.ts` owns the flag and the named administrator predicate.
- `packages/orchestrator/src/threads/caller.ts` refuses raw person-facing history/inspection/export
  access; authenticated internal thread/runtime/service callers still need raw context to work.
- Memory tools attach `details.kenanMemoryRead`, defined in `packages/kenan-memory/src/contract.ts`.
  Missing reports on a completed memory read fail closed. File ownership is derived from person
  registry mountpoints, ciphertext roots, home/data paths and canonicalized tool paths.
- Sticky confidence state lives in the owning supervisor's existing `metadata` table under
  `trace-privacy:<thread id>`, inside its normal data directory. Never remove it to restore trace
  visibility in a conversation that retains private information.

Absent `oneKenan` means the previous behavior, without trace withholding or a new store. The flag
and administrator registry mark are configured only during the approved rollout, not by this slice.

Focused proof:

```
bun test apps/remote/server/trace-privacy.test.ts apps/remote/server/context-display.test.ts apps/remote/server/transcript-items.test.ts
cd packages/orchestrator && ../../node_modules/.bin/vitest run tests/trace-access.test.ts --maxWorkers=1
```

The orchestrator's normal test runner includes `tests/trace-access.test.ts`; it checks the raw HTTP
boundaries with the flag absent, an ordinary person, a forged administrator header, and authenticated
administrator/internal callers.
