# Thread service

The [accepted thread design](../../../docs/threads.md) defines behavior. [`ThreadService`](../src/threads/service.ts) is the durable owner inside each Unix-person or execution boundary. The shared [contracts](../src/threads/contracts.ts) serve Remote, fleet, CLI and model tools. A directory routes authorized peer operations; it does not schedule work.

## Construction and lifetime

Create a service with `databasePath`, `sessionsDir` and the shared runner's `openSession`. Optional hooks supply boundary-specific environment, quota admission and message preparation. Set its authorized directory with `setDirectory()` before starting it. The service supplies `PI_THREAD_DATABASE` from its own `databasePath` to every session, so `read-thread` uses the thread's owner rather than the account's Remote store.

`admit(thread, settings, recovering, executionId)` returns a domain result containing optional effective settings/environment and a `release()` function. New work acquires a lease; recovery retains admitted execution ownership. Settlement releases that lease. Session identity and queue ownership remain with the service, not the quota hook.

`prepareMessage(thread, message)` returns a result containing text and optional images. The service persists that prepared payload before native dispatch and reuses it after interruption. Hooks that change external state must use the stable message ID to replay their own receipt. This matters for meeting transcript cursors: a crash after preparation but before its queue commit must not consume a different transcript on retry.

`start()` enables dispatch. Idle native runtimes close after durable settlement, so persistent threads do not occupy resident runner slots. Reading or inspecting unloaded history does not open a runtime.

For controller handoff:

1. Call `service.suspend()` to stop dispatch and fence callbacks.
2. Detach the shared runner connections without closing their sessions.
3. Await `service.detach()` to release the controller database connection.
4. Start the successor service against the same database and native files.

Accepted and inserted work remains durable. `close()` instead closes idle native resources and refuses active execution. Publication must drain executions for the initial source-owner cutover.

## Native execution contract

Input commands carry a stable `workId`. Pi records `thread_input` and `thread_settled` receipts in its native session. `get_state` exposes accepted and completed work IDs. Reopening an accepted, incomplete input uses native continuation; it does not replay the user's message. A completed receipt settles the database without another model request.

Stop and hard steer await native cancellation and check that streaming, compaction, queued native input and local tools have stopped. Failure holds queued work, records the cancellation error and leaves the thread running until cancellation is confirmed. Only then is it stopped. A late callback from a replaced or suspended controller cannot start replacement execution.

Each execution captures its effective settings. Defaults come from [`resolveThreadSettings`](../src/threads/settings.ts). Isolated context and execution identity are immutable thread metadata. Isolated context reaches the runner through `--orchestrator-context`; root repair cannot combine it with privileged execution. Once native file custody exists, `nativeHistoryRequired` prevents reopening a missing transcript as a fresh session.

## Observation and controls

`get()`, `snapshot()` and `pending()` are synchronous projections. `inspect()` includes pending receipts and active context/live projections. After unloading, its context is explicitly marked `native-history`; it is a display of stored conversation, not a reconstruction of the provider's system prompt. `read()` uses the shared native-history reader and omits assistant thinking/signatures for model-facing reads.

`subscribe()` emits `{threadId,type:"changed"}` or `{threadId,event}`. Native events remain available to presentation consumers. Service receipts are:

- `thread_message_inserted`, including the message, work ID, execution ID and insertion timestamp.
- `thread_settled`, including settlement sequence, execution/work IDs, outcome, time and final assistant message or null.

Listeners are notifications, not durable delivery. `settlements(after, limit)` reads ordered settlement records from the execution table and returns `{items,cursor}`. Sequence numbers are assigned during settlement, not execution creation. Consumers retain their cursor and can deduplicate on execution ID.

`command()` owns native activation and serialization for inspection, compaction and conversation editing. Durable input and cancellation use `send()` and `control()` instead. Native conversation changes update the owned session-file reference.

Archiving through `control(update)` first stops the thread and holds its queue. Synchronous `update()` refuses active archiving. Archived threads reject sending, resuming and native commands until explicitly restored. Restoring creates no work and leaves held messages held.

## State import

`importState(threads, messages)` imports arrays of the exported `ImportThread` and `ImportMessage` types in one full-synchronous SQLite transaction. Nested operations use savepoints. An error rolls back the batch. Import runs before `start()`; source cleanup belongs to the cutover owner after successful custody transfer.

Import threads before their messages. Preserve native file references, IDs, parentage, timestamps, effective settings, isolated context and stopped state. Set `metadata.nativeHistoryRequired` for established conversations even when their file is missing, so corruption cannot masquerade as a blank thread.

Completed or cancelled messages do not dispatch. Imported request IDs retain replay receipts. Pending automatic results use the same message queue with `source: "notification"`; they do not resume stopped recipients. Active imported messages must share their recorded execution ID, but the first source cutover rejects active execution and waits for its original owner to settle.
