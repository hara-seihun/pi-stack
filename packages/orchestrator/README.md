# Pi Orchestrator

Pi Orchestrator runs persistent Pi threads against pooled subscription accounts. Fleet lanes, direct assignments and children use the same [ThreadService and API](../../docs/threads.md). Shared runners execute many sessions without a process per thread.

## Ordinary users

[Ordinary Unix users](docs/ordinary-users.md) use separate local state and a model-only broker. The host binds each broker listener to a Unix UID through packet filtering and explicitly grants account aliases. Ordinary users never receive owner OAuth credentials, owner ledger access or fleet API access. The same native providers supply chat, compaction and image generation.

The [personal watch list](../../docs/watch-list.md) is maintained through tools shared by Remote and Orchestrator agents. Its scheduler and encrypted state belong to the person's Remote supervisor, not a fleet lane or recurring schedule.

## Runtime model

The daemon reconciles provider meters, weighted lanes and optional readiness probes. A lane has a positive weight, not a worker target. An optional `maxActive` bounds its outstanding work. Eligible lanes spawn threads through the ordinary API. A wave is a one-off batch. [Recurring jobs](docs/schedules.md) start fresh threads on durable fixed intervals without cron or another runtime.

`threads.sqlite3` beside the account ledger owns thread identities, pending input, executions, recurring schedules and result delivery. Native Pi JSONL files own conversation history. Account policy holds a `thread:<executionId>` activity lease until local execution settles. An idle parent releases its lease even when children continue. [`thread_wait` and `thread_wake`](../../docs/threads.md#durable-dependency-waits-and-own-thread-wakes) persist dependency status and periodic recovery checks for the caller's own existing conversation, using ThreadService reconciliation and ordinary input receipts rather than a polling model or the personal watch list.

Children use ordinary thread messages and forced admission. There is no external fleet coordinator, waiting run, receipt endpoint or worker restart lifecycle. The daemon detaches from shared runners on shutdown; ThreadService recovers durable execution when it reconnects. Cutover imports existing fleet records before starting the service and must refuse active source custody rather than replay it.

## Pooled credentials and admission

OpenAI and Anthropic are served entirely from the shared account pool. No one on the machine holds a personal subscription or an API key, so the extension registers the `openai-codex` and `anthropic` family ids with pool-only auth: the model catalog stays intact, but the upstream ambient routes — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and any credential left in a person's `~/.pi/agent/auth.json` — cannot authenticate a request. Traffic reaches a provider only through a numbered pooled alias, or through the model broker for ordinary Unix users. A session that never bound an account says so instead of reporting a missing API key, and a session model request that no pooled account can serve fails at startup rather than part-way through a turn.

A cooldown orders initial interactive account selection; it does not ban an account. When every usable account is cooling, admission can probe the one nearest to expiry because an inferred hold may cover more models than the provider refused. Fresh exhausted binding meters are different: selection excludes those accounts even when probing cooling siblings. Interactive readings are fresh for 90 minutes and cease to bind once their reported reset passes; missing readings permit a provider probe rather than claiming quota. Opus ignores Fable's separate meter. Rate-limit failover excludes every account refused since the last provider answer, preserving the model, thinking and speed. No account is requested twice in that round, including through native Pi auto-retry; an internal round guard preserves the original provider refusal and cannot shorten its cooldown. Cooldown length follows what the provider named — a day for a monthly ceiling, six hours for a weekly window, ten minutes for an exhausted allowance, and one minute for a 429 that named nothing, which is ordinary burst throttling.

A provider answer ends a cooldown early for every consumer. The fleet, interactive and assigned sessions, provider operations, the model broker, completions and image generation all share the ledger's hold, and each reports an answered request through `Store.recordProviderSuccess`. Fleet admission still refuses cooling accounts, so these answers usually come from interactive sessions or the broker probing the account nearest expiry. Each hold keeps evidence in `control` row `cooldown-evidence:ACCOUNT`: its expiry, the latest refusal time and the models refused while it stood. A success lifts the hold only when its request started after that refusal, and when the served model drains every catalog meter the refused models drain. For example, Fable covers Opus, but Opus does not cover Fable's separate weekly allowance; image models only cover themselves. The lift compares and swaps the expiry, so a concurrent refusal survives, and records the success in `cooldown-recovery:ACCOUNT`. Meters never lift a hold, because a low five-hour or weekly meter says nothing about a monthly spend ceiling, and nothing probes a cooling account on a timer. Holds written without evidence, whether from before this rule or by a process running an older release, are dated when the ledger is next opened, so only later requests can lift them. On September 29, 2026, every Anthropic account was cooling for a day after monthly spend refusals. An interactive Opus request then succeeded on `anthropic` at 14:56 UTC, while fleet workers stayed refused until an administrator cleared the hold.

[Live Codex tier capabilities](docs/codex-capabilities.md) gate Ultrafast selection and pinned requests against the account's current advertised model catalog, independently of plan labels. Status exposes sanitized observations; `pi-orchestrator account capabilities [ID]` refreshes them through the account-owning daemon without inference.

## Quota policy

For explicit background admission at 1×, work stays within the elapsed share of each provider window's allowance, including the configured reserve. A whole-percentage-point tolerance accounts for provider rounding. Every binding meter must be fresh. A flat pair of readings cannot erase earlier overspending.

The account concurrency ceiling also uses up to six hours of same-window consumption divided by recorded session-hours, with one percentage point added for meter uncertainty. Meter history is retained for 24 hours rather than a fixed sample count. At least 15 minutes of evidence is required to move beyond one calibration session. While spend remains within calendar pace, the ceiling keeps one discrete admission even when the measured rate cannot sustain one continuously; the next meter observation and calendar gate decide whether a successor may start. Fleet, interactive, and voice leases count toward background account and machine pacing ceilings. At 1×, new work consumes at most one admission per meter observation.

Account concurrency (`defaultAccountConcurrency`, or an account override) and the machine session ceiling (`maxConcurrentSessions`) govern only background pacing. Forced and live admission have neither ceiling. A new thread chooses the least-loaded eligible account first, then the least spent. A returning thread retains its last admissible account for the same provider and model before load balancing: Anthropic thinking and prompt caches are account-bound, so moving a large conversation to a less busy sibling rewrites its cached history. The ledger's `thread-account-affinity:[threadId,provider,model]` control row records the choice, beginning with its first admission on this release, and survives idle runtime and daemon retirement. Explicit account pins and every eligibility, capacity, pause and provider-exhaustion check precede affinity; an unavailable account yields to a replacement, which becomes the new affinity. Other profiles and completions keep their existing routing policy. Idle threads do not reserve capacity. ThreadService preserves accepted model, thinking and speed settings during recovery. The account policy still enforces pauses, account availability, reservations, cooldowns and actual provider exhaustion.

Forced admission is the default for direct work, children and lanes. It bypasses background pacing, reserves, meter freshness, observation throttling and provider multipliers, including 0×. Select `admission: "background"` explicitly for paced spending. Status reports each lane's admission policy, thinking level and active thread count.

Live admission belongs to live consulting: a thread whose `metadata.mode` is `live` ([thread modes](src/threads/modes.ts)) and every worker it spawns. People are waiting on those threads, so they are admitted without background machine or account session ceilings, as forced work is; emergency halt, ordinary-work pause, disabled or reserved accounts, cooldowns and exhausted quota still refuse both classes. Clients cannot request `live` directly; it comes only from the mode, which a child inherits and cannot change. `pi-orchestrator run --mode live` starts such a conversation outside a meeting.

Provider boosts multiply the calculated session ceiling directly, after the base account ceiling and consumption estimate. A base capacity of 2 becomes 20 at 10×, not 4 because of an unscaled account cap. Boosts above 1 bypass calendar pacing and the one-admission-per-observation gate, so the scheduler fills the boosted capacity immediately. They do not raise the quota allowance. Fresh meters, provider exhaustion, cooldowns, reservations, the background reserve and the machine ceiling still apply. A multiplier of zero halts new background launches for that provider, not forced runs. Ten times the sustainable rate aims to spend a week's allowance in about 16.8 hours; rounding, changing measured consumption and other binding windows affect the actual duration.

The routing extension uses the same account registry for interactive Pi sessions. It keeps a session on one account unless that account fails. Interactive capacity leases are activity-scoped: loading a session, retaining an idle child, or selecting a model while idle does not reserve a slot. Agent work holds its lease through tools, automatic retries and queued continuations until `agent_settled`; manual compaction holds a lease until success, failure or cancellation. The selected account remains in session history after the lease ends. A model switch during a turn leaves the in-flight account charged until that turn ends, then moves the reservation to the selected account. Fleet leases remain scheduler-owned. Account failover and credential repair append their continuation at Pi's `agent_before_settle` boundary. A successful answer clears the pending recovery continuation. When the account round is exhausted, ThreadService retains the accepted execution and work IDs with `metadata.providerWait` and `metadata.admissionWait`, retires the native runtime and releases its lease. This is running work waiting for capacity, not a failed or successful thread settlement; parents receive no `thread_idle` notification. Reconciliation reads reset/cooldown evidence without inference, re-admits the same accepted settings and resumes the failed native input exactly once without replaying its user message or completed actions. Assigned Fleet executions use the same waiting path rather than repeatedly requesting their refused account. Banked resets or a qualifying provider success can reopen capacity before the predicted `retryAt`. Broker-only clients use a durable limit-class retry schedule because they do not own account evidence. Stop cancels the retained execution and waiting state. Plain Pi without ThreadService ends the bounded round and requires another input to retry. Transient failures that are not account capacity take the same waiting path: a fenced compaction (`Native compaction failed`, `Auto-compaction failed`, or a named compaction retry time) and dropped transports (`fetch failed`, resets, closed WebSockets, 5xx). They resume no earlier than `retryAt`: the failure's own named retry time, or a backoff that doubles per consecutive failure of the same execution from 30 seconds to a 30-minute cap (`metadata.providerWait.attempts`, carried across resumes as `metadata.providerRetry`). Nothing in this path waits for a manual retry, so a transient failure always runs again.

Cold `get_state` on an idle or provider-waiting thread reads the thread owner's state without opening or admitting a model session. It identifies `source: thread-owner`, reports native streaming as false and durable `threadState`, pending work and provider wait separately. Live native runtimes still supply native observations.

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

The JSON config may set `modelBrokerUrl`, account-transfer `peers`, model `profiles`, `backgroundSpendFraction`, background machine and account concurrency pacing, meter age, reconciliation periods, stall limits, `taskManifest`, `authPath`, and `agentDir`. The strict `astra`, `sol`, `luna`, and `opus` profiles are always available alongside configured profiles. Each selects exactly one catalog model, even if a local profile uses the same name.

The [shared catalog](src/catalog.ts) maps Astra, Sol, and Luna to `openai-codex/gpt-6-astra`, `gpt-6.1-sol`, and `gpt-6-luna`. Explicit Sol 6 selections remain on `gpt-6-sol`. Sol 6.1 is defined in [custom model definitions](src/models.json) until the bundled catalog includes it; its limits and price use the Sol 6 entry pending provider metadata. All three share the Codex five-hour and weekly meters. `opus` selects `anthropic/claude-opus-5-5` for interactive main conversations. The [custom model definitions](src/models.json) add Opus 5.5 to the runtime and deployed account catalogues. Each definition carries its icon so a supervisor on a previous release can still load the account catalogue during handoff or rollback; the shared catalogue reads those same icons. Explicit Opus 5 selections remain on Opus 5. [Anthropic's Opus 5.5 specification](https://platform.claude.com/docs/en/models/opus-5-5/overview) supplies its 1M context, 128K output limit and pricing. Thinking is always on, and [per-turn effort](https://platform.claude.com/docs/en/build-with-claude/effort) preserves the cached prefix when the level changes. Every new Orchestrator agent and completion admission defaults to `high`, except catalog Luna defaults to `max`. This includes repair lanes, direct runs, waves and custom profiles. Thread settings and completion requests accept explicit thinking and speed overrides. Standard speed is the default. A lane that declares `thinkingLevel` replaces that default for its own workers; `threads/contracts.ts` owns the level names every consumer validates against.

`SUBAGENT_MODEL_DESCRIPTIONS`, exported through `pi-orchestrator/api`, contains Hara's Sol and Luna engineering-level descriptions and her classification/inference exception, supplied on September 11, 2026. New subagents default to Sol even when their parent uses Anthropic. A child may explicitly choose Opus; the thread owner rejects Astra and Fable child models, including provider-qualified model names. Main conversations can still explicitly use Anthropic.

Model availability does not assign a model to a lane. Autonomous coordinator selection belongs to the submitting application or host lane manifest, which can name `astra` or `sol`. Subagents can select Sol, Opus, Luna or other installed models outside Astra and Fable. Without configured profiles, both `standard` and `expert` select Sol 6.1; Astra remains explicitly selectable through `astra`, and the strict `opus` profile and configured profiles may name Anthropic candidates for direct runs, lanes and completions. Interactive main conversations retain explicit Anthropic selection and shared account access.

Profile candidates declare provider and model in preference order. Lane admission selects a candidate, then the central thread settings resolver chooses its defaults. Each execution retains its accepted settings during recovery. Configuration changes require a daemon restart.

A lane manifest has `version: 2` and a `lanes` array. Every lane declares `id`, `prompt`, `cwd`, `profile`, and positive `weight`. Unknown fields are rejected, including worker targets. Optional `maxActive` is a positive safe integer: a ceiling, not a desired worker count.

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

The manifest defaults to forced admission. Its optional `budget` selects the manifest default, and each lane can override it with `admission: "background"` or `"force"`. Readiness is independent of quota policy. Each reconciliation admits at most one forced worker per ready lane; background lanes fill their paced capacity. A lane without `maxActive` retains this unbounded forced behavior. When declared, `maxActive` additionally caps both policies and explicit lane waves. For example, `"maxActive": 1` keeps one outstanding worker per lane even if a readiness probe repeats stale `ready: true` while its first worker awaits model capacity or task checkout. Without `snapshotCommand`, lanes remain eligible. A snapshot reports whether each queue has unclaimed work, never how many threads to run:

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

`maxActive` counts distinct threads with the lane ID that retain runnable queued/dispatched input, an unended execution, running state or a native runner reference. Stop, archive and a failed cancellation do not release capacity until native cancellation is confirmed. An idle, held thread's preserved queue does not reserve a producer slot or restart through manifest reconciliation. The ceiling controls daemon lane creation, not explicit continuation of stopped historical threads. A completed bounded-lane assignment unloads its idle native session before releasing native custody; retaining a warm cache here would consume the lane's slot indefinitely. This applies only with no pending input, active execution, native command, dependency wait or wake schedule, and excludes live-mode threads. Ordinary interactive and uncapped sessions remain warm. Disposal must succeed before the runner reference is removed; pending or failed disposal and unknown retained references still count. Native files, accepted receipts and thread identity survive unloading. No readiness refresh or daemon restart resets live custody. Lowering the limit leaves existing workers intact and blocks new admissions until custody falls below it; increasing or removing the limit permits later admissions under the usual readiness/quota gates. Manifest reconciliation persists these changes. Status exposes `maxActive` and `custody` beside the existing running `active` count. Wave and readiness creation serialize the final capacity check with durable spawn; the count is checked again after an asynchronous opening probe.

Scheduler capacity, lane shares and repair exclusivity read one indexed running-thread summary per admission iteration. Lane ceilings read indexed live custody, never historical projections. They never project historical threads inside a lane sort comparator. Reconciliation starts from the partial running, active-execution and unfinished-work indexes, including retained executions and unheld queued input even when their stored thread state is idle; held queued input stays held. Full status/history observations retain every thread, with indexed creation order for snapshots and paginated thread listing. `tests/thread-scheduling.test.ts` checks these plans against 20,000 historical threads and preserves pending input, retained execution and native history. `tests/lane-retirement.test.ts` exercises two twenty-lane cycles with delayed/failed native disposal and conservative unknown/queued/held custody. `tests/lane-retirement-native.test.ts` uses real Pi with a synthetic provider/transport identity to prove natural settlement/disposal, second-cycle admission and cold continuation of the original native history without replaying accepted input. These offline fixtures are not deployed producer-output evidence.

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

## Focused model checks

Vitest's [test setup](tests/setup.ts) gives each test file a temporary home and removes inherited Orchestrator, broker and agent-directory settings. Default config, ledger and shared OAuth paths therefore belong to fixtures, never the running host; individual tests can still set explicit environment overrides. This also prevents a quarantined production credential from refusing a synthetic admission. Temporary homes are removed when each file finishes.

Run `npm test --workspace=pi-orchestrator -- tests/catalog-config.test.ts tests/routing-runtime.test.ts` to check model selection and routing. The source-owned [check graph](scripts/check.mjs) first builds Kenan memory, then checks all Orchestrator source, tests and Vitest configuration, then prepares the shared RPC runtime, and only then admits the selected Vitest suite. A focused file filter narrows runtime execution, never the type contract. These prerequisites live in the `test` command itself, not `pretest`: `npm --ignore-scripts test` cannot skip them. A failed prerequisite produces blocked runtime outcomes rather than a transpile-only success. Publication imports the same graph and shares one prerequisite chain across its seven bounded suites; it does not invoke seven nested npm lifecycles. Provider assertions use `nativeProviders`, which includes the custom definitions, rather than the upstream catalog alone. Fresh-session fixtures load the same `models.json` definitions deployed to each account before selecting a model; pin and model-switch cases resolve current choices through `catalogModel` instead of constructing versioned IDs. Explicit historical model IDs in resume fixtures remain intentional.

## Nebulani agent names

`pi-orchestrator names --count 10` generates names locally without model calls,
creating agents or changing existing names. `getRandomName` is also exported from
`pi-orchestrator/api`. Names are labels, not reserved identities; UUIDs remain the
identity authority. Automatic assignment and UI display are not enabled by this command.

[`src/nebulani-names.ts`](src/nebulani-names.ts) is imported unchanged from Hara's
Lemma Dev generator (`src/nebulani-names.ts`, source commit
`a106f9555dd2fc6eb76aa5967a0fcb4f5596df43`). Given names combine three or four
semantic primes; family names combine three with plural `-n`. It retains Lemma
Dev's junction checks, repeated-onset repair, romanization and sampling weights.

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

The shared meter ledger applies later writes at the same account, meter and millisecond as corrections, including the reset time. Equal-timestamp polls must not silently retain an exhausted reading after quota recovery; distinct observation times retain their history and older readings do not displace the latest.

Both provider samplers resolve and refresh credentials through the same `SharedOAuthAuth` lock as interactive and fleet sessions. An idle account does not need a model request to restore its meters. Failed refreshes preserve the credential and appear in `status.meterErrors` and the daemon journal; sampling recovery clears the error. Attempts remain spaced by the normal sampling interval.

Expiry is not the only way a token dies. A provider that rotates an account's auth session invalidates the tokens it issued, so a credential with days of nominal life left is answered `401` and expiry-driven refresh never touches it. A sampler that is refused refreshes the rejected token and repeats its poll, which returns the account to service within a sampling interval whether or not any session is on it; because the sampler names the token it wants replaced, concurrent repairs spend one rotation instead of racing. A rejection that survives a fresh token is reported as `request-failed` and durably excluded from new admissions rather than refreshed again. The fixed Codex usage endpoint also reports rejected credentials as 404. Interactive Codex `Not Found` failures require corroboration from that usage endpoint before refreshing. See [provider meter notes](docs/provider-meter-notes.md#codex-credential-rejection-reported-as-404) for the September 15 incident, repair limits and diagnostics, and [credential rejection recovery](docs/provider-meter-notes.md#credential-rejection-recovery) for the September 29 invalidated-token incident and durable recovery state.

Set `PI_CODEX_AUTO_RESET=1` on the fleet daemon to automatically redeem one available banked Codex reset when an enabled account's raw weekly usage reaches 100%. The ordinary five-minute sampler owns this policy; five-hour-only exhaustion and rounded-up 99.x% readings do not spend resets. It picks the oldest unexpired credit. Automatic redemption is off unless the host explicitly opts in.

The durable `codex-reset-attempt:<accountId>` control row reserves a credit and request identity before POST, shared with the manual `codex-reset` command. Concurrent samplers, manual commands, daemon restarts and stale post-reset usage cannot spend a second credit for the same exhausted window. A successful POST remains pending until a later provider reading shows weekly usage below 100%; only then is the account's cooldown cleared. An ambiguous or rejected POST is not retried automatically and appears in `meterErrors`; the attempt stays fenced until provider quota recovery. Inspect the control row and provider evidence before any manual repair. Do not delete an unresolved attempt merely to retry a POST. Confirmation and the next ordinary reading restore scheduling without replaying completed thread work.

Codex sampling also reads available banked rate-limit resets on every pass. The ledger keeps only the latest reading in the `control` row `reset-credits:<accountId>`. If the provider refuses the balance request, the sampler keeps the last known value and does not raise a meter error. The plan read model exposes the balance as `bankedResets` on account rows. Anthropic balances are collected read-only from authenticated Claude Kernel profiles by [`claude-reset`](../../tools/claude-reset/README.md), which verifies account identity and keeps the last known reading on failure.

## Usage evidence

`personUsage(store, since, until)` and `OrchestratorClient.personUsage(windowMs)` attribute a ledger's hourly usage to people. Broker leases are named `broker:<principal>:<id>`, and a broker completion's principal is in its `completion:<request>` access record; every other row is the ledger owner's own interactive, fleet or completion spending and has a null principal. Each person gets tokens, list-price value from the pooled providers' model catalog (including retired models), and `spend`: dollars of subscription actually used. Routing and accounting share [`modelsWithCustomDefinitions`](src/models.ts): each provider's custom definitions override matching builtin IDs, and accounting retains retired builtin models even when routing excludes them. Sol 6.1 uses the explicit inherited Sol 6 prices in `models.json` pending provider metadata; it is not an unknown zero-priced model. Genuinely unknown models remain counted in `unpricedTokens`. `calibrateRate` derives each provider's rate from its accounts' latest weekly meter (the catalog plan's `quotaMeter`): consumed points × 1% of a week of `monthlyUsd`, over the list-price value those accounts served since each window began, leaving out accounts this ledger did not use or whose window contains positive token use with unknown prices. An account's whole weekly meter must not calibrate against only its priced fraction. `hourlyRates` freezes that rate per provider-hour in the `usage_rate` table the first time an hour is priced, so later meter readings do not reprice past hours. Model-price registry corrections can change historical list-price values and their reported frozen-rate equivalents; they do not modify `usage_hour` evidence or existing positive `usage_rate` rows. In particular, adding the omitted custom Sol 6.1 price does not retroactively recalibrate rates frozen with the incomplete registry; those historical equivalents are not corrected direct-meter measurements. A fresh weekly meter rounded to 0% is not a calibration: the last positive provider rate carries forward across its reset. Opening a ledger repairs previously frozen zero-rate hours with that positive rate, or clears them if the provider has never had a calibration. Without any calibration a provider's usage is unpriced. Figures are also split by source and by provider. Pi Remote's administrator People card consumes it. `personalUsage(store, principal)` gives one person's per-plan figures today and this week, the week running from Monday 00:00 host time (`weekStart`, `weekResetsAt`). Each broker listener serves `GET /v1/usage` ([`broker-usage.ts`](src/broker-usage.ts)): plan meters restricted to that principal's granted accounts with labels replaced by aliases, and her own `personalUsage`. `readBrokerUsage(url)` is the client. A listener may set `weeklyUsd` in the grant file: the most that principal may use, in the same dollars, from Monday 00:00 host time to the next. At or above it the broker refuses new model requests and new completions with HTTP 403 and names when the week resets, before choosing an account; requests already running finish. Admission rereads her spend at most every 30 seconds, so a burst can overshoot by what it spends in that time. `GET /v1/usage` reports `allowance: { weeklyUsd, usedUsd, resetsAt }`, or null without a limit. Grant-file reloads change the limit without a restart.

`pi-orchestrator usage-evidence [--ledger FILE]` prints a transaction-consistent, read-only JSON snapshot of the last 24 hours of quota meters and hourly token totals. It includes account aliases, providers, voice reservations, and the catalog's weekly meter scopes. It excludes credentials, account labels, run ids, and transcript paths. It does not contact providers, initialize missing databases, or require the daemon to be running.

The same function is exported as `readUsageEvidence` from `pi-orchestrator/api`. [`pi-user-usage`](../../tools/user-usage/README.md) consumes the command to estimate a person's subscription-equivalent dollars from her recorded conversation usage. Token totals measure spending, not capacity; the paired provider meter readings supply the capacity estimate.

Generated command and table lists live in [docs/reference.md](docs/reference.md). A fresh ledger gets the current schema directly. A schema change ships as a bounded transition command that is deleted once both hosts have run it, so there is no migration chain to maintain.
