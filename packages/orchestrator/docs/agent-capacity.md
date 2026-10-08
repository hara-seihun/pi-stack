# Global agent execution capacity

Pi Stack has one durable admission authority and a hard limit of **100 executing agents**, across every host, person, foreground/background placement, application, peer and root agent. Account spending urgency, subscription pacing and native memory/residency limits are separate controls. None grants an execution-slot exemption. Dependency waits and settled warm sessions do not hold slots.

[`agent-capacity.ts`](../src/agent-capacity.ts) supplies the typed client. [`agent-capacity-authority.ts`](../src/agent-capacity-authority.ts) owns the SQLite ledger and HTTP server. The shared native runner continues hosting many sessions in one process; capacity does not create a process per agent.

## Custody

A stable agent ID survives retries and live handoffs. A capacity execution ID is written durably before acquisition. Repeating acquisition of the same owner/agent/execution returns the same lease; another execution of the same agent waits until prior custody is positively released. Another owner's credential cannot adopt or release it. Release requires the matching lease ID and is idempotent. A released execution is tombstoned and cannot execute again; a subsequent attempt has a new durable execution ID with the same agent ID.

The ledger never expires active entries. A dead process, missing heartbeat, unreachable host, lost HTTP response or cancellation error is not a settlement receipt. `inspect()` can recover an acquired lease after response loss. `withdraw()` only cancels unadmitted requests; it refuses active custody and fences requests that arrive after withdrawal. Global saturation and unavailable/configuration errors leave runnable work queued with the explicit capacity reason. The owner replays positive releases after reconnecting; losing a release acknowledgement cannot admit extra work.

Thread owners keep capacity custody separate from provider leases. A dependency waiter first settles native work, then releases execution capacity. Provider retry waiting can release a positively idle native attempt without changing its accepted work identity. Non-observing native commands, including manual compaction and bash, require capacity too. Reading unloaded history does not execute an agent.

## Explicit configuration

One host runs:

```
node /srv/pi/pi-orchestrator/dist/agent-capacity-cli.js serve /etc/pi-stack/agent-capacity-authority.json
```

The authority configuration is:

```json
{
  "databasePath": "/var/lib/pi-stack/agent-capacity/capacity.sqlite3",
  "listenHost": "127.0.0.1",
  "port": 2482,
  "owners": [
    {"id": "host-a/alice", "host": "host-a", "tokenFile": "/etc/pi-stack/agent-capacity-credentials/host-a-alice"},
    {"id": "host-b/alice", "host": "host-b", "tokenFile": "/etc/pi-stack/agent-capacity-credentials/host-b-alice"}
  ]
}
```

Every owner has a unique credential. Each Unix person receives only their own credential, readable by that person, not an administrator's token. Credential values are not placed in command arguments, source or docs. The host service owns its SQLite directory and retained WAL. Bind only on the trusted private transport. A host-owned SSH tunnel can forward the same loopback authority to another host; that host must never instantiate an independent ledger when the tunnel is down.

Every host installs the public client manifest `/etc/pi-stack/agent-capacity-client.json`:

```json
{
  "authorityUrl": "http://127.0.0.1:2482",
  "owners": [
    {"uid": 1000, "ownerId": "host-a/alice", "tokenFile": "/home/alice/.config/pi-stack/agent-capacity-token"}
  ]
}
```

The client selects the actual Unix UID. `PI_AGENT_CAPACITY_CONFIG` explicitly selects a different absolute manifest path. An explicit complete environment tuple (`PI_AGENT_CAPACITY_URL`, `PI_AGENT_CAPACITY_OWNER`, `PI_AGENT_CAPACITY_TOKEN_FILE`) selects a client directly; a partial tuple is an error. These are configuration routes, not failover authorities. Unset, unreadable, invalid, unauthorized or unreachable configuration fails closed. There is no production unmanaged fallback. Mock-only owners explicitly select unmanaged mode; installed Remote and Orchestrator owners use the shared client.

## Initial cutover

An empty authority starts **uninitialized** and refuses fresh admission. Before accepting its census:

1. Hold dispatch/intake on every old ungated owner and select managed launchers. Existing native work continues under its existing custody; do not kill it to activate capacity.
2. Capture each configured host's ThreadService execution receipts inside each person's authorized namespace. Include root, ordinary person and application owners. A paused owner and an idle retained runtime are not automatically absent execution. The scanner counts unfinished durable execution receipts and uncertain retained native custody, not `thread.state='running'`.
3. Merge all host receipts under the same barrier identity. Initialization requires every configured owner/host pair and rejects overlapping agent identities. A census above100 returns an explicit overcapacity error and leaves the authority uninitialized. Retain existing work and recapture after positive natural settlements.
4. Initialize once, activate shared-gated sources/clients on every owner, then release the old intake barrier. New publication doctors and repair agents acquire ordinary slots too. They cannot use an initialization bypass.

A census plan names exact authorized sources:

```json
{
  "host": "host-a",
  "barrierId": "cutover-2026-10-07",
  "owners": [{
    "ownerId": "host-a/alice",
    "threadDatabases": ["/home/alice/.pi-remote/threads.sqlite3", "/var/lib/pi-orchestrator/alice/threads.sqlite3"],
    "threadDatabaseDirectories": ["/home/alice/private/root-sessions"]
  }]
}
```

Named missing/unreadable sources are errors, not empty censuses. Empty arrays explicitly describe known inactive sources. `threadDatabaseDirectories` recursively discovers exact `threads.sqlite3` filenames without following symbolic links. Root's private per-request owner database is `config.sessionsDir/<request-uuid>/threads.sqlite3`; inventory its configured session root in its authorized mount namespace. Files with other names, including native JSONL traces, are never read. Explicit paths and discovered databases are deduplicated. ThreadService's settled-but-unacknowledged capacity releases remain conservatively counted. Old native control versions without per-agent status remain uncertain when any session is active. Do not infer a stopped tool tree from a process ID alone. Tool-free inference creates no agent execution and contributes no census entry.

```
pi-agent-capacity census HOST_A_PLAN > HOST_A_CENSUS
pi-agent-capacity census HOST_B_PLAN > HOST_B_CENSUS
pi-agent-capacity merge HOST_A_CENSUS HOST_B_CENSUS > GLOBAL_CENSUS
pi-agent-capacity initialize AUTHORITY_CONFIG GLOBAL_CENSUS
```

The census tool cannot retroactively freeze code that never called it. The publication/host owner owns the old-source dispatch barrier, authorized source inventory and activation order. Only a barrier actually held across all producers makes initial admission safe. A second initialization is refused; never replace retained custody with an empty ledger or a fresh census to make queued work run.

`GET /v1/status` with an owner credential returns only aggregate initialized/active/queued/limit data. It does not disclose another person's thread IDs or content. Authority failures retain custody and all consumers continue queuing.
