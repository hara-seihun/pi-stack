# Ordinary Unix users

A Unix user with write access to the fleet ledger, config or OAuth pool is a fleet administrator. The HTTP fleet API also grants administrator access: it can launch arbitrary code as the daemon user and read run transcripts. Removing `sudo` does not change either boundary.

Each person can run a full Orchestrator daemon as their Unix account, with their own threads, lanes, [recurring schedules](schedules.md), controls and databases. Share model requests through the model broker, not through filesystem permissions on another person's state. Broker-backed admission needs no local subscription accounts or OAuth credentials and cannot launch root-repair work.

The host installs `pi-orchestrator@USER.service`, starts the person's lingering user manager for durable workers, and gives the daemon a unique loopback port. Both the CLI and Remote read that port from the person's config. Protect daemon ports with the same UID rules as broker ports. A daemon API can run arbitrary code as its owner, so every route belongs to that one Unix user. Root and the host administrator retain their existing administrative access.

The daemon's state lives under `~/.local/share/pi-orchestrator`; its service and worker processes use that person's UID. Jobs continue when the browser disconnects or the Remote folder is locked. They do not unlock encrypted folders. Schedule unattended work in an ordinary user-owned directory. Remote children using an encrypted folder retain the supervisor's private mount namespace and transcript custody, while the Orchestrator view also lists the person's independent daemon jobs.

`deploy/host` starts or restarts all enabled or running per-user daemons on release without ending their durable workers. Disable and stop a service to keep it inactive across deployment. Host configuration owns boot activation, UID filtering and config installation.

## Host contract

The host owns Unix accounts, filesystem permissions, services and packet filtering. Deploy all of these together:

- Run each person's Remote supervisor and agent processes as that person's Unix UID, with their own HOME and Pi configuration. Their tools inherit that UID.
- Remove administrator and shared-state groups. Protect owner homes, credentials, runtime sockets, ledger, config and person registry against those UIDs. Replace per-user links into owner state with ordinary user-owned files and directories.
- Restrict every route on the fleet daemon's TCP port to its administrator UID and explicitly authorized services. Read endpoints disclose owner transcripts too. Restrict any reverse proxy which can reach that API.
- Run `pi-orchestrator model-broker /etc/pi-model-broker.json` as the credential owner. This process needs the owner's ledger/auth access, but never starts agents or executes caller tools. Keep its environment and service definition owner-controlled.
- Install UID-based loopback packet filtering **before starting the broker**. Each configured broker port belongs to one Unix principal. Permit that UID and the administrator; reject other local UIDs and traffic arriving through forwarding or a network interface. Broker listeners bind only `127.0.0.1`.
- Keep grants root-owned and without group/other write access. The CLI refuses other grant files. An edited grant file is picked up within two seconds: the broker republishes each principal's accounts and models, and live routing, new submissions and already-queued completions all follow the new grant without cancelling active requests. Adding, removing or moving a listener is process topology; the broker logs that change and keeps serving its current ports until the service restarts.

The HTTP listener itself does not authenticate Unix peers. The host's UID filter is mandatory, not an optional extra. A loopback address alone is not isolation between local users. Do not put an unauthenticated proxy in front of a listener, or let an ordinary user run a proxy as an allowed UID.

Example grant file, with account aliases deliberately left for the owner to select:

```json
{
  "ledgerPath": "/var/lib/pi-orchestrator/ledger.sqlite3",
  "authPath": "/var/lib/pi-orchestrator/auth.json",
  "listeners": [
    {
      "principal": "sybil",
      "port": 2461,
      "accounts": ["OWNER_SELECTED_CODEX_ALIAS", "OWNER_SELECTED_ANTHROPIC_ALIAS"],
      "models": [
        "openai-codex/gpt-6-astra",
        "openai-codex/gpt-6-sol",
        "openai-codex/gpt-6-luna",
        "anthropic/claude-fable-5-1"
      ],
      "maxInFlight": 20
    },
    {
      "principal": "jodie",
      "port": 2462,
      "accounts": ["OWNER_SELECTED_CODEX_ALIAS", "OWNER_SELECTED_ANTHROPIC_ALIAS"],
      "models": [
        "openai-codex/gpt-6-astra",
        "openai-codex/gpt-6-sol",
        "openai-codex/gpt-6-luna",
        "anthropic/claude-fable-5-1"
      ],
      "maxInFlight": 20
    }
  ]
}
```

Granting an alias explicitly permits that person's requests to spend that account's provider quota. It does not transfer credential ownership. Both listeners may deliberately share an alias. Disabled, reserved or exhausted accounts remain unavailable. Cooldowns order foreground account selection but do not refuse a request when all granted accounts are cooling; the broker probes the nearest expiry and lets the provider decide. Per-listener request limits apply. Foreground broker requests, like the owner's interactive turns, do not wait for fleet agent-session slots. Those leases include local tool execution and are not a provider-request concurrency limit. Fleet background pause does not pause interactive model access. Leases cover provider requests, not time spent running local tools. The owner retains account metering and hourly usage attribution under `broker:PRINCIPAL:REQUEST_ID`; callers cannot choose those ledger keys.

Local request saturation or an unavailable granted pool returns HTTP 503 with the broker's explanation. HTTP 429 is reserved for upstream provider responses. Native Codex interprets every HTTP 429 as a ChatGPT usage-limit error, even when its body says otherwise. On September 15, 2026, a fleet burst filled four accounts' agent-session slots and caused two ordinary-user turns to fail before any provider request, despite available subscription quota. Removing that cross-workload admission gate and preserving local error messages repairs both causes. The listener still limits simultaneous requests and respects exhausted provider meters. A provider 429 keeps a longer existing cooldown rather than shortening it to the broker's one-minute throttle.

## Client contract

Set `modelBrokerUrl` in Sybil's existing `/home/sybil/.config/pi-orchestrator/config.json`:

```json
{
  "modelBrokerUrl": "http://127.0.0.1:2461",
  "port": 2471,
  "listenHost": "127.0.0.1"
}
```

Use Jodie's own config and distinct broker and daemon ports for Jodie. `PI_ORCHESTRATOR_PORT` overrides the daemon port. Broker-backed CLI control refuses a missing daemon port rather than sending requests to the administrator's default port. This is the client endpoint selection, not another grant registry. Plain CLI invocations and agent tools read it without a login-shell export. `PI_MODEL_BROKER_URL` explicitly overrides this field; `PI_ORCHESTRATOR_CONFIG` selects another config file. Invalid configured values fail rather than selecting direct shared credentials. Restart or reload an existing agent after changing its broker endpoint.

Local ledger and auth paths default to `~/.local/share/pi-orchestrator/ledger.sqlite3` and its adjacent `auth.json`. Their optional overrides are `PI_ORCHESTRATOR_LEDGER` and `PI_ORCHESTRATOR_AUTH`. Do not point these paths, the config path, `PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, or Remote state paths into the owner's home or shared owner state. Per-user paths are already Orchestrator defaults; explicit paths help service definitions avoid inherited overrides. The local auth file needs no shared credential. The owner keeps the sole issued OAuth credentials and refresh lock.

The ordinary routing extension discovers the broker endpoint from the environment override or per-user config before opening shared account state. It registers canonical `openai-codex` and `anthropic` models through the broker. Select canonical model names, not owner account aliases. Saved numbered model selections resolve to the canonical family through `resolveSessionModel`. Child threads use the same model settings and explicit overrides as other threads.

Native model changes resolve against the registered catalog and call Pi's `setModel`, which checks authentication before changing the session. They do not use the cached availability list as admission authority. Provider registration refreshes that list asynchronously, so it can still be empty when a newly opened broker session receives its first model change. This caused intermittent `Model not found through model broker` refusals despite successful startup. The regression test holds that list empty and also checks that a fresh authentication refusal leaves the selected model unchanged.

The native adapters receive public format markers so their existing OAuth request formatting runs. Those strings cannot authenticate to a provider, are not copied OAuth sessions, and do not authenticate to the broker. The host's UID filter authenticates the connection. Changing the environment cannot grant access to another principal's port or the owner's files.

Normal chat streams, client-side tools, native Codex compaction and image generation use the broker. SSE keeps the native request/response hooks used by compaction. Codex's zstd request bodies are decoded with a bounded output size. Image edits load input files in the user's process and send image bytes; the broker never receives a path to open. Image generation requires the `openai-codex/gpt-6-luna` model grant because Luna routes the image tool request.

The public API exports `modelBrokerUrl(env?, configPath?)`, `loadConfig` and the `OrchestratorConfig` type, including its optional `modelBrokerUrl` field. `createSharedImageGenerationService` uses that same endpoint discovery and honors its explicit `configPath` option. Its explicit `brokerUrl` option supports callers which already resolved the person's endpoint. In broker mode it never opens an owner ledger or auth file. Remote's observation client stays local, so its fleet list and account plans do not reveal the owner's fleet or pool. A local ledger has no shared account rows and does not duplicate the broker's account usage attribution.

## Broker request boundary

Provider requests use these routes:

- `POST /backend-api/codex/responses`
- `POST /v1/messages`, including the native Anthropic `?beta=true` spelling

The broker selects a granted account and injects its authentication into a fixed upstream URL. Caller authorization, cookies, account IDs and endpoint overrides never reach the provider. Redirects fail. Requests must use an explicitly granted model and streaming responses. Codex requires `store:false` and inline input. Only client functions and image generation are accepted as Codex tools; Anthropic accepts client tools only. The broker never executes a tool call.

Stored response references, provider file IDs, remote image/file URLs, containers, vector stores and MCP server declarations are refused. Send image bytes inline rather than a URL. That also means Anthropic's reusable Files API is unavailable in broker mode; inline image inputs remain available. Native encrypted Codex compaction checkpoints are inline session content and remain supported. The broker has no provider status, file, credential, account, fleet, transcript or general proxy endpoint.

`PUT` and `GET /v1/completions/REQUEST_ID` use the [existing durable completion service](completions.md), including Remote thread naming. The broker decodes each request ID from its URL segment once, validates it with the completion contract, then scopes it to the authenticated Unix person before lookup. This preserves IDs such as Remote's `remote-name:THREAD:COUNT:DIGEST` across submission and recovery. Submission records the principal and the accounts it held at the time; daemon admission resolves the principal's grant from the ledger as it stands then, so a request that waits through a grant change is admitted or refused on current terms. The listener limit bounds outstanding completions. The broker does not expose completion assignment history, other people's receipts or thread controls.

Codex cache keys and provider affinity headers are namespaced by the configured principal. Anthropic request bytes are preserved after validation because the Claude OAuth adapter signs their checksum. Response headers are limited to content type, retry delay and request ID; upstream cookies and authentication headers are not returned. The owner retains only normal account leases and usage, not caller transcripts.

## Voice access

Each person listener also carries PiStack Voice at `/v1/voice/status` and
`/v1/voice/sessions`. Remote selects this route whenever the person has a model
broker configured. The broker forwards only status, session creation, heartbeat
and close to the host-owned Voice service. It replaces the request's owner with
`broker:PRINCIPAL`, so knowing another person's session and thread IDs does not
grant access. Caller headers never reach Voice. Requests retain the listener's
concurrency limit, a 256 KiB body limit and a 35-second deadline.

Keep the shared Voice port restricted to its existing administrator/service UIDs.
Converge publication `PUB-eba407c1031d413a8fc2a3ef` failed because a newly provisioned
person tried that port directly. Its UID firewall correctly refused the connection.
The per-person broker is the authorized path; opening the shared port would allow
caller-supplied owner identities. Voice retains its own API credential and durable
session database. Model OAuth credentials are not used for Voice.

`deploy/host` restarts running `pi-model-broker.service` and
`pi-stack-model-broker@*.service` instances after selecting Orchestrator and before
supervisor activation and smoke checks. This loads broker changes on both hosts;
active broker requests are cancelled by the existing shutdown contract.

## Activation proof

The host owner should prove the actual UID boundary before enabling users. As each ordinary UID, confirm that owner files and runtime sockets are inaccessible, the fleet API and other person's broker port are refused, and their own broker port accepts a granted model request. Then make one ordinary agent turn, one native compaction and one image request through the installed runtime. These are deployment checks, not substitutes for the UID filter.

The focused source tests use fake upstream responses and finish in seconds. They cover route and grant refusal, stored-resource refusal, credential replacement, scoped affinity, leases, usage, native transport hooks and image transport without owner files. A config-only startup test opens native parent and child sessions, switches from numbered provider aliases to canonical broker models, and exercises the bundled CLI without broker or Orchestrator path environment overrides. They make no provider calls.
