# Bounded asynchronous shell execution

[Thread service](threads.md) → owned shell sessions

Managed Linux Remote/fleet sessions expose `bash` plus `bash_session`. The model can
start a command, receive a running handle quickly, and do other useful work without
releasing execution custody. This is not a detached process, a second job service,
or an instruction to background a shell command.

## Tools

```json
{"command":"make build","timeout":55,"yield_time_ms":250}
```

`bash` returns either `running`, `completed` (including integer `exit_code`), or
`failed` with its concrete execution error. It always includes `session_id`,
`started_at`, `deadline_at`, `elapsed_ms`, `remaining_ms`, cumulative `output`,
`truncated`, and `output_available`. A nonzero command exit is a completed process,
not a lost executor; callers must inspect the exit code.

`yield_time_ms` is an observation budget, independently bounded to 0–1000ms.
Omitting it chooses the tool's declared 250ms initial observation window.
`timeout` is required, in seconds, and remains the command's hard timeout under the
existing per-thread ceiling. The deadline triggers descendant cleanup; cleanup
failure stays visible rather than claiming that an unkillable process stopped.
An unconfirmed descendant/scope cleanup fences new local execution and makes Stop
fail explicitly; the existing owner recovery must prove absence before a replacement
runner can release that custody.

```json
{"session_id":"returned ID","yield_time_ms":1000}
{"session_id":"returned ID","stdin":"answer\n","yield_time_ms":250}
{"session_id":"returned ID","eof":true,"yield_time_ms":250}
{"session_id":"returned ID","cancel":true,"yield_time_ms":1000}
```

`bash_session` observes or cancels only a handle in this exact thread/native
session. Stdin is a pipe, not a PTY. `stdin_queued:true` means bytes entered the
bounded writer, not that the program consumed them. The writable queue is capped
at 64KB; backpressure, closed input, foreign/expired handles, conflicting actions,
and invalid yields return explicit error codes. Cancellation cannot include input.
Repeated stdin tool-call identities are never written twice, including after an
uncertain acknowledgement; their persisted submission receipt directs the caller
to inspect rather than repeat. Start identities similarly never launch twice.

Output is a **cumulative tail**, not an unread delta: at most 2000 lines/50KB per
observation, using Pi's UTF-8-aware bounded text accumulator. No automatic spill
file or full-output file is created. At most 16 commands run concurrently and 128
live/result handles retain memory. Evicted starts still have native receipts and
cannot be replayed by their original tool-call identity.

## Execution and recovery ownership

[`PiExecution`](../packages/orchestrator/src/threads/pi-execution.ts) retains each
underlying execution promise after the launching tool yields. The agent can make
subsequent model/tool calls while that promise runs. Overall thread settlement and
capacity release wait for those executions; ordinary end-of-turn is not cleanup.
Stop, hard steer, session replacement and close abort them and await cleanup through
the existing owner. Named cancellation affects only that command, not sibling tools.

[`async-shell.ts`](../packages/orchestrator/src/threads/async-shell.ts) supplies pipe
stdin to the existing Linux subreaper and passes that backend through the existing
[`scopedBashOperations`](../packages/orchestrator/src/threads/pi-bash-resources.ts).
The same own-UID environment, encrypted mount namespace, resource limits,
`BindsTo` scope and descendant cleanup apply. There is no `nohup`, daemon, fresh
service identity or process-tree escape. The `bash` tool name preserves existing
`tool_call` authorization and timeout/detachment hooks; continuation transports only
an already-admitted handle.

Native JSONL custom entries `thread_shell_session_v1` hold owner, request identity,
start/deadline and terminal status. `thread_shell_stdin_v1` records input-submission
identity without input contents. Terminal shell output remains memory-only apart
from ordinary explicitly observed native tool results. On reopen, terminal metadata
is inspectable with `output_available:false`; a previous running receipt becomes
`interrupted` with **outcome unknown**. No process or callback is reconstructed or
replayed. The existing runner/subreaper/cgroup recovery owns proving old execution
absent; an interrupted receipt alone makes no absence claim.

## Scope

This slice covers the managed Linux Remote/fleet factory, including an isolated
application context that already permits Bash. Raw, telephone, room and sandbox
loadouts are unchanged. Terminal/application SDK native-session shells and direct
RPC `bash` remain their existing synchronous tools. Browser and other tools are
not made asynchronous by this change. No new platform or PTY support is inferred.

## Focused checks

```sh
cd packages/orchestrator
npx vitest run tests/async-shell.test.ts tests/pi-execution.test.ts \
  tests/pi-bash-resources.test.ts tests/pi-session-halt.test.ts --maxWorkers=1
npx tsc --noEmit
```

These use synthetic commands, real owned Linux children, bounded stdin, named and
thread cancellation, process-group escapes, output caps/no spills, persisted
unknown outcomes and foreign-session denial. Native-session tests explicitly
inject the repository shell-owner source rather than modifying shared dependencies.

## Upstream reference

The interface is informed by live OpenAI Codex source inspected October 9, 2026:

- [`ExecCommandArgs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec.rs): `yield_time_ms` is separate from execution timeout.
- [`write_stdin`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs): process/session identity, optional input and bounded output observation; continuation reuses original command ownership.
- [`unified_exec`](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/mod.rs): bounded process store/output and session-owned process manager. Its initial yield clamp is 250–30000ms, output cap 1MiB, and process limit 64; PiStack deliberately uses shorter observation and smaller output/session bounds.

The existing PiStack publication owner combines and publishes source. This contract
is not a deployment receipt.
