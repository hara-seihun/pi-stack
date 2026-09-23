# Pi event presentation

Orchestrator owns the shared Pi runner, execution receipts and thread lifecycle. Remote subscribes to the person-owned `ThreadService` and presents authorized peer threads through the same thread directory. The [unified thread design](../../../docs/threads.md) defines that boundary.

`server/server.ts` consumes Pi events for display, not execution decisions:

- `context_update` replaces the provider-neutral context document. The supervisor then rederives that thread's transcript items from the display projection and pushes the ones whose content changed, or a new generation when the earlier items' identities did not survive.
- Message deltas update live text and thinking. Final assistant messages retain their display until canonical context acknowledges them.
- Tool start/update/end events produce bounded previews. Completed native tool output remains in Pi's transcript.
- Retry and compaction events annotate current local activity. They do not create another work receipt.
- Successful `get_state` responses restore live progress after a shared runner reconnect.
- `thread_message_inserted` supplies the owner-confirmed message receipt for voice, naming and meeting-transcript presentation.
- `thread_settled` clears disposable live activity and requests replay of the owner's durable settlement feed.

A child is another persistent thread with its own ID and subscription. There are no child-event envelopes to flatten into the parent, no aggregate parent completion test and no root-scoped child inspection route.

`server/live-projection.ts` owns the disposable visual fields. `server/tool-progress.ts` bounds partial output. `server/context-display.ts` overlays tool results that canonical context has not yet delivered, and `server/transcript-items.ts` derives the delivered items from its output, so the 👍 substitution and restored streamed thinking below are already in place when items are cut. These projections cannot schedule work, infer that a disconnected execution finished or resume a stopped thread.

A completed assistant reply with `stopReason: "stop"` and empty or whitespace-only text displays `👍` in both clients, including historical context and live output awaiting its context acknowledgement. Thinking remains in Agent details. Errors, cancellations, unfinished replies and thinking/tool-only messages do not receive an acknowledgement. `context-display.ts` owns this display substitution; native message text, canonical context, finalization keys and emitted assistant events remain unchanged.

The native transcript remains complete. Remote's events are a bounded voice/display projection, not a recovery conversation. Explicit history reads use the thread owner's non-activating reader. Shared-runner transport, spooling, acknowledgement and replay live under `packages/orchestrator/src/threads/runner-*`.
