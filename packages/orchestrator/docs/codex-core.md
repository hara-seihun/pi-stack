# Codex app-server core

`src/cores/codex.ts` adapts the installed Codex 0.146.0 app-server to PiStack's runtime wire. Codex owns instructions, native tools, skills, compaction, and child agents. PiStack chooses the starting model and effort, supplies an account lease, and controls dispatch. No Pi system prompt or Pi tools are installed into Codex.

## Bind the account broker

The registry uses the exported `openCodexSession`, already bound to `openCoreAccount`. It requires PiStack's starting `--model`. For another broker or protocol fixtures, `createCodexSession` returns an injectable `OpenCoreSession`:

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

`codex-auth.ts` declares the structural lease interface. `credentials()` returns `accessToken`, `chatgptAccountId`, and optional `chatgptPlanType`. Native token-refresh requests call `credentials({refresh: true, previousAccountId})`. The broker retains account selection, refresh locks, heartbeat, and lease release.

`recordUsage` receives cumulative counters per native thread, including child threads. It must upsert or subtract the previous counter, not sum notifications. Counts include input, cached input, cache-write input, output, reasoning output, and total tokens. Accounting failures emit `core_error` and block new turns. Closing the adapter closes its lease once.

Credentials go directly to the private stdio transport. Authentication requests and responses never become portable events. Native stderr is discarded because it can contain request bodies. Non-auth protocol errors pass through the credential guard; auth errors remain opaque. The output callback receives copied, redacted objects. Do not add raw RPC logging at this boundary.

## Runtime commands

Every response has `type: "response"`, the original `id`, `command`, and `success`, followed by `data` or `error`.

| Command | Behavior |
| --- | --- |
| `get_state` | Portable identity, native identity, model/effort/name, streaming/compaction flags, unresolved dispatch IDs, last assistant message, and native-tree completion. |
| `prompt` | Sends `turn/start`. Acknowledges native acceptance without waiting for generation. Text and base64 images are supported. |
| `steer` | Sends `turn/steer` with the active turn ID. Starts a turn when idle. |
| `follow_up` | Starts a turn when idle. Fails while busy so PiStack retains the queue. |
| `abort` | Sends `turn/interrupt`. Acceptance does not mean interruption has finished; wait for lifecycle events or idle state. |
| `compact` | Starts native compaction and acknowledges acceptance. Completion arrives through lifecycle events. Custom instructions are unsupported. |
| `set_model` | Updates the native thread's model for subsequent turns, using the native catalog. |
| `set_thinking_level` | Updates native effort. Pi `off` maps to Codex `none`; native effort names otherwise remain unchanged. |
| `set_session_name` | Sets the native thread name and durable adapter setting. |
| `get_available_models` | Returns the paginated native model catalog in PiStack's model-picker shape. |
| `get_available_thinking_levels` | Returns the selected native model's supported efforts. |
| `get_commands` | Lists enabled native skills. `/skill:name` in a prompt resolves to a native skill input. |
| `get_messages`, `get_entries` | Return the activity projection. Entry IDs derive from native item IDs; entries include native turn IDs. `get_entries` accepts `since`. |
| `fork` | Switches the adapter to a native fork before the selected user-message turn. Returns the selected text, like Pi's edit-message workflow. Mid-turn steering entries cannot be forked separately. |
| `get_agents` | Reconciles all descendant native threads, including grandchildren. |

Use `agentId` on a command to target a known native child. Read operations work on stored children. Input requires the native child to advertise `canAcceptDirectInput`. Active children are joined with `thread/resume` to subscribe to their events; this does not submit a prompt. Native child forking into a PiStack root is unsupported.

Queue modes, auto-compaction toggles, Pi session switching, arbitrary slash commands, Pi extensions, dynamic client tools, approval dialogs, MCP elicitation, and interactive user-input requests are not implemented. Unsupported runtime commands and native client requests fail explicitly. Hard steer is PiStack's interrupt/wait/dispatch policy, not a second native command.

The adapter reads `--provider`, `--model`, `--thinking`, `--name`, and `--sandbox` from runtime arguments. Other runtime arguments are not passed to Codex. `appServerArgs` on the factory accepts native configuration flags. The defaults are `approvalPolicy: "never"` and `sandbox: "danger-full-access"`; a read-only probe uses `--sandbox read-only`.

## Events and context

Root activity emits `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, and compaction events. Reasoning summaries stream as thinking. Native token usage goes to the broker rather than synthetic message usage fields.

`context_update` contains `context: {systemPrompt, tools, messages}` and, when a message completes, `finalizedMessage`. Its `projection: "activity"` and `core: "codex"` fields matter. `systemPrompt` is empty because app-server does not expose the assembled prompt. `tools` lists observed native tool names with `activityOnly: true`, not model-visible tool schemas. The messages are native activity rendered into portable records. Compaction does not erase historical activity from this projection.

Every native child emits `core_agent` with a `CoreAgent` record. Root parent IDs use the stable PiStack session ID; deeper parent IDs use native child IDs. Parentage can be temporarily null when activity precedes metadata. Child activity uses `core_child_event: {agentId, event}` for the portable journal's child stores and never merges into the root's message stream or context. `canAcceptDirectInput` accompanies metadata updates.

## Durable state and continuation

One runtime owner opens a given `stateDir`. `codex-session.json` stores the native thread ID, settings, message timestamps, transfer status, transferred activity records, and dispatch receipts. Writes use atomic replacement. This is adapter state, not a Pi session file. `get_state.sessionFile` points to it so callers must not open it with Pi's session parser.

`stateDir/codex` is the private native `CODEX_HOME`, including native history. The adapter links existing `config.toml`, `AGENTS.md`, `skills`, `agents`, `rules`, and `plugins` from the configured `CODEX_HOME`, or the user's `.codex`, into that directory. It does not copy native auth or unrelated threads. The external token login and ephemeral credential store keep auth out of files. Recovery requires both the adapter state and native home. Deleting either loses native continuation; there is no automatic conversation replay.

A fresh empty thread is not materialized by Codex. History listing is unavailable until the first user message or explicit history injection. Reopening an untouched empty session creates another empty native thread with the same portable identity. Once work may have been accepted, the adapter resumes the recorded thread and never replaces it automatically.

Send a stable `workId` with prompt/steer/follow-up commands. RPC `id` is only the fallback receipt key. The adapter persists a pending receipt before dispatch and records native acceptance before acknowledging. A repeated accepted work ID returns its receipt without another turn. Reusing an ID with different content fails. A crash or transport timeout leaves an unknown outcome. On resume, native `userMessage.clientId` can resolve that receipt. Otherwise `get_state.unresolvedCommands` exposes it and retries fail rather than replaying work.

`transfer` is explicit cross-engine conversation data. The adapter injects native Responses message items without starting a turn, setting a system prompt, or adding developer instructions. Plain user/assistant text retains its role. Tool results and other structured blocks become attributed JSON data in user messages, not executable tool calls. Agent metadata is also attributed data; it does not recreate native children. Image blocks in transferred history remain structured data rather than image inputs. Fresh prompt images remain native image inputs. Codex retains injected history but does not return those pre-turn items through its activity API. The adapter therefore retains the supplied transfer projection for `context_update` and message reads. Forking inside that transferred pre-turn history is unsupported; later native user turns can be forked.

Transfer acceptance is recorded before returning. A completed transfer is never reinjected. An uncertain transfer blocks startup pending inspection of native history. This is separate from dispatch receipts and never replays the last user request.

## Protocol custody and checks

`src/cores/codex-protocol` contains the required dependency closure from the installed binary's TypeScript schema. The only transformation adds `.js` to import specifiers. To regenerate with the pinned binary:

```sh
node packages/orchestrator/src/cores/codex-generate-protocol.mjs
```

Focused fixture tests use no accounts or models:

```sh
node_modules/.bin/vitest run packages/orchestrator/tests/codex-core.test.ts packages/orchestrator/tests/codex-rpc.test.ts --maxWorkers=1
```

The installed 0.146.0 probe used the sibling `openCoreAccount` broker with a read-only sandbox. Authentication, thread creation, catalog/effort/skill discovery, structured transfer, and transfer resume completed through the default `openCodexSession` binding. The catalog contained five models and six skills. No native `auth.json` was created. No model turn was submitted. Real generation, native tool execution, child spawning, and live compaction remain for the single integrated end-to-end model probe, not independent adapter spending.
