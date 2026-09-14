# Codex app-server core

## Provider output limits

A native failure ending in `Incomplete response returned, reason: max_output_tokens` is a provider length stop. The core retains it as `stopReason: length` and continues the same native thread, model and thinking level. This applies to roots and children in both Remote and fleet sessions. Ordinary failures, operator interrupts and completed turns remain terminal. Continuation dispatch has a durable per-turn receipt; uncertain dispatches require native-history reconciliation and are never blindly replayed. The account and tree stay active throughout the continuation.

A fleet run already stopped by this condition can be resumed with `pi-orchestrator continue RUN_ID`. It retains its native session, assignment and usage history, records the original failure under `run-output-limit:RUN_ID:TIMESTAMP`, and starts on the current immutable release. An operator abort prevents continuation. Workers still using a preceding release are recovered through this same transition if they subsequently report this length-stop failure. Their completed tool calls are not rerun.

`src/cores/codex.ts` adapts the pinned Codex 0.154.0 app-server to PiStack's runtime wire. The default launcher resolves the executable from Orchestrator's immutable dependency closure, not the caller's PATH. Codex owns instructions, native tools, skills, compaction, and child agents. PiStack chooses the starting model and effort, binds an account, reserves capacity during native-tree activity, and controls dispatch. No Pi system prompt or Pi tools are installed into Codex. OpenAI models use native ChatGPT authentication. Anthropic models use Codex's custom Responses provider with the session-owned [Anthropic transport](codex-anthropic.md). Both use the Orchestrator's existing subscription account pool.

## Bind the account broker

The registry uses the exported `openCodexSession`, already bound to `openCoreAccount`. A new session requires PiStack's starting `--model`. A `--session`-only reopen resolves the saved model and provider before binding its account; explicit starting overrides win. For another broker or protocol fixtures, `createCodexSession` returns an injectable `OpenCoreSession`:

```ts
import { argument } from "./contracts.js";
import { openCoreAccount } from "./account.js";
import { createCodexSession } from "./codex.js";

const openCodex = createCodexSession({
  openAccount: options => {
    const initialModel = argument(options.args, "--model");
    if (!initialModel) throw new Error("PiStack must choose the starting model");
    return openCoreAccount({
      initialProvider: argument(options.args, "--provider") ?? "openai-codex",
      initialModel,
      sessionId: options.sessionId,
      env: options.env,
    });
  },
});
```

`codex-auth.ts` declares the structural lease interface. `credentials()` returns `accessToken`, with `chatgptAccountId` and optional `chatgptPlanType` for OpenAI accounts. Anthropic credentials stay in the transport process and are not sent to the Codex app-server. Native token-refresh requests call `credentials({refresh: true, previousAccountId})`. The broker retains account selection and refresh locks. The adapter calls synchronous `setActive(boolean)` before dispatch and as whole-tree activity changes. The broker owns the corresponding interactive heartbeat and lease release. Opening an idle adapter leaves capacity free; assigned fleet leases remain scheduler-owned. See [external core accounts](core-accounts.md) for activity, affinity, and uncertain-outcome rules.

`recordUsage` receives cumulative counters per native thread, including child threads. It must upsert or subtract the previous counter, not sum notifications. Counts include input, cached input, cache-write input, output, reasoning output, and total tokens. Accounting failures emit `core_error` and block new turns and compaction. Closing the adapter closes its account once, after process-tree cleanup.

Credentials go directly to the private stdio transport. Authentication requests and responses never become portable events. Native stderr is discarded because it can contain request bodies. Non-auth protocol errors pass through the credential guard; auth errors remain opaque. The output callback receives copied, redacted objects. Do not add raw RPC logging at this boundary.

## Runtime commands

Every response has `type: "response"`, the original `id`, `command`, and `success`, followed by `data` or `error`.

| Command | Behavior |
| --- | --- |
| `get_state` | Portable identity, native identity, model/effort/name, unresolved dispatch IDs, last assistant message, and `live` text/thinking/tool activity. Root `isStreaming`, `coreBusy`, and compaction flags include descendants. `treeComplete` becomes true only when the native tree is idle. |
| `prompt` | Sends `turn/start` only when the native tree is idle. Acknowledges native acceptance without waiting for generation. Text and base64 images are supported. |
| `steer` | Sends `turn/steer` with the active turn ID. Starts a turn when idle. |
| `follow_up` | Starts a turn when idle. Fails while busy so PiStack retains the queue. |
| `abort` | Interrupts the root and all discovered descendants, including child-only activity, and terminates their native background terminals. The stop policy also catches children announced while interruption is in progress. Acceptance does not mean interruption has finished; wait for aggregate idle state. |
| `compact` | Starts native compaction and acknowledges acceptance. Completion arrives through lifecycle events. Custom instructions are unsupported. |
| `set_model` | Updates the native thread's model within its current provider family. Changing provider families requires a new thread. |
| `set_thinking_level` | Updates native effort. Pi `off` maps to Codex `none`; native effort names otherwise remain unchanged. |
| `set_session_name` | Sets the native thread name and durable adapter setting. |
| `get_available_models` | Returns the selected provider family's models in PiStack's model-picker shape. OpenAI uses the native catalog; Anthropic uses PiStack's provider catalog and deployed model additions. |
| `get_available_thinking_levels` | Returns the selected native model's supported efforts. |
| `get_commands` | Lists `compact` and enabled native skills. `/skill:name` in a prompt resolves to a native skill input. |
| `get_messages`, `get_entries` | Return the activity projection. Entry IDs derive from native item IDs; entries include native turn IDs. `get_entries` accepts `since`. |
| `fork` | Switches the adapter to a native fork before the selected user-message turn. Returns the selected text, like Pi's edit-message workflow. Mid-turn steering entries cannot be forked separately. |
| `core_agents` | Returns `{agents}` after reconciling all descendant native threads, including grandchildren. |
| `core_agent_read` | Requires `agentId`; returns `{agent, messages, state}`. `state` uses the runtime state shape and includes `canAcceptDirectInput`. Reading history does not clear streamed child messages. |
| `core_agent_command` | Requires `agentId` and `action: "steer"` or `"abort"`. Returns `{accepted: true, agentId, action}` with a native turn ID when available. |

Child steering requires `message` and the native child to advertise `canAcceptDirectInput`. It steers an active turn or starts a continuation when idle. Aborting refreshes native history to find the active turn, so it does not rely on having observed that turn's start. An idle abort is an accepted no-op; an abort acknowledgement does not mean the turn has stopped. Read operations work on stored children. Missing IDs, unknown children, other actions, unavailable native history, and active children without an interruptible turn fail explicitly. Pending native children can be listed before their history is materialized, but cannot yet be read.

Active children are joined with `thread/resume` to subscribe to their events; this does not submit a prompt. Native child forking into a PiStack root is unsupported.

Queue modes, auto-compaction toggles, Pi session switching, arbitrary slash commands, Pi extensions, dynamic client tools, approval dialogs, MCP elicitation, and interactive user-input requests are not implemented. Unsupported runtime commands and native client requests fail explicitly. Hard steer is PiStack's interrupt/wait/dispatch policy, not a second native command.

The adapter reads `--provider`, `--model`, `--thinking`, `--name`, and `--sandbox` from runtime arguments. Other runtime arguments are not passed to Codex. `appServerArgs` on the factory accepts native configuration flags. The defaults are `approvalPolicy: "never"` and `sandbox: "danger-full-access"`; a read-only probe uses `--sandbox read-only`.

## Process ownership and whole-tree stop

The launcher requires Linux and Python 3 with subreaper and pidfd support. A small supervisor inherits the caller's mount namespace, environment, cwd and standard streams. This keeps Remote's private decrypted mount available to the core. Credentials travel only through stdin. The adapter owns a separate lifetime pipe that neither the model nor its tools inherits.

`close()`, natural app-server exit and abrupt owner death all trigger descendant cleanup. The subreaper adopts detached descendants, freezes their parents before enumeration, signals through pidfds and reaps them before releasing the account lease or publishing exit. This covers local same-user tools that use `setsid`, double-fork or ignore SIGTERM without selecting sibling processes. A stop racing startup is checked before the app-server launches.

Root abort normally leaves the native session open after interrupting all known turns and background terminals. If a pending child has no interruptible turn, or native stop requests fail, it closes the owned process tree instead and returns `coreClosed: true`. The response precedes the exit callback; the next request needs a reopened runtime. Saved native history is resumed without replaying accepted work.

Non-Linux hosts and Python builds without pidfd support cannot start this launcher. Processes handed to another supervisor or remote host are outside its ownership. Elevated descendants that the supervisor cannot signal need privileged cleanup. Incomplete cleanup retains the supervisor and account lease and returns an error rather than claiming the tree stopped.

## Events and context

Root `agent_start`/`agent_end` describe aggregate native-tree activity. A root turn completing does not emit `agent_end` while a descendant is busy. Activity also emits `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, and compaction events. Reasoning summaries stream as thinking. Native token usage goes to the broker rather than synthetic message usage fields.

`context_update` contains `context: {systemPrompt, tools, messages}`. It follows finalized `message_end` events. The adapter omits the optional `finalizesMessage` field; Remote derives its finalization key from the last assistant message. It does not send a message object in place of that key. Its `projection: "activity"` and `core: "codex"` fields matter. `systemPrompt` is empty because app-server does not expose the assembled prompt. `tools` lists observed native tool names with `activityOnly: true`, not model-visible tool schemas. The messages are native activity rendered into portable records. Compaction does not erase historical activity from this projection.

`get_state.live` contains `{text, thinking, isThinking, tools}` for active items. Tool entries carry `toolCallId`, `toolName`, and `args`. Native `inProgress` tools remain active when restoring a turn, rather than acquiring a fabricated completed result. A terminal turn or closed thread clears that snapshot. After recovery, a busy native tree with no observable active item remains generic working activity.

Reasoning items emit both `thinking_start` and `thinking_end`, even when no summary text is available. Empty completed reasoning items do not become projected transcript messages. Summary sections retain their boundaries; streamed text survives an empty final item. Native summary and text delta notifications feed the same live projection. No encrypted reasoning is decoded.

The September 13 STP thread had 53 native reasoning records with empty summaries and no raw content. Its native Astra catalog defaulted summaries to `none` and did not advertise `supports_reasoning_summary_parameter`. Codex 0.154.0's [request builder](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/client.rs) omits the summary request parameter without that capability. A separate native Astra request with `model_reasoning_summary="detailed"` still returned no readable reasoning. The UI must show activity without promising text that the provider has not returned. Native history stays unchanged.

Every native child emits `core_agent` with a `CoreAgent` record. Root parent IDs use the stable PiStack session ID; deeper parent IDs use native child IDs. Parentage can be temporarily null when activity precedes metadata. Child activity uses `core_child_event: {agentId, event}` for the portable journal's child stores and never merges into the root's message stream or context. `canAcceptDirectInput` accompanies metadata updates.

## Durable state and continuation

`pi-orchestrator resume RUN_ID` manually resumes a core run whose provider rate-limit retries were exhausted. It keeps the same native session, account, model and thinking level, records the failure under `run-rate-limit:RUN_ID:TIMESTAMP`, and continues on the current release. This explicit operator action can resume already-admitted work before its account cooldown expires; it does not clear that cooldown for other admissions. Credential failures, completed work and operator-aborted runs are excluded. Rate-limit failures are not automatically resumed by deployment recovery.

Fleet workers tolerate up to two minutes of daemon transport loss during deployment. Reads and idempotent heartbeat, state and usage receipts reconnect; dispatch and completion commands are not replayed after an unknown outcome. A recovered native interrupted turn continues in its existing session unless the fleet has a durable operator-abort control. An interruption alone never becomes operator cancellation.

Codex instruction updates are placed immediately before the next assistant turn, or at history end, as required by Anthropic's mid-conversation system interface. A run stopped by the prior system-message ordering defect also supports explicit `recover`; its failed provider turn remains in native history and the repaired continuation uses the same session.

Worker restart and adoption preserve an explicit infrastructure-recovery continuation until the worker reads it. Otherwise a retained failed turn could settle again without submitting the repaired request.

`pi-orchestrator recover RUN_ID` restores a core run stopped by a worker transport failure or a native interruption incorrectly recorded as an operator abort. It requires retained native custody and no operator-abort control, retains the original failure under `run-interruption:RUN_ID:TIMESTAMP`, and keeps the original model, thinking level and account on the current release. Previous-release workers reporting either recognized interruption during deployment receive the same recovery automatically. Other failures and completed work are not reopened.

One runtime owner opens a given `stateDir`. `codex-session.json` stores the native thread ID, saved provider/model settings, message timestamps, transfer status, transferred activity records, and dispatch receipts. Writes use atomic replacement. This is adapter state, not a Pi session file. `get_state.sessionFile` points to it so callers must not open it with Pi's session parser.

`stateDir/codex` is the private native `CODEX_HOME`, including native history. The adapter links existing `config.toml`, `AGENTS.md`, `skills`, `agents`, `rules`, and `plugins` from the configured `CODEX_HOME`, or the user's `.codex`, into that directory. It does not copy native auth or unrelated threads. The OpenAI external token login and ephemeral credential store keep auth out of files. Anthropic's loopback provider endpoint is recreated before native resume; its OAuth token never enters the native home. Recovery requires both the adapter state and native home. Deleting either loses native continuation; there is no automatic conversation replay.

A fresh empty thread is not materialized by Codex. History listing is unavailable until the first user message or explicit history injection. Reopening an untouched empty session creates another empty native thread with the same portable identity. `get_state.nativeSessionDurable` is false during this empty pre-work period, so fleet custody records the adapter file but does not pin that provisional native ID. Once work may have been accepted, the adapter reports it durable, resumes the recorded thread and never replaces it automatically.

Send a stable `workId` with prompt/steer/follow-up commands. RPC `id` is only the fallback receipt key. The adapter persists a pending receipt before dispatch and records native acceptance before acknowledging. A repeated accepted work ID returns its receipt without another turn. Reusing an ID with different content fails. A crash or transport timeout leaves an unknown outcome. On resume, native `userMessage.clientId` can resolve that receipt. Otherwise `get_state.unresolvedCommands` exposes it and retries fail rather than replaying work.

`transfer` is explicit cross-engine conversation data. The adapter injects native Responses message items without starting a turn, setting a system prompt, or adding developer instructions. Plain user/assistant text retains its role. Tool results and other structured blocks become attributed JSON data in user messages, not executable tool calls. Agent metadata is also attributed data; it does not recreate native children. Image blocks in transferred history remain structured data rather than image inputs. Fresh prompt images remain native image inputs. Codex retains injected history but does not return those pre-turn items through its activity API. The adapter therefore retains the supplied transfer projection for `context_update` and message reads. Forking inside that transferred pre-turn history is unsupported; later native user turns can be forked.

Transfer acceptance is recorded before returning. A completed transfer is never reinjected. An uncertain transfer blocks startup pending inspection of native history. This is separate from dispatch receipts and never replays the last user request.

## Astra CLI version rejection

On September 13, 2026, Codex 0.146.0 rejected a native Astra turn with HTTP 400 and `The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.` This was a CLI version gate, not a missing Pi model alias or an account quota failure.

Runtime and Orchestrator now pin 0.154.0, including every platform package in the lockfile. Its native catalog includes Astra, Sol, Terra and Luna. The adapter uses that catalog directly for model and reasoning-effort selection.

A fresh GMKtec request through `openCodexSession` and the normal `openCoreAccount` broker returned `codex-astra-ok` in 4.763 seconds with Astra and high thinking. The request used a disposable read-only directory, no tools, and no copied credentials. Native response `msg_0a32f5f8918aa536016aa6e3544cdc87d196c061a789a2ace3` settled with `treeComplete: true`, no unresolved commands and no core errors. The probe closed its process tree and removed its temporary native state. Typechecking and all 20 adapter/RPC fixture tests passed. Publication owns both host deployments; the failed user turn is not replayed by this update.

## Protocol custody and checks

`src/cores/codex-protocol` contains the required dependency closure from the installed binary's TypeScript schema. The only transformation adds `.js` to import specifiers. The generated upstream schema is covered by the copied [Apache-2.0 license](../src/cores/codex-protocol.LICENSE). The generator resolves Orchestrator's installed package, checks its reported version against both workspace pins, and never selects `codex` from PATH. To regenerate with the pinned binary:

```sh
node packages/orchestrator/src/cores/codex-generate-protocol.mjs
```

Focused fixture tests use no accounts or models:

```sh
node_modules/.bin/vitest run packages/orchestrator/tests/codex-core.test.ts packages/orchestrator/tests/codex-rpc.test.ts --maxWorkers=1
```

The Linux process fixtures check inherited mount identity, detached descendant cleanup, owner SIGKILL, app-server exit, startup races and sibling survival. They take less than a second and make no backend request:

```sh
node_modules/.bin/vitest run packages/orchestrator/tests/codex-process.test.ts --maxWorkers=1
```

The installed 0.146.0 probe used the sibling `openCoreAccount` broker with a read-only sandbox. Authentication, thread creation, catalog/effort/skill discovery, structured transfer, and transfer resume completed through the default `openCodexSession` binding. The catalog contained five models and six skills. No native `auth.json` was created. No model turn was submitted. The integrated core probe then used Luna with one native child, executed a shell command inside that child, waited for its result and returned `core-probe-ok`. The tree reported complete with one child, successful spawn/command/wait events and no core errors.
