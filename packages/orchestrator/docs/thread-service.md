# Thread service

The [accepted thread design](../../../docs/threads.md) defines behavior. [`ThreadService`](../src/threads/service.ts) is the durable owner inside each Unix-person or execution boundary. The shared [contracts](../src/threads/contracts.ts) serve Remote, fleet, CLI and model tools. A directory routes authorized peer operations; it does not schedule work.

`send()` accepts an optional `delivery`. The shared `resolveDelivery()` defaults messages with `senderId` to `steer` and senderless human messages to `queue`. Agents may send only `steer` or `hardSteer`; the service rejects `senderId` with `delivery: "queue"`. Humans may use all three modes. HTTP and directory routing preserve the sender and selected mode; the destination service resolves omitted delivery before persistence.

## HTTP acceptance across activation

`createThreadClient()` retains one serialized request and its identity while reconnecting. Sends and spawns require their existing stable `requestId` before transport replay is allowed. Read-only operations can reconnect too. Connection loss, HTTP 502/503/504 and an explicitly retryable suspended-controller response use delays of 100, 200, 400, 800 and then 1,000 milliseconds, within one 60-second deadline. Ordinary owner decisions, including archived recipients and identity conflicts, are terminal. Commands and controls are never automatically replayed.

Every failure returned by the client carries `retryable: false` because the client has finished retrying or received a terminal decision. Send and spawn failures also carry the submitted `requestId`. The CLI preserves these fields, and a failed spawn batch reports the failed request's identity alongside the threads already accepted. Control failures have no generated request identity.

The native tool passes its cancellation signal into that client. HTTP directory hops inherit the original deadline through `x-pi-thread-deadline` and the incoming request's cancellation signal, rather than starting another minute of retries. The daemon's Node HTTP adapter forwards both. Cancellation or deadline expiry ends reconnect and returns an error carrying the original request ID. An interrupted response does not prove rejection; its error says acceptance is unconfirmed. The sender's native tool call retains the input and identity. It must not become a new instruction with a new ID.

The destination commits the input and request receipt together. A retry after acceptance returns that receipt without waking the recipient again, even if Stop intervened. Admission rechecks receipts after asynchronous parent discovery or cancellation, so overlapping retries cannot create a second child or input. Peer routing and Unix-person boundaries are unchanged.

The September 15 incident exposed the missing reconnect. A send failed at 21:21:47 UTC while the fleet daemon restarted, then began listening at 21:21:49. The caller received `unavailable` after one fetch and had to issue another instruction. `tests/thread-http.test.ts` now exercises an actual refused loopback connection, loss of the response after the SQLite commit, owner replacement and an intervening Stop. It also covers deadline propagation, native tool cancellation, identity conflicts and non-replayable operations. No model or live thread is involved.

From `packages/orchestrator`, run `npx vitest run tests/thread-http.test.ts`. To exercise an installed release with the same proof, set `PI_THREAD_TEST_RELEASE=/srv/pi/pi-orchestrator/dist`. Active native sessions retain their loaded tool generation until normal session replacement; newly activated directory owners use the new peer transport immediately.

## Construction and lifetime

Create a service with `databasePath`, `sessionsDir` and the shared runner's `openSession` and `attachSession`. Optional hooks supply boundary-specific environment, quota admission and message preparation. Set its authorized directory with `setDirectory()` before starting it. The service supplies `PI_THREAD_DATABASE` from its own `databasePath` to every session, so `read-thread` uses the thread's owner rather than the account's Remote store.

`admit(thread, settings, recovering, executionId)` returns a domain result containing optional effective settings/environment and a `release()` function. New work acquires a lease; recovery retains admitted execution ownership. Settlement releases that lease. Session identity and queue ownership remain with the service, not the quota hook.

`prepareMessage(thread, message)` returns a result containing text and optional images. The service persists that prepared payload before native dispatch and reuses it after interruption. Hooks that change external state must use the stable message ID to replay their own receipt. This matters for meeting transcript cursors: a crash after preparation but before its queue commit must not consume a different transcript on retry.

`start()` enables dispatch. Idle native runtimes close after durable settlement, so persistent threads do not occupy resident runner slots. Reading or inspecting unloaded history does not open a runtime.

For controller handoff:

1. Call `service.suspend()` to stop dispatch and fence callbacks.
2. Detach the shared runner connections without closing their sessions.
3. Await `service.detach()` to release the controller database connection.
4. Start the successor service against the same database and native files.

Dispatched work and its insertion timestamp remain durable. `close()` instead closes idle native resources and refuses active execution. Publication must drain executions for the initial source-owner cutover.

## Native execution contract

Input commands carry a stable `workId`. Pi records `thread_input` and `thread_settled` receipts in its native session. `get_state` exposes accepted and completed work IDs. Reopening an accepted, incomplete input uses native continuation; it does not replay the user's message. A completed receipt settles the database without another model request.

Stop and hard steer use the existing runtime or attach to its recorded runner without opening a session. Cancellation does not need the workspace, credentials or model admission. Confirmed runner absence permits cancellation of the retained execution claim; a transport failure does not. Settlement also releases a retained fleet lease without readmission. Stop and hard steer await native cancellation of streaming, compaction, queued native input and local tools. Failure sets `held`, records the cancellation error and leaves the thread running until cancellation is confirmed. A confirmed stop leaves the thread idle and held. A late callback from a replaced or suspended controller cannot start replacement execution.

An execution is active while `thread_execution.ended_at` is null. A partial unique index on that condition permits only one active execution per thread; there is no execution state column. Each execution captures its effective settings. Defaults come from [`resolveThreadSettings`](../src/threads/settings.ts). It validates built-in provider IDs, including numbered pool aliases, against the same native model definitions used by routing and cold settings. Sol resolves to `gpt-6-sol` and Luna to `gpt-6-luna`. Unknown installed-provider models are rejected before a spawn or settings write. Explicit supported version selections remain unchanged. Explicit private provider names remain subject to runtime model registration.

A model-configuration failure during native startup settles that assignment as failed, records the error in its execution and work receipts, and sends the parent a failure notification. The thread holds its remaining input across controller restarts instead of reopening the same missing model every five seconds. Account admission and transport failures remain retryable.

Setting an explicit model also repairs queued snapshots whose model now fails validation. It changes only their model, preserves thinking, speed and queue state, and records `modelSettingsRepairs` provenance in thread metadata with the work ID, previous model, selected model and timestamp. Valid accepted snapshots and active executions retain their settings. Correcting a held thread does not resume it.

Isolated context, execution identity and `raw` are immutable thread metadata. Isolated context reaches the runner through `--orchestrator-context`; root repair cannot combine it with privileged execution. `raw: true` reaches the runner as `--raw` and excludes both; see [Pi sessions](pi-sessions.md#resources-routing-and-tools). Once native file custody exists, `nativeHistoryRequired` prevents reopening a missing transcript as a fresh session.

## Observation and controls

`get()`, `snapshot()` and `pending()` are synchronous projections. Threads expose `state: "idle" | "running"` and a separate `held` boolean. Messages expose one lifecycle: `queued`, `dispatched`, then `done`. `insertedAt` distinguishes a message Pi has accepted without adding another lifecycle stage. `inspect()` includes pending receipts and active context/live projections. After unloading, its context is explicitly marked `native-history`; it is a display of stored conversation, not a reconstruction of the provider's system prompt. `read()` uses the shared native-history reader and omits assistant thinking/signatures for model-facing reads.

`subscribe()` emits `{threadId,type:"changed"}` or `{threadId,event}`. Native events remain available to presentation consumers. Service receipts are:

- `thread_message_inserted`, including the message, work ID, execution ID and insertion timestamp.
- `thread_settled`, including settlement sequence, execution/work IDs, outcome, time, final assistant message or null, and `error` for failed work with a concrete cause.

Listeners are notifications, not durable delivery. `settlements(after, limit)` reads ordered settlement records from the execution table and returns `{items,cursor}`. Sequence numbers are assigned during settlement, not execution creation. Consumers retain their cursor and can deduplicate on execution ID. Failed assistant `errorMessage` values also populate execution/work receipt errors, settlement API errors and parent notifications. Cancelled work remains cancellation without a failure error; reporting never releases held input.

`await({parentId, threadIds, after?, timeoutMs?}, signal?)` waits for the first settlement from 1..100 distinct direct children. Each `after` value is a settlement sequence in that child's owner, defaults to zero and must be a nonnegative safe integer. Already-persisted results are returned before waiting for events. `timeoutMs` defaults to 25000 and accepts 0..25000; zero performs an immediate read. The model tool uses 25000 to respond before Remote's 30-second HTTP idle timeout. Timeout returns `{settlement:null, remainingThreadIds, after}`. A result advances only its child's cursor and excludes that child from `remainingThreadIds`. Extra cursor keys are preserved for later subset waits. Observing a result does not consume or acknowledge it.

The directory validates every requested parent-child relationship before starting owner waits. It races authorized owner groups, cancels losing waits and returns the first settlement without advancing other cursors. An owner's timeout is not a settlement; all groups must time out before the directory returns null. Abort cancels every pending group. HTTP `POST /v1/threads/await` forwards cancellation and the caller's deadline through directory hops. The client combines its configured signal, the per-await signal and the inherited request deadline. Await settlements retain the same error details as `settlements()` and `latestSettlement()`. Held children with no unseen settlement remain waiting until resumed or the caller cancels. Holding a child does not fabricate a result.

`command()` owns native activation and serialization for inspection, compaction and conversation editing. Durable input and cancellation use `send()` and `control()` instead. Native conversation changes update the owned session-file reference.

Archiving through `control(update)` first stops the thread and holds its queue. Synchronous `update()` refuses active archiving. Archived threads reject sending, resuming and native commands until explicitly restored. Restoring creates no work and leaves held messages held.

## State import

`importState(threads, messages)` imports arrays of the exported `ImportThread` and `ImportMessage` types in one full-synchronous SQLite transaction. Nested operations use savepoints. An error rolls back the batch. Import runs before `start()`; source cleanup belongs to the cutover owner after successful custody transfer.

Import threads before their messages. Preserve native file references, IDs, parentage, timestamps, effective settings, isolated context and the held flag. Set `metadata.nativeHistoryRequired` for established conversations even when their file is missing, so corruption cannot masquerade as a blank thread.

Messages imported as `done` do not dispatch; their `outcome` retains complete, failed or cancelled results. Imported request IDs retain replay receipts. Pending automatic results use the same message queue with `source: "notification"`; they do not resume held recipients. Active imported messages must share their recorded execution ID, but the first source cutover rejects active execution and waits for its original owner to settle.
