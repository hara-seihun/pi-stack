# Pi session execution

[Unified threads](../../../docs/threads.md) defines lifecycle ownership. Orchestrator owns threads, admission, pending messages and parent notifications. Pi owns one session's native conversation, tools, extensions, provider interaction and compaction. A child's execution never runs recursively inside its parent's session.

## Hosting and handoff

[`openPiSession`](../src/threads/pi-session.ts) implements `OpenPiSession` from the [thread contract](../src/threads/contracts.ts). It hosts one SDK session in the current process and exposes native RPC commands and events through `command`, `output` and `exit`. Session replacement emits `session_changed` with `sessionFile`, `sessionId` and `cwd`, followed by a conversation projection.

Production controllers use [`createSharedPiSessionOpener({dataDir})`](../src/threads/runner-transport.ts). It returns `{openSession, attachSession, detach}`. The runner hosts many SDK sessions in one Node process. Unix person, execution identity and isolated application cwd determine its grouping. It does not start one process per thread. `flock` owns the runner endpoint for its process lifetime. A control timeout never authorizes another owner.

`attachSession(reference, output, exit)` reconnects only to an existing session using its recorded `{control, socketPath}`. Both socket paths must belong to this controller's data directory. Attachment makes a control `status` request and attaches to the session socket; it never checks cwd, requests admission, launches a runner, or sends `open`. A missing reference or a socket connection rejected with `ENOENT` or `ECONNREFUSED` returns `null`. Timeouts, premature disconnects, malformed replies and other errors throw because they do not establish absence. This lets Stop reach a retained native session after its checkout has been reclaimed, without recreating that checkout or initializing Pi.

Both opening and attachment emit `runner_attached` and use the same command, output replay, close and connection ownership code. `close` requests native disposal before detaching its connection; opener `detach` only disconnects.

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

[`PiExecution`](../src/threads/pi-execution.ts) owns one `halt` operation. Abort, SDK abort aliases, replacement and idle disposal use it. Halt closes admission, signals tools, cancels native agent work, retry, compaction and shell commands, dismisses dialogs, and waits for every tracked call to return. Concurrent abort requests share that operation. Settlement runs before admission reopens and before the abort acknowledgement. Native halt has a fixed 20-second deadline, below the controller's 30-second RPC timeout, so native cancellation failure reaches the controller before its request expires.

Tracking covers prompt preflight, native agent runs, queued inputs, custom-message turns, tools, shell commands, compaction and tree navigation. Each operation inherits its cancellation signal through async-local scope, so a callback from a cancelled run cannot start work after a later run is admitted. Plain prompts cannot overlap preflight or an unsettled turn. Streaming steering still uses Pi's queue.

Settlement is synchronous and runs only when native and tracked work are idle. It never waits on a prompt promise. Prompt cleanup schedules the idle notification outside that promise, after rejection receipts can run. Native `agent_settled` is another notification, not a second settlement owner. During halt, only halt may write the cancelled receipt. Each accepted batch emits one settlement; repeated aborts on idle work emit none.

If a tool or extension ignores cancellation, abort reports failure and leaves execution blocked. Pi's prompt API does not provide an abort signal for arbitrary extension preflight, so halt must wait for that callback to return. Finishing later does not silently authorize another run; a subsequent halt must confirm the stop. A halt invoked from its own tracked callback is rejected immediately rather than waiting on itself. Extension commands that replace their own session need an SDK handoff outside the running callback.

Hard steer uses this same abort boundary before the selected new message runs. It does not cancel descendants or undo external effects.

The focused cancellation checks take seconds and make no provider requests:

```sh
npm test --workspace=pi-orchestrator -- tests/pi-execution.test.ts tests/pi-session-halt.test.ts tests/pi-native.test.ts
```

They cover a real shell inside a native prompt, prompt preflight, extension dialogs, compaction cleanup, concurrent halt, failed cancellation, and single settlement.

## Resources, routing and tools

Normal sessions retain project and user extensions, instructions, skills, prompt templates and cwd-bound coding tools. The [routing extension](../src/extension/routing.ts) resolves canonical model families to credential-bearing accounts before creation and `set_model`. The adapter marks a session created with `--provider` and `--model` as explicit. Its accepted model and thinking level then win over older native model-change entries during startup, while routing remains free to choose another eligible account in the same provider family. A plain Pi resume with no explicit model restores model and thinking from its active history branch. Assigned fleet work retains its admitted account. Provider retries use six attempts with a five-second base delay. `PI_THREAD_SPEED` maps standard to the provider's default service tier and priority to its priority tier for OpenAI Responses providers. The native adapter handles `set_speed` before upstream RPC dispatch, validates `standard` or `priority`, and updates only that session's captured environment. The next provider request uses the new tier without changing other sessions or `process.env`. [`pi-speed.ts`](../src/threads/pi-speed.ts) owns validation and the request hook.

`--raw` selects a bare session through [`pi-raw.ts`](../src/threads/pi-raw.ts). The Thread service passes it for threads whose metadata carries `raw: true`, which is immutable, inherited by children like the other boundaries, and incompatible with isolated context and root repair. The loader skips packages, skills, prompt templates, themes, instruction files and `SYSTEM.md`; the `--extension` arguments controllers add are ignored. Only the routing, usage-logger and thread-speed factories load, plus an extension that sets the system prompt to an empty string on every turn (Pi otherwise builds its harness prompt even without a custom prompt) and the runner-owned context reporter. The session has no built-in, bash or thread tools. The model therefore receives the conversation messages alone. pi-ai substitutes `You are a helpful assistant.` as OpenAI Codex `instructions` because that API rejects a missing field; Anthropic requests carry no system block. Compaction summaries and account-failover notices are the only remaining non-user inputs; output-limit continuation is not loaded.

`get_context` reads Pi's effective `session.systemPrompt`, not the low-level agent state's prompt field. Pi 0.87 carries provider instructions and tool declarations in system messages. Raw sessions report an empty prompt and send an empty leading system message with no tool declarations.

`--orchestrator-context` selects the [isolated loader](../src/host/isolated-context.ts). Its explicit tools and extensions, empty ambient instructions/settings/skills, application HOME and filtered environment remain intact. Thread tools appear there only when explicitly selected. `get_state.context` reports the accepted isolated contract.

The model-facing tools are `thread_spawn`, `thread_send`, `thread_await`, `thread_list`, `thread_read`, and `thread_control`. Thinking, model and speed changes use `thread_control` settings. They use injected `ThreadApi` in-process or `PI_THREAD_API_URL` to reach the owning HTTP API. Spawn is fresh and forces admission; continuing work means send. `thread_send` defaults to `steer` and offers agents only `steer` and `hardSteer`. The service rejects agent queue requests even from older tools. CLI `send` uses `PI_THREAD_ID` as sender and `PI_THREAD_API_URL` as its directory, defaulting to `steer` for agent callers and `queue` without a sender. `thread_await` keeps one tool call open until the first selected direct child settles. Bounded API waits renew inside the tool without another model call. It returns the settlement, remaining child IDs and per-thread `after` cursors. Final message text is preserved; the tool strips thinking, image bytes and signatures without changing the API's native payload. Pass those cursors on the next wait to skip results already seen, including when reusing a resumed worker. Other workers keep running. Stop and hard steer abort the wait; ordinary steer, including completion notifications, waits for the tool boundary. Read never starts its recipient. Its textual previews omit image bytes and signatures, limit pages to eight entries, and chunk large entries through `entryId` and `offset`. UI history remains native content.

## Focused checks

From the repository root:

```sh
npm test --workspace=pi-orchestrator -- tests/pi-native.test.ts tests/pi-execution.test.ts tests/thread-runner.test.ts tests/pi-history-preview.test.ts tests/pi-command-receipts.test.ts tests/isolated-context.test.ts
```

These offline fixtures cover native resource discovery and replacement, accepted-work deduplication, bounded history, actual shell cancellation, cancellation failure, isolated context and shared-process handoff. Publication owns full integration and host deployment.

Fleet runners use one transient systemd service per shared execution boundary, so a daemon restart does not kill their sessions. The runner is the service's main process. Systemd stops remaining tools when that process exits or crashes; an orphaned tool cannot keep its runner's unit occupied and prevent restart. Root repair uses the same runner under UID0 in the system manager, with controller-owned sockets and native files. User and application runners use the user manager. The launcher derives that manager's bus from its effective UID and forwards environment values through D-Bus, not command arguments. Isolated environment exclusions also apply to manager inheritance. Remote retains its existing supervisor handoff boundary. `runner-service.test.ts` kills a real runner with a detached child and proves child cleanup and restart under the same boundary.
