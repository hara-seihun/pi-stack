# Pi session execution

[Unified threads](../../../docs/threads.md) defines lifecycle ownership. Orchestrator owns threads, admission, pending messages and parent notifications. Pi owns one session's native conversation, tools, extensions, provider interaction and compaction. A child's execution never runs recursively inside its parent's session.

## Hosting and handoff

[`openPiSession`](../src/threads/pi-session.ts) implements `OpenPiSession` from the [thread contract](../src/threads/contracts.ts). It hosts one SDK session in the current process and exposes native RPC commands and events through `command`, `output` and `exit`. Session replacement emits `session_changed` with `sessionFile`, `sessionId` and `cwd`, followed by a conversation projection.

Production controllers use [`createSharedPiSessionOpener({dataDir})`](../src/threads/runner-transport.ts). It returns `{openSession, detach}`. The runner hosts many SDK sessions in one Node process. Unix person, execution identity and isolated application cwd determine its grouping. It does not start one process per thread. `flock` owns the runner endpoint for its process lifetime. A control timeout never authorizes another owner.

The controller calls `detach` during handoff. This disconnects its channels without stopping accepted work. Reopening the same thread attaches to the same session and replays unacknowledged output. Each channel's output spool is transient delivery state, not conversation history. Native JSONL and the thread database remain authoritative. A dead runner loses its in-memory tools and queues; the controller recovers using native work receipts.

`close` unloads an idle session and waits for SDK disposal. It refuses active or unconfirmed cancellation. The thread controller must stop work explicitly before closing and unload settled sessions so idle residency does not exhaust the runner's capacity. The runner exits after five seconds with no sessions. Shutdown refuses to discard active sessions.

Runner files live under the owning controller's data directory in `thread-runners/` and `thread-sockets/`. The compiled entry is `dist/threads/runner-host.js`. Startup inherits the owning Unix account. An isolated application's runner starts with its scrubbed HOME and credential environment before loading extensions. Root-repair execution retains its own account boundary and full normal context.

## Native receipts

Inputs carry a stable `workId`. Before invoking Pi, the adapter writes and syncs a `thread_input` custom entry in the native session. This takes custody before extension preflight can produce effects. Explicit preflight rejection adds `thread_rejected`; successful acknowledgement needs no second input copy. Queued steering uses the same receipt. There is no portable conversation or separate child journal.

On settlement, a `thread_settled` native entry records the accepted work IDs, outcome and final assistant entry ID, or an explicit absence. `agent_settled` reports only this session's work, not descendants. `get_state` includes native busy flags, `acceptedWorkIds`, `completedWorkIds` and `lastAssistantMessage` from the current branch. This lets recovery distinguish an earlier answer from completion of the current work.

An already accepted input acknowledges without another user message. With `resume: true`, incomplete idle work receives a structured `thread_recovery` custom message containing its accepted receipt. Recovery asks Pi to continue from the existing conversation and current effects. Completed work never starts another model turn. Native fork and switch operations retain branch-scoped receipt semantics.

`PI_THREAD_REQUIRE_SESSION=1` makes a missing native file an error. The thread controller sets it when custody requires existing history. New sessions receive a durable native header before execution. Native opens and switches validate the header. Historical provider records and transfer provenance belong to the [thread import owner](../src/threads/import.ts); changing an engine label or replaying user requests is not a conversion.

## Native command receipts

Fork, clone, new-session, switch, compaction, shell commands and model/thinking cycles require stable command IDs. A synced `thread_command` native entry precedes execution. A changed payload under the same ID fails. `thread_command_result` records the exact response and resulting session file before the response reaches the controller.

Replacement writes a pending command receipt into its target and a target reference into its source before emitting `session_changed`. Completion writes its result to both native files. Retrying from the source can therefore adopt the recorded target and replay the response without another fork. A pending receipt without a result is an explicit unconfirmed outcome. It never authorizes a retry, a new request ID or a guess about whether compaction completed.

These are native execution receipts; the thread service still owns command admission. External tool effects are not transactions. A process can stop after an external effect but before its result, so recovery inspects current state rather than promising exactly-once external effects.

## Cancellation

[`PiExecution`](../src/threads/pi-execution.ts) supplies local tool signals, tracks tools and prompt preflight, and fences callbacks from cancelled generations. Abort cancels the agent, compaction, shell commands and dialogs, then waits for local execution to stop. The acknowledgement follows confirmed cleanup. The timeout is `PI_THREAD_CANCEL_TIMEOUT_MS`, default 30 seconds.

If a tool ignores cancellation, abort reports failure and leaves execution blocked. Finishing later does not silently authorize another generation; a subsequent cancellation must confirm the stop. Hard steer uses this same abort boundary before the selected new message runs. It does not cancel descendants or undo external effects.

## Resources, routing and tools

Normal sessions retain project and user extensions, instructions, skills, prompt templates and cwd-bound coding tools. The [routing extension](../src/extension/routing.ts) resolves canonical model families to credential-bearing accounts before creation and `set_model`. Assigned fleet work retains its admitted account. Provider retries use six attempts with a five-second base delay. `PI_THREAD_SPEED` maps standard to the provider's default service tier and priority to its priority tier for OpenAI Responses providers.

`--orchestrator-context` selects the [isolated loader](../src/host/isolated-context.ts). Its explicit tools and extensions, empty ambient instructions/settings/skills, application HOME and filtered environment remain intact. Thread tools appear there only when explicitly selected. `get_state.context` reports the accepted isolated contract.

The model-facing tools are `thread_spawn`, `thread_send`, `thread_list`, `thread_read`, and `thread_control`. Thinking, model and speed changes use `thread_control` settings. They use injected `ThreadApi` in-process or `PI_THREAD_API_URL` to reach the owning HTTP API. Spawn is fresh and forces admission; continuing work means send. No tool waits for a child to finish. Read never starts its recipient. Its textual previews omit image bytes and signatures, limit pages to eight entries, and chunk large entries through `entryId` and `offset`. UI history remains native content.

## Focused checks

From the repository root:

```sh
npm test --workspace=pi-orchestrator -- tests/pi-native.test.ts tests/pi-execution.test.ts tests/thread-runner.test.ts tests/pi-history-preview.test.ts tests/pi-command-receipts.test.ts tests/isolated-context.test.ts
```

These offline fixtures cover native resource discovery and replacement, accepted-work deduplication, bounded history, actual shell cancellation, cancellation failure, isolated context and shared-process handoff. Publication owns full integration and host deployment.

Fleet runners use one systemd scope per shared execution boundary, so a daemon restart does not kill their sessions. Root repair uses the same runner under UID0 in a system scope, with controller-owned sockets and native files. User and application runners use user scopes. Remote retains its existing supervisor handoff boundary.
