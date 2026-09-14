# Pi sessions

Pi is Pi Stack's only agent engine. Astra, Sol, Terra, Luna, Fable and Opus remain model choices. OpenAI subscription access and server-side compaction work through Pi; the Codex CLI and app-server are not installed or launched.

## Ownership

Pi owns prompt assembly, tools, compaction, native session state and its child tree. Pi Stack owns model selection, account admission, durable input delivery, activity journals and operator controls. The [Pi adapter](../packages/orchestrator/docs/pi-core.md) and [fleet lifecycle](../packages/orchestrator/docs/agent-cores.md) describe the command/event wire shared by Remote and Orchestrator.

Remote's settings select a model, thinking level, OpenAI priority mode and bash timeout. There is no engine selector. Session creation, settings, run and wave APIs reject a supplied `core` field. The CLI rejects `--core`. Destination, lane and profile configuration no longer selects an engine.

## Conversation custody

Remote's `session_cores` record identifies the Pi session's state directory. Each directory contains the portable `conversation.jsonl`, completed activity events, child identities and native Pi session files. The portable transcript is activity history, not a claim to be the provider's exact request.

Previously recorded conversations can be imported explicitly through the Pi adapter. Import preserves messages and tool results but does not carry provider-specific thought signatures or native checkpoints between engines. Source engine names in retained transcripts are provenance, not selectable runtimes. A native non-Pi file cannot be opened as Pi. Existing source files remain referenced by the imported conversation's provenance.

Remote freezes accepted dispatch payloads with their work IDs before sending them. Recovery reconciles the same receipt rather than inventing a replacement request. Completed work is not replayed during deployment or conversation import.

`read-thread` selects the portable journal for a Remote thread once one exists. Explicit native file paths read the original Pi session.

## Children

Pi publishes child metadata and journals child activity before Remote projects its live wire. The supervisor stores child identities without duplicating their complete journals.

- `GET /v1/sessions/:sessionId/core/agents` reads observed children without starting Pi.
- `GET /v1/sessions/:sessionId/core/agents/:agentId` reads a child's state and messages.
- `POST` to the child path accepts `{"action":"abort"}` or `{"action":"steer","message":"..."}`.

Thread settings retains child inspection and stop controls. Native children do not enter the external Remote delegation endpoint. Previously accepted external delegations retain their delivery records.

## Deployment

The [publication worker](deployment.md) owns integration, both host releases and Android distribution. Running Pi sessions keep their loaded release until their turns settle. Historical native transcripts remain stored; they do not justify retaining an alternate engine launcher.
