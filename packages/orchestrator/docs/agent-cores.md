# Pi sessions and custody

Orchestrator owns run admission, account assignment, worker processes and recovery. Pi owns agent sessions and the recursive child tree. `worker.ts` calls `openCoreSession` through the command/event wire. Pi is the sole engine. OpenAI Codex and Anthropic remain model providers with pooled OAuth; they do not select an engine.

## Durable custody

Creation commits `run-core:<runId>` alongside the run row. It records Pi, `childrenOwner: "core"`, and `coreStateDir`, an absolute `runs/<runId>` directory beside the ledger. Custody is immutable through the worker state API. `get_state` updates native and portable session references. Account assignment pins the model, thinking level, immutable worker release and launch environment. New admissions use `high` thinking except catalog Luna uses `max`; recovery keeps an existing admission's thinking unchanged. Recovery reuses that release, run ID and state directory. Execution identity is recorded at creation as `user` or `root-repair`, independently of later manifest edits. [Root repair lanes](../README.md#root-repair-lanes) describe system-unit scope, shared filesystem custody and pause controls.

The directory holds native sessions, the Pi child tree, portable conversation records and activity. Workspace cleanup does not remove it. A persisted non-Pi owner requires explicit conversation transfer before Pi can continue it. Changing a stored engine label does not convert a transcript.

## Worker wire

`openCoreSession` receives `cwd`, `args`, `env`, stable `sessionId` and `stateDir`. Arguments include provider, model, thinking level and a native `--session` reference when one exists. `PI_ORCHESTRATOR_ACCOUNT_ID` and the assigned run identify the pooled account. `PI_ORCHESTRATOR_NATIVE_SESSION_ID` retains the native identifier independently of the stable run ID.

The worker uses `prompt`, `abort`, `steer` and `get_state`, with correlated `response` events. Prompt acknowledgement and root `agent_end` do not complete a run. `get_state.treeComplete` reports completion of the whole Pi-owned tree. State includes `lastAssistantMessage`, `messageCount`, busy flags, `nativeSessionId`, `sessionFile` and `portableFile`. Missing completion authority is an infrastructure failure. A recovered empty session receives the original task; a completed tree settles without another prompt.

Text, thinking, tool and native compaction events update heartbeats. Core errors and provider/compaction failures produce failed runs. Abort stops the tree. The worker closes Pi before exiting; its systemd unit remains the process boundary.

Assistant usage goes to `/internal/runs/:id/usage` with a SHA-256 receipt. The daemon records each receipt and its component totals in one transaction so replay does not double-charge. Child events carry their own receipt identities. `PI_ORCHESTRATOR_CORE_USAGE=worker` suppresses duplicate ordinary assistant accounting while retaining provider-operation accounting and meter-header collection.

## Portable imports

`get_portable_conversation` exports complete messages without provider reasoning signatures. `readPortableConversation` reads the active branch of a Pi-native or portable journal, including retained portable Codex conversation journals. It does not decode Codex app-server native rollouts.

For an existing Codex conversation, export its portable conversation before retiring its engine owner. Pass that object as `transfer` or place it at `transfer.json` in a new state directory. Its `sourceCore: "codex"` is historical provenance, not an operational engine choice. Pi imports the messages once, without replaying requests or restoring foreign children. The transfer hash rejects different content in the same generation. See [Pi import behavior](pi-core.md#portable-import).

Native session opens and switches reject Codex rollouts and portable journals rather than letting the SDK rewrite them as empty Pi sessions. Keep source files intact until the new Pi state and Remote references have durable custody.

## Isolated application runs

The worker forwards `--orchestrator-context JSON` to the [isolated loader](../src/host/isolated-context.ts). This retains application extensions, explicit tool selection, instruction/skill/settings exclusion, isolated HOME and credential-environment filtering. Native sessions stay in the durable state directory.

Before prompting, `get_state.context` must confirm the requested `tools` and `extensions`. A missing or different confirmation fails the run.

## External child records

Rows without core custody describe runs admitted by an external-child worker release. They project as Pi with `childrenOwner: "orchestrator"`. Their recorded release owns transcript receipts, dispatch repair and coordinator continuation. Existing coordinators recover through that release so pending children are not discarded.

New Pi-owned runs cannot call the external dispatch endpoint or enter its waiting path. Their workers reject external child receipts. Existing unassigned rows acquire Pi custody on first admission.
