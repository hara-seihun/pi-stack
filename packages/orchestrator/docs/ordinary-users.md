# Ordinary Unix users

A Unix user with write access to the fleet ledger, config or OAuth pool is a fleet administrator. The HTTP fleet API also grants administrator access: it can launch arbitrary code as the daemon user and read run transcripts. Removing `sudo` does not change either boundary.

Use separate local state for ordinary users. Share model requests through the model broker, not through filesystem permissions on the owner's state.

## Host contract

The host owns Unix accounts, filesystem permissions, services and packet filtering. Deploy all of these together:

- Run each person's Remote supervisor and agent processes as that person's Unix UID, with their own HOME and Pi configuration. Their tools inherit that UID.
- Remove administrator and shared-state groups. Protect owner homes, credentials, runtime sockets, ledger, config and person registry against those UIDs. Replace per-user links into owner state with ordinary user-owned files and directories.
- Restrict every route on the fleet daemon's TCP port to its administrator UID and explicitly authorized services. Read endpoints disclose owner transcripts too. Restrict any reverse proxy which can reach that API.
- Run `pi-orchestrator model-broker /etc/pi-model-broker.json` as the credential owner. This process needs the owner's ledger/auth access, but never starts agents or executes caller tools. Keep its environment and service definition owner-controlled.
- Install UID-based loopback packet filtering **before starting the broker**. Each configured broker port belongs to one Unix principal. Permit that UID and the administrator; reject other local UIDs and traffic arriving through forwarding or a network interface. Broker listeners bind only `127.0.0.1`.
- Keep grants root-owned and without group/other write access. The CLI refuses other grant files. Restart the broker after grant changes; restarting cancels its active requests.

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
        "openai-codex/gpt-5.6-sol",
        "openai-codex/gpt-5.6-terra",
        "openai-codex/gpt-5.6-luna",
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
        "openai-codex/gpt-5.6-sol",
        "openai-codex/gpt-5.6-terra",
        "openai-codex/gpt-5.6-luna",
        "anthropic/claude-fable-5-1"
      ],
      "maxInFlight": 20
    }
  ]
}
```

Granting an alias explicitly permits that person's requests to spend that account's provider quota. It does not transfer credential ownership. Both listeners may deliberately share an alias. Disabled, reserved, cooling or exhausted accounts remain unavailable. Per-listener request limits, the owner's configured account concurrency and machine concurrency apply. Fleet background pause does not pause interactive model access. Leases cover provider requests, not time spent running local tools. The owner retains account metering and hourly usage attribution under `broker:PRINCIPAL:REQUEST_ID`; callers cannot choose those ledger keys.

## Client contract

For Sybil, set:

```text
PI_MODEL_BROKER_URL=http://127.0.0.1:2461
PI_ORCHESTRATOR_LEDGER=/home/sybil/.local/share/pi-orchestrator/ledger.sqlite3
PI_ORCHESTRATOR_CONFIG=/home/sybil/.config/pi-orchestrator/config.json
PI_ORCHESTRATOR_AUTH=/home/sybil/.local/share/pi-orchestrator/auth.json
```

Use Jodie's own paths and port for Jodie. Do not point any of these paths, `PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, or Remote state paths into the owner's home or shared owner state. Per-user paths are already Orchestrator defaults; explicit paths help service definitions avoid inherited overrides. The local auth file needs no shared credential. The owner keeps the sole issued OAuth credentials and refresh lock.

The ordinary routing extension detects `PI_MODEL_BROKER_URL` before opening shared account state. It registers canonical `openai-codex` and `anthropic` models through the broker. Select canonical model names, not owner account aliases. Saved numbered model selections resolve to the canonical family through `resolveSessionModel`. Subagent model pins still apply.

The native adapters receive public format markers so their existing OAuth request formatting runs. Those strings cannot authenticate to a provider, are not copied OAuth sessions, and do not authenticate to the broker. The host's UID filter authenticates the connection. Changing the environment cannot grant access to another principal's port or the owner's files.

Normal chat streams, client-side tools, native Codex compaction and image generation use the broker. SSE keeps the native request/response hooks used by compaction. Codex's zstd request bodies are decoded with a bounded output size. Image edits load input files in the user's process and send image bytes; the broker never receives a path to open. Image generation requires the `openai-codex/gpt-5.6-luna` model grant because Luna routes the image tool request.

`createSharedImageGenerationService` automatically uses the broker environment. Its explicit `brokerUrl` option supports callers which already have the person's environment. In broker mode it never opens an owner ledger or auth file. Remote's observation client stays local, so its fleet list and account plans do not reveal the owner's fleet or pool. A local ledger has no shared account rows and does not duplicate the broker's account usage attribution.

## Broker request boundary

Only these new-request routes exist:

- `POST /backend-api/codex/responses`
- `POST /v1/messages`, including the native Anthropic `?beta=true` spelling

The broker selects a granted account and injects its authentication into a fixed upstream URL. Caller authorization, cookies, account IDs and endpoint overrides never reach the provider. Redirects fail. Requests must use an explicitly granted model and streaming responses. Codex requires `store:false` and inline input. Only client functions and image generation are accepted as Codex tools; Anthropic accepts client tools only. The broker never executes a tool call.

Stored response references, provider file IDs, remote image/file URLs, containers, vector stores and MCP server declarations are refused. Send image bytes inline rather than a URL. That also means Anthropic's reusable Files API is unavailable in broker mode; inline image inputs remain available. Native encrypted Codex compaction checkpoints are inline session content and remain supported. The broker has no status, file, credential, account, fleet, transcript, completion-replay or general proxy endpoint.

Codex cache keys and provider affinity headers are namespaced by the configured principal. Anthropic request bytes are preserved after validation because the Claude OAuth adapter signs their checksum. Response headers are limited to content type, retry delay and request ID; upstream cookies and authentication headers are not returned. The owner retains only normal account leases and usage, not caller transcripts.

## Activation proof

The host owner should prove the actual UID boundary before enabling users. As each ordinary UID, confirm that owner files and runtime sockets are inaccessible, the fleet API and other person's broker port are refused, and their own broker port accepts a granted model request. Then make one ordinary agent turn, one native compaction and one image request through the installed runtime. These are deployment checks, not substitutes for the UID filter.

The focused source tests use fake upstream responses and finish in seconds. They cover route and grant refusal, stored-resource refusal, credential replacement, scoped affinity, leases, usage, native transport hooks and image transport without owner files. They make no provider calls.
