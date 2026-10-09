# Pi event presentation

Orchestrator owns the shared Pi runner, execution receipts and thread lifecycle. Remote subscribes to the person-owned `ThreadService` and presents authorized peer threads through the same thread directory. The [unified thread design](../../../docs/threads.md) defines that boundary.

`server/server.ts` consumes Pi events for display, not execution decisions:

- Message deltas update disposable live text and thinking. Native message boundaries refresh the bounded conversation transcript and clear live buffers.
- Tool start/update/end events produce bounded previews. Completed native tool output remains in Pi's transcript.
- Retry and compaction events annotate current local activity. They do not create another work receipt.
- Successful `get_state` responses restore live progress after a shared runner reconnect.
- `thread_message_inserted` supplies the owner-confirmed message receipt for voice and meeting-transcript presentation.
- `thread_settled` clears disposable live activity and requests replay of the owner's durable settlement feed.

A child is another persistent thread with its own ID and subscription. There are no child-event envelopes to flatten into the parent, no aggregate parent completion test and no root-scoped child inspection route.

[`execution-activity.ts`](../../../packages/orchestrator/src/threads/execution-activity.ts) reduces observed execution events into phase and progress-clock evidence for the runner, thread directory and Remote. Text and tool-call argument streaming are separate phases; finished blocks do not remain current activity. `get_state` restores the same evidence without resetting its clocks. Owner-recorded scheduling, admission, startup, preparation, reconnect, finalization, cancellation and provider waits supply their own phases. Session-local outbound request instrumentation emits `model_request_start` before the model call, including continuations after tools. Missing phase evidence is an instrumentation defect to repair, not a supported execution state. The [status presentation contract](../web/README.md#execution-status-is-evidence-not-reassurance) maps this evidence to visible words and age without inferring failure from silence.

`server/live-projection.ts` owns disposable visual fields. `server/tool-progress.ts` bounds partial output. `server/thread-transcript-source.ts` overlays live tool previews on native records, and `server/context-display.ts` projects each requested message before `server/transcript-items.ts` derives its delivered items. The runtime preserves streamed thinking in the native assistant record before persistence. These projections cannot schedule work, infer that a disconnected execution finished or resume a stopped thread.

A completed assistant reply with `stopReason: "stop"` and empty or whitespace-only text displays `👍` in both clients, including historical native messages. Thinking remains in Agent details. Errors, cancellations, unfinished replies and thinking/tool-only messages do not receive an acknowledgement. `context-display.ts` owns this display substitution; native message text, finalization keys and emitted assistant events remain unchanged.

The native transcript remains complete. Remote's events are a bounded voice/display projection, not a recovery conversation. Explicit history reads use the thread owner's non-activating reader. Shared-runner transport, spooling, acknowledgement and replay live under `packages/orchestrator/src/threads/runner-*`.
