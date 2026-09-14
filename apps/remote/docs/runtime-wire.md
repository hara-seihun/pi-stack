# Pi event presentation

Orchestrator owns the shared Pi runner, execution receipts and thread lifecycle. Remote subscribes to the person-owned `ThreadService` and presents authorized peer threads through the same thread directory. The [unified thread design](../../../docs/threads.md) defines that boundary.

`server/server.ts` consumes Pi events for display, not execution decisions:

- `context_update` replaces the provider-neutral context document.
- Message deltas update live text and thinking. Final assistant messages retain their display until canonical context acknowledges them.
- Tool start/update/end events produce bounded previews. Completed native tool output remains in Pi's transcript.
- Retry and compaction events annotate current local activity. They do not create another work receipt.
- Successful `get_state` responses restore live progress after a shared runner reconnect.
- `thread_message_inserted` supplies the owner-confirmed message receipt for voice, naming and meeting-transcript presentation.
- `thread_settled` clears disposable live activity and requests replay of the owner's durable settlement feed.

A child is another persistent thread with its own ID and subscription. There are no child-event envelopes to flatten into the parent, no aggregate parent completion test and no root-scoped child inspection route.

`server/live-projection.ts` owns the disposable visual fields. `server/tool-progress.ts` bounds partial output. `server/context-display.ts` overlays tool results that canonical context has not yet delivered. These projections cannot schedule work, infer that a disconnected execution finished or resume a stopped thread.

The native transcript remains complete. Remote's events are a bounded voice/display projection, not a recovery conversation. Explicit history reads use the thread owner's non-activating reader. Shared-runner transport, spooling, acknowledgement and replay live under `packages/orchestrator/src/threads/runner-*`.
