# Agent cores

PiStack selects an agent engine independently of its starting model. `pi` and `codex` identify engines; Astra, Sol, Terra and Luna identify models.

## Ownership

The core owns prompt assembly, tool execution, compaction, native session state and child delegation. PiStack owns the starting root model and reasoning effort, account selection, durable input delivery, the portable activity record, and operator controls. The core chooses models and reasoning effort for its children. Both the core and PiStack retain logs.

PiStack sends commands rather than inspecting a core's internal objects. Steering, hard steering and queued input retain PiStack's delivery semantics; the adapter translates them into native operations. Hard steering stops the current operation before delivering replacement input. A stopped process is not proof that an external effect was undone.

Root admission keeps the existing budget and concurrency settings. Hara proposed removing them but did not settle that decision. Child scheduling belongs to the core. Codex children share their app-server's pooled account and native concurrency limits rather than becoming separately admitted Orchestrator runs. Tool discovery is treated as PiStack's selection of available core and host capabilities; the core still owns execution and its prompt representation. Workspace and persistent-memory behavior remain engine-specific rather than acquiring a new cross-engine policy.

The shared boundary is [`cores/contracts.ts`](../packages/orchestrator/src/cores/contracts.ts). [`cores/index.ts`](../packages/orchestrator/src/cores/index.ts) selects an adapter and attaches the portable journal. The runtime command and event wire is shared by interactive and fleet hosts. Native engine objects stay behind the adapter. The [Pi adapter](../packages/orchestrator/docs/pi-core.md), [Codex adapter](../packages/orchestrator/docs/codex-core.md), [account bridge](../packages/orchestrator/docs/core-accounts.md), and [lane/run lifecycle](../packages/orchestrator/docs/agent-cores.md) own their implementation details and limitations.

## Selecting a core

In Remote, Thread settings contains **Agent core**. `POST /v1/sessions` accepts `core: "pi" | "codex"`; an omitted selection uses the destination's `core`, then `PI_STACK_DEFAULT_CORE`, then Codex. Existing threads without a core record remain Pi threads, regardless of the default.

`PUT /v1/sessions/:sessionId/settings` with `{"core":"codex"}` switches an idle root. Core changes are separate from other settings changes. Codex accepts OpenAI and Anthropic starting models. Anthropic uses the session-owned [Messages transport](../packages/orchestrator/docs/codex-anthropic.md) through Codex's custom Responses provider. Model changes within the selected provider family are supported; changing families requires a new thread. Changing the default does not move existing sessions or replay their work.

The settings API returns `core`, `cores` and observed `agents`. Controls unavailable in a core are disabled rather than accepted without effect. Native engine extensions are not interchangeable merely because both engines can run shell commands.

## Conversation transfer and storage

Remote's `session_cores` table pins the engine and state directory. Native session references remain engine-owned. A core generation lives under the person's data directory in `core-sessions/THREAD/`, with later generations below their switch IDs.

Each generation contains:

- `conversation.jsonl`, PiStack's portable activity transcript, including messages and tool calls/results. It has an explicit `portable-activity` header, not a claim to be the core's exact model context.
- `activity.jsonl`, completed message and operation events. Token deltas stay live; complete messages are synced to disk.
- `agents.json` and per-child journals, retaining observed agent identities and activity.
- The core's own files, native IDs and checkpoints.

On a switch, PiStack exports the active conversation and saves `transfer.json` in a new generation. The destination engine creates a new native session from that data. Provider-specific thought signatures and encrypted checkpoint fields are not portable. The source engine's records remain referenced by `core_switches`, which records the source, target and outcome. Selection and session references change in one database transaction. A failed startup stops the candidate before restoring the source selection. If the candidate cannot stop, its selection stays pinned rather than pointing a live process at the wrong engine. After a supervisor interruption, startup reconciles the switch receipt against the committed selection. Messages and conversation edits wait until the switch finishes.

A fork changes the active portable branch without erasing earlier records. Transfer uses the active branch. Native compaction does not erase the original activity record.

Remote freezes core dispatch payloads in `core_dispatches` before sending them, with the durable work ID as the native receipt key. Recovery resends that same envelope for receipt reconciliation, never a rewritten request. The adapter acknowledges already accepted work without executing it again. Codex keeps unresolved native outcomes as failures requiring inspection. Pi owns continuation from its saved native history and root work receipt; Remote does not add a second recovery request. Explicit command refusals finish the work item with its error rather than entering a host retry loop. Core-native retries remain native.

`read-thread` selects the portable journal for a Remote thread once one exists. Direct native file paths still read the native file. Both formats retain their original provenance.

## Observing and controlling children

The core publishes `core_agent` and `core_child_event`. Remote stores child metadata in `core_agents`, keyed by the owning thread and core generation, rather than admitting each child as a separate PiStack thread. Its [runtime wire projection](../apps/remote/docs/runtime-wire.md) drops child event envelopes after the core journal records them. The supervisor does not duplicate those journals in SQLite; child inspection requests still return complete transcripts. Fleet consumers retain the complete core wire for accounting. A core reports whole-tree activity and settlement.

- `GET /v1/sessions/:sessionId/core/agents` reads observed agents without starting the engine.
- `GET /v1/sessions/:sessionId/core/agents/:agentId` asks the engine for that agent's state and messages.
- `POST` to the same agent path accepts `{"action":"abort"}` or `{"action":"steer","message":"..."}` and waits for the adapter's acknowledgement.

Thread settings exposes child inspection and stop controls. Unsupported native operations return an error. Native children do not enter the former Remote delegation endpoint merely to appear in the UI. Already accepted external delegations retain their existing delivery records.

## Operations

The [deployment procedure](deployment.md) publishes one stack commit to both hosts. Active sessions keep their release until they settle; new sessions use the selected adapter. PiStack Voice remains the separate real-time voice service and delegates computer work to its associated text thread.

The journal and registry tests cover persisted engine choices, child metadata, active-branch transfer, duplicate event identities and reopen. Engine-specific tests cover native protocol mapping and lifecycle. Neither a portable transcript nor a successful initialization alone proves native tool or child execution.
