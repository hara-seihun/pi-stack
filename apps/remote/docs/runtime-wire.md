# Runtime wire projection

[`server/shared-session.mjs`](../server/shared-session.mjs) attaches [`remoteRuntimeOutput`](../server/runtime-wire.mjs) to `openCoreSession`. This is Remote's consumer projection, applied before the shared runtime serializes or spools output. It is not a change to the core event contract.

`openCoreSession` records events in `CoreJournal` before calling Remote. Native session storage, portable root and child conversations, operation records and agent metadata retain their existing contents. The projection creates new envelopes without changing native objects, including objects that the Pi adapter still needs after its output callback returns.

## Consumer audit

`server.ts` is the only Remote consumer of runtime output. Its `handleRpcEvent` owns the following uses:

| Input | Remote needs | Projection |
| --- | --- | --- |
| `core_child_event` | No live or transcript consumer | Drop the whole envelope without inspecting its payload. The supervisor does not duplicate core journals in SQLite. |
| `core_agent` | Registry, child controls, activity and settlement checks | Keep the complete `agent` record. Native path, work ID and other outer fields stay in the core journal. |
| `message_update` | Live text/thinking and thinking-block boundaries | Keep text/thinking deltas, `thinking_start`, and `thinking_end.content`. Drop both the outer message and native partial snapshots, tool-call arguments and signatures. |
| Assistant `message_end` | Final text/thinking, inline-image declarations, model failure and context finalization | Keep role, timestamp, complete content, stop reason, raw refusal reason and error message. |
| Other `message_end` | Activity and phase-version fence | Keep role, not the user/tool/custom payload. |
| `tool_execution_start` | Active tool identity and SQLite argument preview | Keep tool ID/name. Arguments over 12,000 JSON characters become a marked preview that fits within that same limit after escaping. |
| `tool_execution_update` | Live tool output preview | Keep tool ID/name and bounded `partialResult` text and image markers. Pi updates replace the partial-result snapshot. |
| `tool_execution_end` | Active tool removal and SQLite output preview | Keep tool ID/name/error. Render text and image markers, discard native details and image bytes, and retain at most 20,001 text characters. The extra character lets the supervisor apply its existing 20,000-character truncation notice. |
| `queue_update` | Counts for dispatch acknowledgement and queue state | Replace queued message bodies with null entries, preserving both array lengths. |
| Retry, compaction and core errors | Lifecycle flags, outcomes and failure text | Keep consumed status/error fields. A compaction result becomes a success boolean rather than another copy of its summary. |
| `extension_ui_request` | Cancel interactive mobile dialogs | Keep method and request ID. |
| Other root events | Invalidate in-flight state observations | Keep type only, including agent/turn boundaries, native conversation replacements and unknown event types. |
| Successful `get_state` response | Activation, settings, dispatch, abort and recovery reconciliation | Omit unused `context` and `lastAssistantMessage` snapshots. Keep aggregate activity, child records, native identity, session path/name, model/effort, message counts, errors, unresolved command IDs and all other state fields. |
| Other command responses | Pending RPC callers | Keep complete responses and errors. |
| Root `context_update` | Canonical context capture and finalization | Keep complete event. |

The root delta stream grows with new text rather than the accumulated assistant message. Child token and image events produce no Remote wire records. Root events whose bodies have no consumer still advance the supervisor's phase-version fence, so stripping their payload cannot let an earlier idle observation overwrite later activity.

## Payloads that remain complete

This is a bounded preview projection, not a fixed byte limit on every frame. Root context and assistant completion content can still be large. The context view needs complete canonical messages and images. `messageFinalizationKey` hashes the assistant's role, timestamp and entire content, including provider signatures. Stripping those fields from `message_end` would break the acknowledgement that clears live output when context catches up.

Explicit `get_portable_conversation`, `get_entries`, `get_messages`, `get_core_context` and `core_agent_read` responses also remain complete. History export reads the portable conversation, message editing needs native entries, and child inspection reads its own transcript. Those are requested document transfers, not repeated unsolicited copies. The transport must continue to support large records with backpressure and reconnect recovery.

Pi child settlement, automatic result delivery and work receipts belong to the core tree. Ordinary Pi usage accounting runs in its native extension. Fleet Pi workers account from root and child message events, so they must continue receiving the complete core wire. This projection belongs only in Remote's shared-session entrypoint, never inside `CoreJournal`, the Pi adapter, or the shared `openCoreSession` factory.

## Live progress

Remote tracks reasoning activity separately from reasoning text. `thinking_start` makes the thread THINKING even when the provider supplies no summary. `thinking_end`, response text and tool starts close that activity. The transcript shows a running status independently of Markdown. Empty completed thinking blocks are omitted from the shared display document and browser cards; actual textual summaries remain visible. Native and portable history are not rewritten.

`get_state.live` restores current text, thinking activity and active tool IDs/names/arguments after reconnect. The supervisor applies it only when no newer runtime event has crossed the state-query fence. Busy native work without a known active item displays WORKING. It does not turn completed reasoning history into current thinking.

The supervisor retains tool previews until canonical context supplies the tool result. It overlays missing calls and results in the display document, never the editable model context. Browser reloads receive the same display snapshot. Supervisor handoff retains the preview and activity; active calls without a retained preview recover their arguments from the supervisor's `tool_start` ledger. A state snapshot without a start time is labelled Observed. Active tool cards remain visible outside collapsed detail groups, including while another item is thinking.

Live output is a bounded preview, retaining up to 20,000 characters. An empty state snapshot cannot reconstruct missing output. The retained native transcript and completed result remain the sources for full output. An already-running worker using the preceding wire projection must finish before new tool-update forwarding takes effect; Remote does not interrupt or resend its turn.

[`tool-progress.json`](../server/fixtures/tool-progress.json) exercises empty reasoning, tool start, partial output and completion through the supervisor. The focused tool-progress test covers replacement snapshots and canonical-context reconciliation.

## Regression checks

From the repository root:

```sh
bun test apps/remote/server/runtime-wire.test.ts apps/remote/server/tool-progress.test.ts apps/remote/server/context-display.test.ts apps/remote/web/live-activity.test.ts apps/remote/web/context-progress.test.ts apps/remote/web/transcript-groups.test.ts
bun test apps/remote/server/server.integration.test.ts -t 'native.*progress|native active-item|thinking|publishes live model text'
```

The tests cover a child burst that never reaches the output callback, linear root deltas despite multi-megabyte partial snapshots, bounded tool previews, unchanged finalization keys, lifecycle fields, complete inspection responses, and full root/child journal retention before projection. They make no provider calls.

The motivating September 13 incident was Shahara Blender Modeling, thread `21bf142a`. Its tree had finished idle at 16:18 while its supervisor had disconnected at 16:02 during child image events. The runtime spool reached 1.37 GB. Those child payloads already belonged to native and core journals; Remote had been persisting another copy with no consumer.
