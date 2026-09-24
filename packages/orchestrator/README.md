# Pi Orchestrator

Pi Orchestrator runs persistent Pi threads against pooled subscription accounts. Fleet lanes, direct assignments and children use the same [ThreadService and API](../../docs/threads.md). Shared runners execute many sessions without a process per thread.

## Ordinary users

[Ordinary Unix users](docs/ordinary-users.md) use separate local state and a model-only broker. The host binds each broker listener to a Unix UID through packet filtering and explicitly grants account aliases. Ordinary users never receive owner OAuth credentials, owner ledger access or fleet API access. The same native providers supply chat, compaction and image generation.

## Runtime model

The daemon reconciles provider meters, weighted lanes and optional readiness probes. A lane has a positive weight, not a worker target. Eligible lanes spawn threads through the ordinary API. A wave is a one-off batch. [Recurring jobs](docs/schedules.md) start fresh threads on durable fixed intervals without cron or another runtime.

`threads.sqlite3` beside the account ledger owns thread identities, pending input, executions, recurring schedules and result delivery. Native Pi JSONL files own conversation history. Account policy holds a `thread:<executionId>` activity lease until local execution settles. An idle parent releases its lease even when children continue.

Children use ordinary thread messages and forced admission. There is no external fleet coordinator, waiting run, receipt endpoint or worker restart lifecycle. The daemon detaches from shared runners on shutdown; ThreadService recovers durable execution when it reconnects. Cutover imports existing fleet records before starting the service and must refuse active source custody rather than replay it.

## Pooled credentials and admission

OpenAI and Anthropic are served entirely from the shared account pool. No one on the machine holds a personal subscription or an API key, so the extension registers the `openai-codex` and `anthropic` family ids with pool-only auth: the model catalog stays intact, but the upstream ambient routes — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and any credential left in a person's `~/.pi/agent/auth.json` — cannot authenticate a request. Traffic reaches a provider only through a numbered pooled alias, or through the model broker for ordinary Unix users. A session that never bound an account says so instead of reporting a missing API key, and a session model request that no pooled account can serve fails at startup rather than part-way through a turn.

A cooldown orders account selection; it does not ban an account. When every usable account is cooling, admission takes the one nearest to expiry and lets the provider decide, because a cooldown is inferred from an error message and applies to the whole account: one throttled wave otherwise covers the pool and leaves nobody able to open a thread. Rate-limit failover stays strict, so a turn that just lost an account still moves away from it. Cooldown length follows what the provider named — a day for a monthly ceiling, six hours for a weekly window, ten minutes for an exhausted allowance, and one minute for a 429 that named nothing, which is ordinary burst throttling.

## Quota policy

For explicit background admission at 1×, work stays within the elapsed share of each provider window's allowance, including the configured reserve. A whole-percentage-point tolerance accounts for provider rounding. Every binding meter must be fresh. A flat pair of readings cannot erase earlier overspending.

The account concurrency ceiling also uses up to six hours of same-window consumption divided by recorded session-hours, with one percentage point added for meter uncertainty. Meter history is retained for 24 hours rather than a fixed sample count. At least 15 minutes of evidence is required to move beyond one calibration session. While spend remains within calendar pace, the ceiling keeps one discrete admission even when the measured rate cannot sustain one continuously; the next meter observation and calendar gate decide whether a successor may start. Fleet, interactive, and voice leases share the account and machine ceilings. At 1×, new work consumes at most one admission per meter observation.

Account and machine ceilings govern admission. Idle threads do not reserve capacity. ThreadService preserves accepted model, thinking and speed settings during recovery. The account policy still enforces pauses, account availability, reservations, cooldowns and actual provider exhaustion.

Forced admission is the default for direct work, children and lanes. It bypasses background pacing, reserves, meter freshness, observation throttling and provider multipliers, including 0×. Select `admission: "background"` explicitly for paced spending. Status reports each lane's admission policy, thinking level and active thread count.

Provider boosts multiply the calculated session ceiling directly, after the base account ceiling and consumption estimate. A base capacity of 2 becomes 20 at 10×, not 4 because of an unscaled account cap. Boosts above 1 bypass calendar pacing and the one-admission-per-observation gate, so the scheduler fills the boosted capacity immediately. They do not raise the quota allowance. Fresh meters, provider exhaustion, cooldowns, reservations, the background reserve and the machine ceiling still apply. A multiplier of zero halts new background launches for that provider, not forced runs. Ten times the sustainable rate aims to spend a week's allowance in about 16.8 hours; rounding, changing measured consumption and other binding windows affect the actual duration.

The routing extension uses the same account registry for interactive Pi sessions. It keeps a session on one account unless that account fails. Interactive capacity leases are activity-scoped: loading a session, retaining an idle child, or selecting a model while idle does not reserve a slot. Agent work holds its lease through tools, automatic retries and queued continuations until `agent_settled`; manual compaction holds a lease until success, failure or cancellation. The selected account remains in session history after the lease ends. A model switch during a turn leaves the in-flight account charged until that turn ends, then moves the reservation to the selected account. Fleet leases remain scheduler-owned. Account failover and credential repair append their continuation at Pi's `agent_before_settle` boundary. The original prompt stays active through recovery and emits one final `agent_settled`; the settlement handler only releases the lease.

Tree summarization needs a separate lifecycle repair. Pi emits `session_tree` on success but has no terminal extension event for failure or cancellation, so routing does not acquire a lease from `session_before_tree`.

Recovery restores both the model and the thinking level from the active transcript branch only when the caller did not supply a model. Otherwise Pi's temporary non-reasoning startup model can turn a saved `high` into `off`, which Astra and Fable clamp to `minimal` on model restoration. ThreadService always supplies its accepted model and thinking level, so those current settings win over older model-change entries when a native session opens. Routing may replace the pooled account behind that model, but not the model or thinking selection. Plain Pi resume without an explicit model still restores both values from history. Account failover carries the current level to the replacement account. Defaults only initialize new sessions. On session shutdown it closes provider resources through the same external `pi-ai` module that supplied its providers. Pi's bundled CLI has a separate resource registry; relying on its cleanup alone leaves a completed Codex WebSocket alive until the five-minute idle timeout, keeping one-shot processes and their callers waiting. A response that reaches the provider's output-token limit is continued inside the same Pi run: the provider ended it with `stopReason=length`, so the agent did not choose to stop and the session must not settle there. This is separate from the removed fleet check-ins, which used to restart turns that agents had ended normally. The usage extension aggregates attribution hourly, one row per input, output, cache read, and cache write, and records provider meter headers. Keeping the components apart is what lets `plans()` report the share of prompt tokens a model read from cache over the last 24 hours.

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
PI_MODEL_BROKER_URL
```

Ordinary-user clients discover `modelBrokerUrl` in `~/.config/pi-orchestrator/config.json`; `PI_MODEL_BROKER_URL` overrides it. CLI and agent tools need no shell export. The public `modelBrokerUrl()` helper and image service use the same lookup.

The JSON config may set `modelBrokerUrl`, account-transfer `peers`, model `profiles`, `backgroundSpendFraction`, machine and account concurrency, meter age, reconciliation periods, stall limits, `taskManifest`, `authPath`, and `agentDir`. The strict `astra`, `sol`, and `luna` profiles are always available alongside configured profiles. Each selects exactly one catalog model, even if a local profile uses the same name. Scheduling profiles must contain only `openai-codex` candidates; the daemon rejects a config with another provider.

The [shared catalog](src/catalog.ts) maps Astra, Sol, and Luna to `openai-codex/gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna`. All three share the Codex five-hour and weekly meters. `opus` selects `anthropic/claude-opus-5-5` for interactive main conversations. The [custom model definitions](src/models.json) add Opus 5.5 to the runtime and deployed account catalogues. Each definition carries its icon so a supervisor on a previous release can still load the account catalogue during handoff or rollback; the shared catalogue reads those same icons. Explicit Opus 5 selections remain on Opus 5. [Anthropic's Opus 5.5 specification](https://platform.claude.com/docs/en/models/opus-5-5/overview) supplies its 1M context, 128K output limit and pricing. Thinking is always on, and [per-turn effort](https://platform.claude.com/docs/en/build-with-claude/effort) preserves the cached prefix when the level changes. Every new Orchestrator agent and completion admission defaults to `high`, except catalog Luna defaults to `max`. This includes repair lanes, direct runs, waves and custom profiles. Thread settings and completion requests accept explicit thinking and speed overrides. Standard speed is the default. A lane that declares `thinkingLevel` replaces that default for its own workers; `threads/contracts.ts` owns the level names every consumer validates against.

`SUBAGENT_MODEL_DESCRIPTIONS`, exported through `pi-orchestrator/api`, contains Hara's Sol and Luna engineering-level descriptions and her classification/inference exception, supplied on September 11, 2026. New subagents default to Sol even when their parent uses Anthropic. The thread owner rejects non-OpenAI child models and Astra, including provider-qualified model names. Main conversations can still explicitly use Anthropic.

Model availability does not assign a model to a lane. Autonomous coordinator selection belongs to the submitting application or host lane manifest, which can name `astra` or `sol`. Subagents can select Sol, Luna or other installed OpenAI Codex models outside Astra. Without configured profiles, `standard` tries Astra then Sol and `expert` selects Astra. Direct runs, lanes and completions refuse non-OpenAI models even when a caller supplies a model, an in-memory config contains a non-OpenAI candidate, or a persisted completion carries a pinned provider. Interactive main conversations retain explicit Anthropic selection and shared account access.

Profile candidates declare provider and model in preference order. Lane admission selects a candidate, then the central thread settings resolver chooses its defaults. Each execution retains its accepted settings during recovery. Configuration changes require a daemon restart.

A lane manifest has `version: 2` and a `lanes` array. Every lane declares `id`, `prompt`, `cwd`, `profile`, and positive `weight`. Unknown fields are rejected, including worker targets.

A lane may declare `thinkingLevel`, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The daemon stores it with the rest of the lane and applies it to every worker that lane starts, so a successor admitted an hour later and a worker admitted after a daemon restart both hold it. A lane without the field keeps the model's own default, and an explicit `settings` in a wave request still wins over the lane for that batch:

```json
{
  "id": "bonsai-halo",
  "prompt": "Improve the Halo kernels",
  "cwd": "/home/alex/projects/bonsai",
  "profile": "sol",
  "weight": 1,
  "thinkingLevel": "max"
}
```

The manifest defaults to forced admission. Its optional `budget` selects the manifest default, and each lane can override it with `admission: "background"` or `"force"`. Readiness is independent of quota policy. Without `snapshotCommand`, lanes remain eligible. A snapshot reports whether each queue has unclaimed work, never how many threads to run:

```json
{
  "revision": "business-state-version",
  "lanes": {
    "review": { "ready": true },
    "publication": { "ready": false }
  }
}
```

A lane whose task must not be worked twice decides that from the same threads the daemon counts. `GET /v1/status` carries `threads`; each one has `cwd`, `state`, `held`, `pendingMessages` and `metadata.laneId`. A thread owns its lane's work while `state` is `running`, which already covers queued input, admission, startup, execution and cancellation, and while it is held with queued messages, because those run the moment somebody resumes it. `ThreadState` is exactly `idle | running`, so a probe that finds anything else is reading a payload it does not understand and should raise rather than report ready: the daemon then records the readiness error and admits nobody, which is the safe answer. Each lane's probe belongs with the project whose work it claims.

The daemon validates the whole readiness snapshot. Every ordinary lane needs an explicit readiness value. A missing lane or failed probe reports a readiness error and prevents new ordinary lane admissions without interrupting already-assigned sessions. A readiness observation permits at most one launch per lane before the next 30-second refresh, allowing the worker to claim its task. Numerical counts are rejected. Lanes do not preallocate worker queues.

## Root repair lanes

A repair lane declares its own probe. It does not depend on the ordinary manifest's `snapshotCommand`, checkout admission, or readiness result:

```json
{
  "id": "host-repair",
  "promptFile": "/usr/local/share/host-repair/prompt.md",
  "cwd": "/home/alex",
  "profile": "astra",
  "weight": 1,
  "repair": {
    "readinessCommand": "sudo -n /usr/local/sbin/host-repair probe"
  }
}
```

The command runs as the daemon owner and prints exactly `{ "revision": "host-state-version", "ready": true }`. Use explicit sudo in the command when the probe needs root. Each repair probe refreshes every 30 seconds, fails closed independently, and permits at most one admission per observation. Ordinary snapshots need not mention repair lanes. A repair-only manifest does not need `snapshotCommand`, even with `budget: "force"`.

Repair threads retain forced admission and full Pi context. Fleet admission holds one repair owner and rejects isolated application contexts. Recovery requires the execution's recorded account lease, even when launches are paused. The shared runner launches under UID0 in a system scope for this execution boundary. Its sockets and native session files retain the controller account's custody. It does not substitute an ordinary user's UID or share an application-isolated runner.

`pause --ordinary` sets `ordinary-launches=paused`; `resume --ordinary` clears it. The global `launches=paused` control stops all new admission. Neither control cancels an admitted turn. Thread stop and resume use the same API as Remote and agent tools.

## Operations

```bash
pi-orchestrator status
pi-orchestrator run --prompt "..." --model astra
pi-orchestrator schedule create --prompt "..." --cwd /home/person/work --every 1h --model sol
pi-orchestrator wave review --count 3
pi-orchestrator stop THREAD_ID
pi-orchestrator pause
pi-orchestrator resume
pi-orchestrator pause --ordinary
pi-orchestrator resume --ordinary
pi-orchestrator boost openai-codex 3
pi-orchestrator account import openai-codex-3 --provider openai-codex --credential-file credential.json
pi-orchestrator account disable openai-codex-3
pi-orchestrator account enable openai-codex-3
```

`pi-orchestrator account use ID voice` excludes a Codex account from fleet admission, including forced and pinned runs, and interactive routing. `account use ID shared` returns it to the shared pool. PiStack Voice uses its own OpenAI API credential and session leases, not the Orchestrator's OAuth accounts or client APIs. See [Voice deployment](../../docs/deployment.md). The reservation lives in the ledger's `control` table under `account-use:ID` and appears as `use` in account listings. Existing runs are not killed by this command; stop their threads after reserving the account. Interactive sessions move off a reserved account before their next turn.

Import reads credentials from a file so tokens do not enter process arguments. `account disable ID` takes an account out of fleet admission, interactive routing and meter sampling while keeping its credential and readings, which is what a lapsed subscription or a login awaiting replacement needs; `account enable ID` puts it back. A disabled account reports `disabled` in `status` capacity and produces no meter errors. `account remove` is the destructive path: it disables admission and deletes the credential while historical attribution remains intact. `account refresh ID` exchanges the account's refresh token for a new access token whatever the stored expiry claims, for the case where an operator already knows a credential is dead; the samplers and interactive routing do this on their own when a provider refuses one.

`account reserve ID --metadata JSON --reason TEXT` dedicates new account admission to completions with matching input metadata. It can precede account import. Ordinary forced work and interactive sessions cannot claim the reserved capacity, while already admitted workers continue. `account reservation ID` reads it; `account unreserve ID` releases it. [Capacity reservations](docs/account-reservations.md) owns metadata matching, the HTTP routes and incoming-transfer ordering.

`account transfer ID --to PEER` moves exclusive Codex ownership from the current host. `account fetch ID --from PEER` moves it to the current host and opens a process-scoped reverse SSH forward when the source cannot dial back. Both commands accept `--wait-for-drain [DURATION]`. They preserve account identity, quota observations and attribution. [Account transfer](docs/account-transfer.md) owns peer configuration, preconditions, the SSH receiver, durable custody and restart recovery.

The daemon serves its public API on `127.0.0.1:2460` by default. Config `listenHost` or `PI_ORCHESTRATOR_LISTEN_HOST` changes only the bind address; worker and CLI connections retain `PI_ORCHESTRATOR_HOST`, which defaults to loopback. A private-network deployment can bind `0.0.0.0` behind its existing VPC ingress firewall, without a credentials proxy. The daemon API is an administrator API, not a public or ordinary-user endpoint. Loopback does not isolate Unix users; hosts with ordinary users must restrict it by UID as described in the [ordinary-user contract](docs/ordinary-users.md). Pi Remote consumes the package's observation API and does not query private tables.

## Tool-free completion API

Applications can submit durable Luna inference through [`CompletionClient` and the completion HTTP API](docs/completions.md). Caller system and user prompts remain separate. The existing daemon owns admission, cancellation, provider usage and idempotent result replay. Tool-free completions share one asynchronous executor without per-request processes or agent-session concurrency caps. Fresh quotas, exhaustion, cooldowns, reservations and pause still apply; completion leases remain visible for ownership and usage but do not occupy agent-session slots. Native strict JSON schema is supported; a supplied output-token cap returns HTTP 422 because the Codex endpoint rejects that parameter. [OpenAPI](docs/completions.openapi.json) is generated from the runtime TypeBox schemas.

## Application-owned workspaces

`POST /v1/threads/spawn` accepts an absolute `cwd` and `metadata.context: { tools: ["read", "write", "edit", "bash", "agent_browser"] }`. Applications can also supply absolute `extensions` paths and select their registered tool names. Unknown context fields or unloaded tools fail before prompting.

Each distinct workspace and context has a separate ThreadService under `applications/<boundary-id>` beside the ledger. Its native tools use `/v1/applications/<boundary-id>/threads`, so children remain in the same application service and retain its tool contract. The public thread directory can observe all services owned by this Unix person. The ledger's `thread-boundary:<id>` record retains the context needed to reopen the application service.

The runner creates HOME, temporary files, XDG directories and Pi configuration inside `cwd/.home`. Sessions stay outside the disposable workspace. Pi loads no discovered instructions, skills, templates, settings or extensions. Only the selected application resources and required account support load.

This is context isolation for trusted agents, not an OS security boundary. Bash still executes arbitrary code as the fleet user and can address files or services outside the workspace. The submitting application owns workspace creation, allowed reference files, result validation, accepted artifact storage, and cleanup after completion or failure. The orchestrator never deletes a caller-supplied `cwd`.

Applications such as EverythingLIVE submit author/review jobs through this thread API. Each turn gets a fresh folder containing scene definitions, authoring helpers, brand references, and the preceding turn's draft. Its service exposes generation, inspection, and preview operations through the workspace CLI, accepts validated JSON and its media/components, and reclaims workspaces during normal operation and restart recovery.

## Meter authentication

Both provider samplers resolve and refresh credentials through the same `SharedOAuthAuth` lock as interactive and fleet sessions. An idle account does not need a model request to restore its meters. Failed refreshes preserve the credential and appear in `status.meterErrors` and the daemon journal; sampling recovery clears the error. Attempts remain spaced by the normal sampling interval.

Expiry is not the only way a token dies. A provider that rotates an account's auth session invalidates the tokens it issued, so a credential with days of nominal life left is answered `401` and expiry-driven refresh never touches it. A sampler that is refused refreshes the rejected token and repeats its poll, which returns the account to service within a sampling interval whether or not any session is on it; because the sampler names the token it wants replaced, concurrent repairs spend one rotation instead of racing. A rejection that survives a fresh token is reported as `request-failed` rather than refreshed again. The fixed Codex usage endpoint also reports rejected credentials as 404. Interactive Codex `Not Found` failures require corroboration from that usage endpoint before refreshing. See [provider meter notes](docs/provider-meter-notes.md#codex-credential-rejection-reported-as-404) for the September 15 incident, repair limits and diagnostics.

Codex sampling also reads available banked rate-limit resets on every pass. The ledger keeps only the latest reading in the `control` row `reset-credits:<accountId>`. If the provider refuses the balance request, the sampler keeps the last known value and does not raise a meter error. The plan read model exposes the balance as `bankedResets` on account rows.

## Usage evidence

`personUsage(store, since, until)` and `OrchestratorClient.personUsage(windowMs)` attribute a ledger's hourly usage to people. Broker leases are named `broker:<principal>:<id>`, and a broker completion's principal is in its `completion:<request>` access record; every other row is the ledger owner's own interactive, fleet or completion spending and has a null principal. Each person gets tokens, list-price value from the pooled providers' model catalog (including retired models), and `spend`: her part of the window's subscription cost. That cost is every enabled account at its catalog plan's `monthlyUsd`, prorated over a 30-day month, and each provider gets one rate of subscription dollars per list-price dollar over a trailing window of at least seven days, so a person's spend is her value times that rate and shorter periods are parts of longer ones. Figures are also split by source and by provider. Pi Remote's administrator People card consumes it. `personalUsage(store, principal)` gives one person's per-plan figures for the last day and week. Each broker listener serves `GET /v1/usage` ([`broker-usage.ts`](src/broker-usage.ts)): plan meters restricted to that principal's granted accounts with labels replaced by aliases, and her own `personalUsage`. `readBrokerUsage(url)` is the client.

`pi-orchestrator usage-evidence [--ledger FILE]` prints a transaction-consistent, read-only JSON snapshot of the last 24 hours of quota meters and hourly token totals. It includes account aliases, providers, voice reservations, and the catalog's weekly meter scopes. It excludes credentials, account labels, run ids, and transcript paths. It does not contact providers, initialize missing databases, or require the daemon to be running.

The same function is exported as `readUsageEvidence` from `pi-orchestrator/api`. [`pi-user-usage`](../../tools/user-usage/README.md) consumes the command to estimate a person's subscription-equivalent dollars from her recorded conversation usage. Token totals measure spending, not capacity; the paired provider meter readings supply the capacity estimate.

Generated command and table lists live in [docs/reference.md](docs/reference.md). A fresh ledger gets the current schema directly. A schema change ships as a bounded transition command that is deleted once both hosts have run it, so there is no migration chain to maintain.
