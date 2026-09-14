# Pi Orchestrator

Pi Orchestrator runs unattended agent cores against pooled subscription accounts. One daemon owns policy and SQLite state. Each admitted run gets a separate transient user systemd unit and keeps the release that launched it until the run ends.

## Runtime model

The daemon reconciles provider meters, weighted lanes, optional queue readiness, and explicit requests for direct runs.

A lane has a positive weight, not a worker target. Weights divide available concurrency among eligible lanes. The manifest selects paced background admission or work-driven forced admission. A wave remains a one-off batch, not a standing target. Each run ends when its agent finishes its turn.

Workers write progress through the daemon's loopback API. Each run pins its agent core and durable state directory. If a worker process or machine stops, the next worker reopens that same core state. Native and portable session references remain in run custody. See [Pi sessions](docs/agent-cores.md) for the worker wire and isolated-context requirements. The run row records the immutable release path and transient unit name, so a daemon deployment does not replace live workers. Recovery adopts a still-active unit when a daemon restart races the user manager; an already-loaded inactive transient unit restarts from its recorded release instead of being redefined.

## Fleet coordination

New runs delegate through Pi, which owns its child tree and completion. Workers no longer expose `fleet_dispatch`. Existing external-child coordinators retain their recorded worker release and the daemon's receipt, waiting and wakeup path. Parent links, waiting state, terminal children and transcripts remain observable. See [external fleet records](docs/fleet-dispatch.md) for their active recovery contracts. Isolated application runs use Pi's explicit tools/extensions contract.

## Quota policy

At 1×, ordinary work stays within the elapsed share of each provider window's allowance, including the configured reserve. A whole-percentage-point tolerance accounts for provider rounding. Every binding meter must be fresh. A flat pair of readings cannot erase earlier overspending.

The account concurrency ceiling also uses up to six hours of same-window consumption divided by recorded session-hours, with one percentage point added for meter uncertainty. Meter history is retained for 24 hours rather than a fixed sample count. At least 15 minutes of evidence is required to move beyond one calibration session. While spend remains within calendar pace, the ceiling keeps one discrete admission even when the measured rate cannot sustain one continuously; the next meter observation and calendar gate decide whether a successor may start. Fleet, interactive, and voice leases share the account and machine ceilings. At 1×, new work consumes at most one admission per meter observation.

These ceilings govern admission only. Already admitted workers finish even when pacing, reserves, account reservations, provider boosts, or machine limits would refuse new work. Their leases remain charged, so replacements cannot bypass those limits. Worker recovery retains the same run, account, release, model, thinking level, core and native/portable state without a new quota admission. Explicit operator aborts and stall handling still apply.

`status` exposes the manifest's `laneBudget`, account ceilings and reasons under that budget, and each lane's active count. Pi Remote includes every starting or running session in its running total.

`run --force` and `wave --force` are operator-authorized urgent work. API callers select the same policy with `force: true`, including EverythingLIVE's author/review jobs. These runs bypass background pacing, reserves, meter freshness, observation throttling, and provider multipliers, including 0×. Exhausted provider quota, cooldowns, disabled or reserved accounts, account and machine concurrency ceilings, and the global `pause` still apply.

Provider boosts multiply the calculated session ceiling directly, after the base account ceiling and consumption estimate. A base capacity of 2 becomes 20 at 10×, not 4 because of an unscaled account cap. Boosts above 1 bypass calendar pacing and the one-admission-per-observation gate, so the scheduler fills the boosted capacity immediately. They do not raise the quota allowance. Fresh meters, provider exhaustion, cooldowns, reservations, the background reserve and the machine ceiling still apply. A multiplier of zero halts new background launches for that provider, not forced runs. Ten times the sustainable rate aims to spend a week's allowance in about 16.8 hours; rounding, changing measured consumption and other binding windows affect the actual duration.

The routing extension uses the same account registry for interactive Pi sessions. It keeps a session on one account unless that account fails. Interactive capacity leases are activity-scoped: loading a session, retaining an idle child, or selecting a model while idle does not reserve a slot. Agent work holds its lease through tools, automatic retries and queued continuations until `agent_settled`; manual compaction holds a lease until success, failure or cancellation. The selected account remains in session history after the lease ends. A model switch during a turn leaves the in-flight account charged until that turn ends, then moves the reservation to the selected account. Fleet leases remain scheduler-owned.

Tree summarization needs a separate lifecycle repair. Pi emits `session_tree` on success but has no terminal extension event for failure or cancellation, so routing does not acquire a lease from `session_before_tree`.

Recovery restores both the model and the thinking level from the active transcript branch when Pi has not resolved the saved provider. Otherwise Pi's temporary non-reasoning startup model can turn a saved `high` into `off`, which Astra and Fable clamp to `minimal` on model restoration. A model already restored with a supported level keeps that level, including explicit startup overrides. Account failover carries the current level to the replacement account. Defaults only initialize new sessions. On session shutdown it closes provider resources through the same external `pi-ai` module that supplied its providers. Pi's bundled CLI has a separate resource registry; relying on its cleanup alone leaves a completed Codex WebSocket alive until the five-minute idle timeout, keeping one-shot processes and their callers waiting. A response that reaches the provider's output-token limit is continued inside the same Pi run: the provider ended it with `stopReason=length`, so the agent did not choose to stop and the session must not settle there. This is separate from the removed fleet check-ins, which used to restart turns that agents had ended normally. The usage extension aggregates attribution hourly, one row per input, output, cache read, and cache write, and records provider meter headers. Keeping the components apart is what lets `plans()` report the share of prompt tokens a model read from cache over the last 24 hours.

## Compaction requests

The [Codex compaction extension](../runtime/extensions/codex-compaction/README.md) submits its server request through the routing extension's [`pi-stack:provider-operation` broker](src/extension/provider-operation.ts). The broker resolves shared OAuth, repairs a refused token once, owns request leases and records usage through the same function as ordinary assistant messages. Interactive rate limits can select another eligible account without changing the model. Fleet operations stay on the scheduler-assigned account. A three-minute signal bounds the operation, and shutdown cancels pending requests before closing the ledger. Native compaction usage is not counted again when Pi persists its entry. Pi owns the compaction boundary, stored checkpoint and continuation; the broker does not start another agent.

## Image inputs

Anthropic requests use [reusable Files API references](docs/anthropic-files.md) instead of resending image bytes on every turn. The provider wrapper preserves original session images and owns account-scoped upload reuse.

## Image generation

The routing extension provides a native [`image_generation` tool](docs/image-generation.md) when an OpenAI account is connected. It works from any chat model, defaults to Image 2.5 Flare, and also supports Image 2.5 Sunburst and image editing. Shared requests use the existing account registry, OAuth lock and leases. Pi saves a PNG and returns an image preview.

The [shared image generation API](docs/image-service.md), exported through `pi-orchestrator/api`, exposes that same pooled generation owner to the Remote supervisor. It returns image bytes and provider metadata; Remote owns durable jobs and artifacts. Its lifecycle closes active requests before releasing the ledger connection.

## Configuration

Set paths with:

```text
PI_ORCHESTRATOR_CONFIG
PI_ORCHESTRATOR_LEDGER
PI_ORCHESTRATOR_AUTH
PI_ORCHESTRATOR_HOST
PI_ORCHESTRATOR_LISTEN_HOST
PI_ORCHESTRATOR_PORT
```

The JSON config may set model `profiles`, `backgroundSpendFraction`, machine and account concurrency, meter age, reconciliation periods, stall limits, `taskManifest`, `authPath`, and `agentDir`. The strict `astra`, `sol`, `terra`, `luna`, and `opus` profiles are always available alongside configured profiles. Each selects exactly one catalog model, even if a local profile uses the same name.

The [shared catalog](src/catalog.ts) maps Astra to `openai-codex/gpt-6-astra` and Sol, Terra, and Luna to `openai-codex/gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. All four share the Codex five-hour and weekly meters. Their strict profiles use the catalog's thinking defaults, `xhigh` for Astra and `max` for Sol, Terra, and Luna. Host-defined profiles can choose different thinking levels.

`SUBAGENT_MODEL_DESCRIPTIONS`, exported through `pi-orchestrator/api`, contains Hara's four verbatim engineering-level descriptions and her classification/inference exception, supplied on September 11, 2026. Tool schemas share that text without adding a model-selection policy.

Model availability does not assign a model to a lane. Autonomous coordinator selection belongs to the submitting application or host lane manifest, which can name `astra` or `sol`. Task workers can select any of the four. Pi Stack leaves configured profile candidate order and lane defaults unchanged, including Converge's. Without configured profiles, `standard` still tries Astra then Opus and `expert` tries Opus then Astra. These general scheduling profiles do not identify coordinator roles.

Profile candidates retain their priority order. A candidate can replace `thinking` with `thinkingPair: ["high", "max"]` to assign equal numbers of new runs to those levels, in randomly ordered pairs. The first admission draws one level; the next admission of that profile/provider/model consumes the other. The pending level lives in the ledger's `control` table and commits atomically with the run and lease, so restarts, quota refusals and failed database transactions do not consume a slot. Different profiles and models have separate pairs. Existing and recovered runs retain their recorded level. Provider and account selection stay unchanged. Configuration changes require a daemon restart.

For an experiment, record the activation time and compare new runs by `run.thinking`. `run.id` joins their token totals in `usage_hour`; session files retain the work and results. Equal admission counts do not imply equal concurrent counts or equal completion counts. A worker-launch failure remains an assigned trial and is recorded as such rather than silently replaced in the allocation.

A lane manifest has `version: 2` and a `lanes` array. Every lane declares `id`, `prompt`, `cwd`, `profile`, and positive `weight`. Unknown fields are rejected, including worker targets.

The manifest's optional `budget` is `background` by default. Setting it to `force` makes every lane use the existing urgent admission policy, without background pacing, reserve, meter-age or multiplier gates. This mode requires a non-empty `snapshotCommand`. Its current readiness decides whether another worker is needed; `ready: false` stops new workers until work appears again. Actual provider exhaustion, disabled or reserved accounts, cooldowns, account and machine ceilings, and global pause still apply. The daemon owns continuation, with no repeated waves or waiting model session. Manifest reload changes new admissions only. Each run records its selected budget, so existing runs retain their policy across restarts.

Without a `snapshotCommand`, background lanes are continuously eligible. An optional command reports whether each queue has unclaimed work, never how many workers to run:

```json
{
  "revision": "business-state-version",
  "lanes": {
    "review": { "ready": true },
    "publication": { "ready": false }
  }
}
```

The daemon validates the whole readiness snapshot. Every declared lane needs an explicit readiness value. A missing lane or failed probe reports a readiness error and prevents new lane admissions without interrupting already-assigned sessions. A readiness observation permits at most one launch per lane before the next 30-second refresh, allowing the worker to claim its task. Numerical counts are rejected. Lanes do not preallocate worker queues.

## Operations

```bash
pi-orchestrator status
pi-orchestrator run --prompt "..." --profile standard
pi-orchestrator wave review --count 3
pi-orchestrator abort RUN_ID
pi-orchestrator kill RUN_ID
pi-orchestrator pause
pi-orchestrator resume
pi-orchestrator boost openai-codex 3
pi-orchestrator account import openai-codex-3 --provider openai-codex --credential-file credential.json
pi-orchestrator account disable openai-codex-3
pi-orchestrator account enable openai-codex-3
```

`pi-orchestrator account use ID voice` excludes a Codex account from fleet admission, including forced and pinned runs, and interactive routing. `account use ID shared` returns it to the shared pool. PiStack Voice uses its own OpenAI API credential and session leases, not the Orchestrator's OAuth accounts or client APIs. See [Voice deployment](../../docs/deployment.md). The reservation lives in the ledger's `control` table under `account-use:ID` and appears as `use` in account listings. Existing runs are not killed by this command; stop them with `kill RUN_ID` after reserving the account. Interactive sessions move off a reserved account before their next turn.

Import reads credentials from a file so tokens do not enter process arguments. `account disable ID` takes an account out of fleet admission, interactive routing and meter sampling while keeping its credential and readings, which is what a lapsed subscription or a login awaiting replacement needs; `account enable ID` puts it back. A disabled account reports `disabled` in `status` capacity and produces no meter errors. `account remove` is the destructive path: it disables admission and deletes the credential while historical attribution remains intact. `account refresh ID` exchanges the account's refresh token for a new access token whatever the stored expiry claims, for the case where an operator already knows a credential is dead; the samplers and interactive routing do this on their own when a provider refuses one.

`account reserve ID --metadata JSON --reason TEXT` dedicates new account admission to completions with matching input metadata. It can precede account import. Ordinary forced work and interactive sessions cannot claim the reserved capacity, while already admitted workers continue. `account reservation ID` reads it; `account unreserve ID` releases it. [Capacity reservations](docs/account-reservations.md) owns metadata matching, the HTTP routes and incoming-transfer ordering.

`account transfer ID --to SSH_HOST` moves exclusive Codex ownership to another host, preserving account identity, quota observations and attribution. It disables source admission, reports active users that must drain, then reads current quota before handing off the credential. It leaves source capacity for ongoing work. [Account transfer](docs/account-transfer.md) owns preconditions, the SSH receiver, durable custody and restart recovery.

The daemon serves its public API on `127.0.0.1:2460` by default. Config `listenHost` or `PI_ORCHESTRATOR_LISTEN_HOST` changes only the bind address; worker and CLI connections retain `PI_ORCHESTRATOR_HOST`, which defaults to loopback. A private-network deployment can bind `0.0.0.0` behind its existing VPC ingress firewall, without a credentials proxy. The daemon API is a trusted-network API, not a public endpoint. Pi Remote consumes the package's observation API and does not query private tables.

## Tool-free completion API

Applications can submit durable Luna or Terra inference through [`CompletionClient` and the completion HTTP API](docs/completions.md). Caller system and user prompts remain separate. The existing daemon owns admission, cancellation, provider usage and idempotent result replay. Tool-free completions share one asynchronous executor without per-request processes or agent-session concurrency caps. Fresh quotas, exhaustion, cooldowns, reservations and pause still apply; completion leases remain visible for ownership and usage but do not occupy agent-session slots. Native strict JSON schema is supported; a supplied output-token cap returns HTTP 422 because the Codex endpoint rejects that parameter. [OpenAPI](docs/completions.openapi.json) is generated from the runtime TypeBox schemas.

## Application-owned workspaces

`POST /v1/run/isolated` requires the Pi core and `context: { tools: ["read", "write", "edit", "bash", "agent_browser"] }`. This selects an isolated context rather than the fleet's normal environment. The dedicated endpoint fails without launching anything on a host that has not deployed this feature. `/v1/run` also accepts the same context contract. It requires an explicit `cwd` and one run. An empty tool list creates a tool-free agent. Built-in names are declared in `src/domain.ts`. Applications can also supply `extensions: ["/absolute/path/to/tool.ts"]` and select their registered tool names in `tools`. The worker fails before prompting if any requested tool did not load. Other context fields are rejected. Application extensions execute as the fleet user, just like the application's bash tool; these paths are an explicit trusted-code input.

The daemon stores the contract atomically with the run in its `run-context:<id>` control record. Recovery uses the same contract. The worker creates its HOME, temporary files, XDG directories, and Pi configuration inside `cwd/.home`. Sessions remain in the run's durable core directory, outside the disposable workspace. Pi loads no discovered instructions, skills, templates, settings, or extensions. Only pooled authentication, usage accounting, output-limit continuation, and the extensions required by the requested tools load. Remote-thread identifiers and inherited credential environment variables are removed.

This is context isolation for trusted agents, not an OS security boundary. Bash still executes arbitrary code as the fleet user and can address files or services outside the workspace. The submitting application owns workspace creation, allowed reference files, result validation, accepted artifact storage, and cleanup after completion or failure. The orchestrator never deletes a caller-supplied `cwd`.

EverythingLIVE uses this API for its commercial author/review jobs. Each turn gets a fresh folder containing scene definitions, authoring helpers, brand references, and the preceding turn's draft. Its service exposes generation, inspection, and preview operations through the workspace CLI, accepts validated JSON and its media/components, and reclaims workspaces during normal operation and restart recovery.

## Meter authentication

Both provider samplers resolve and refresh credentials through the same `SharedOAuthAuth` lock as interactive and fleet sessions. An idle account does not need a model request to restore its meters. Failed refreshes preserve the credential and appear in `status.meterErrors` and the daemon journal; sampling recovery clears the error. Attempts remain spaced by the normal sampling interval.

Expiry is not the only way a token dies. A provider that rotates an account's auth session invalidates the tokens it issued, so a credential with days of nominal life left is answered `401` and expiry-driven refresh never touches it. A sampler that is refused refreshes the rejected token and repeats its poll, which returns the account to service within a sampling interval whether or not any session is on it; because the sampler names the token it wants replaced, concurrent repairs spend one rotation instead of racing. A 401 that survives a fresh token is reported as `request-failed` rather than refreshed again, and needs a new provider-issued login. See [provider meter notes](docs/provider-meter-notes.md) for the refresh incident and provider-specific collection rules.

## Usage evidence

`pi-orchestrator usage-evidence [--ledger FILE]` prints a transaction-consistent, read-only JSON snapshot of the last 24 hours of quota meters and hourly token totals. It includes account aliases, providers, voice reservations, and the catalog's weekly meter scopes. It excludes credentials, account labels, run ids, and transcript paths. It does not contact providers, initialize missing databases, or require the daemon to be running.

The same function is exported as `readUsageEvidence` from `pi-orchestrator/api`. [`pi-user-usage`](../../tools/user-usage/README.md) consumes the command to estimate a person's subscription-equivalent dollars from her recorded conversation usage. Token totals measure spending, not capacity; the paired provider meter readings supply the capacity estimate.

Generated command and table lists live in [docs/reference.md](docs/reference.md). A fresh ledger gets the current schema directly. A schema change ships as a bounded transition command that is deleted once both hosts have run it, so there is no migration chain to maintain.
