# Agent cores

Orchestrator owns run admission, account assignment, worker processes and recovery. A core owns its agent sessions and child tree. `worker.ts` calls `openCoreSession` through the command/event wire; it does not use Pi's `AgentSession`.

## Choice and custody

Config defaults to `core: "pi"`. `profileCores` sets a core for a named model profile without changing that profile's model candidates or thinking levels:

```json
{
  "core": "pi",
  "profileCores": { "astra": "codex" }
}
```

A lane's optional `core` overrides the profile setting. `POST /v1/run` and `POST /v1/wave` accept `core: "pi" | "codex"`; an explicit wave value overrides its lane. CLI `run` and `wave` accept `--core`. Unknown core IDs return HTTP 400. The order is explicit run value, lane value, profile setting, config default, Pi.

Creation commits `run-core:<runId>` alongside the run row. It records the selected core, `childrenOwner: "core"`, and `coreStateDir`, an absolute `runs/<runId>` directory beside the ledger. Lane values live in `lane-core:<laneId>`. These use the existing control table; no database schema transition is needed.

Core custody is immutable through the worker state API. `get_state` updates only native and portable session references. Account assignment still pins the PiStack model, thinking level and immutable worker release. Recovery reuses that release, the same run ID and its recorded core directory. It never resolves the core from a changed lane or config. The directory holds durable native and portable records and is not part of application workspace cleanup.

Codex admission uses only the profile's `openai-codex` candidates, retaining their order and thinking settings. A profile with no supported candidate fails explicitly. Core selection does not change pacing, concurrency, reservation, budget or account policy. Tool-free completion requests retain their existing executor.

## Worker wire

The factory receives `cwd`, `args`, `env`, stable `sessionId` and `stateDir`. `PI_STACK_CORE` carries the pinned engine. Arguments include the provider family, physical model, thinking level, and a native `--session` reference when one exists. `PI_ORCHESTRATOR_ACCOUNT_ID` and the assigned run identify the pooled account; account aliases do not become native Codex provider names. `PI_ORCHESTRATOR_NATIVE_SESSION_ID` retains the native identifier independently of the stable run ID.

[`CoreController`](../src/cores/controller.ts) is the host broker for Remote and fleet. `CoreDispatch` identifies prompt, steer, follow-up, compact and abort work. Requests return `CoreOutcome<T>` with distinct rejected, unknown, unavailable and unsupported failures. Foreign transport exceptions become unknown outcomes, not rejections. `request(type, fields, timeoutMs)` accepts zero to leave an operation without a host deadline. Compact owns its native completion deadline.

Both `execution_update.execution` and `get_state.execution` carry `CoreExecutionSnapshot`: a durable revision, status `idle | running | stopping | blocked`, and every operation receipt. Operations retain their `workId`, agent, kind, state, error and result text. States are `pending | accepted | running | succeeded | failed | cancelled | unknown`. Unknown is not terminal and cannot be rewritten by a delayed acknowledgement or an unrelated native completion event. `get_state` with a `workId` also returns that `operation`; absence never selects a previous assistant result.

The broker rejects missing or contradictory execution snapshots and ignores stale revisions. An idle snapshot cannot contain unresolved operations. A runtime without this contract stays pinned to its recorded release or waits for deployment to drain it. It is never treated as idle. The fleet worker leaves unknown execution in `waiting`, without resubmitting the task. A proven empty session can receive its first dispatch; a completed receipt settles its exact run without another prompt. Fleet control messages must retain a durable `steerWorkId`.

Text, thinking and tool events update heartbeats and usage only. Native streaming flags, `agent_end`, `agent_settled`, `treeComplete` and last-assistant projections cannot settle host work. Provider failure, cancellation and final text come from the requested operation receipt. The worker closes the core before publishing success; the transient systemd unit remains the process boundary.

Assistant message usage goes to `/internal/runs/:id/usage` with a SHA-256 receipt. The daemon records each receipt and its component totals in one transaction, so replay does not double-charge. Child message events carry their own receipt identity. The worker sets `PI_ORCHESTRATOR_CORE_USAGE=worker`: adapters must suppress ordinary assistant accounting elsewhere while retaining provider-operation accounting and meter-header collection. An adapter that records usage itself can mark an event and final state `usageRecorded: true`. Native Codex token notifications can remain with the shared account owner when its projected messages carry no usage.

Observation adds core and native/portable references to each run. Transcript tails prefer the portable conversation file, preserving the existing transformed tail API for both engines.

## Isolated application runs

Codex isolated context contracts return HTTP 422 before run creation, including an empty tool list. There is no silent conversion to an unrestricted native session.

For Pi, the worker forwards the entire contract as `--orchestrator-context JSON`. The adapter can call `isolatedCoreContext(options)` from `host/isolated-context.ts`, which uses the existing isolated loader. This retains application extensions, explicit tool selection, instruction/skill/settings exclusion, isolated HOME and credential-environment filtering. Native sessions stay in the durable core directory.

Before prompting, `get_state.context` must confirm the requested `tools` and `extensions`. A missing or different confirmation fails the run. Merely accepting CLI arguments is not proof that the adapter loaded the requested tools.

## External child records

Rows without core custody describe runs admitted by the external-child worker release. They project as Pi with `childrenOwner: "orchestrator"`. Their recorded worker release still owns transcript receipts, dispatch repair and coordinator continuation. The daemon keeps dispatch, acknowledgement, waiting settlement and wakeup for those active records. Terminal child results remain observable.

New core-owned runs cannot call the dispatch endpoint and never enter the external-child waiting path. New workers fail explicitly if given external child receipts rather than inventing a second child scheduler. An existing coordinator must recover through its recorded release; loss of that release is an infrastructure failure requiring repair, not permission to discard its pending children. Existing unassigned rows acquire Pi core custody on first admission.

## Fixtures

From the repository root:

```bash
npx vitest run --root packages/orchestrator tests/core-custody.test.ts tests/worker.test.ts tests/fleet.test.ts --maxWorkers=1
```

These cover precedence, immutable custody, child ownership and worker outcomes. `tests/core-execution.test.ts` covers reply/event reorder, ambiguous effects, repeated identities, reopen and released runtimes without execution authority. `tests/pi-core.test.ts` covers queued work, child settlement, compact/abort receipts and result retention.
