# Pi Remote

A self-hosted web and Android controller for persistent [Pi](https://pi.dev) coding-agent sessions.

Pi Remote keeps session state in SQLite, talks to Pi through RPC mode, survives browser or app disconnects, queues prompts durably, streams tool and model activity, and can combine agent activity from local and SSH-backed hosts. An optional identity router starts per-user supervisors whose private directories are mounted only while unlocked.

The interactive view is Pi's provider-neutral model context, not a transcript reconstructed by Pi Remote. Pi Remote is installed as the final Pi package so `server/context-mirror.ts` runs after every other `context` handler. It stores the effective system prompt, active tool schemas, and `convertToLlm()` messages; streaming and finalized model messages update that same document. Both clients render the complete document, so compaction removes exactly what Pi removed and loaded AGENTS.md content appears inside the system prompt Pi received.

Each runtime also loads `server/thread-context.ts`. The extension offers initialization only while the durable session title is numeric, removes that control from named threads, and treats process or model changes as continuation rather than a new thread. It tells the agent how to present images and downloadable files. A `<pi-remote-file src="/absolute/path" />` tag becomes a normal link in both clients, and the session-scoped endpoint streams the file from the thread's local or SSH execution target.

On hosts that load `pi-runtime`'s state-compactor, the extension keeps previously read mandatory skill contents in the compacted provider view. It validates those contents against the current files and asks the agent to finish a paged read or refresh a changed file instead of silently retaining stale instructions.

Pi sessions may delegate a self-contained task to one isolated nested agent.
Both clients advertise that capability in the composer and render `delegate`
as a distinct **Nested agent** tool card: the full delegated task and working
directory remain expandable while the child's single final answer lands in the
same card. Nested execution is owned by pi-orchestrator; Pi Remote only renders
the tool calls and results already present in Pi's model context.

## Requirements

- [Bun](https://bun.sh/)
- Pi on the supervisor's `PATH`
- this checkout installed as Pi's final configured package: `pi install /absolute/path/to/pi-remote`
- a deployed `pi-orchestrator` integration when voice and allowance controls are enabled
- Android SDK 36 and Java 17 to build the Android client

## Configuration

Pi Remote loads `$XDG_CONFIG_HOME/pi-remote/config.json`, falling back to `~/.config/pi-remote/config.json`. Set `PI_REMOTE_CONFIG` to use another path.

```json
{
  "version": 1,
  "environment": {
    "PI_REMOTE_DATA": "/var/lib/pi-remote",
    "PI_REMOTE_HOST": "127.0.0.1",
    "PI_REMOTE_PORT": 8788,
    "PI_REMOTE_ORCHESTRATOR_MODULE": "/opt/pi-orchestrator/dist",
    "PI_REMOTE_ORCHESTRATOR_DB": "/var/lib/pi-orchestrator/ledger.sqlite3",
    "PI_REMOTE_ORCHESTRATOR_RUNS": "/var/lib/pi-orchestrator/runs",
    "PI_REMOTE_WORKSPACES": [
      { "id": "home", "name": "Home", "path": "/home/agent" }
    ],
    "PI_REMOTE_DESTINATIONS": "home"
  }
}
```

Values in `environment` become process environment variables before the supervisor loads. Existing process variables win, which makes service-level overrides straightforward. Arrays and objects are JSON-encoded automatically.

Host identities, Tailscale names, private directory paths, alert integration, remote targets, workspace menus, app branding, and provider custody belong in this untracked configuration or in the host's service manager—not in the repository.

The Android client reads these ignored `android/local.properties` keys:

```properties
piRemoteUrl=https://pi-remote.example.ts.net
piRemoteApplicationId=dev.example.piremote
piRemoteAppLabel=Pi Remote
```

## Run

Install Pi Remote after every other Pi package. This is what makes the read-only context mirror the final `context` handler; the supervisor refuses to start if the ordering invariant is missing.

```sh
pi install /absolute/path/to/pi-remote
bun server/main.ts
```

If Pi Remote was already configured and another package was installed later, move it back to the end with `pi remove /absolute/path/to/pi-remote` followed by the install command above.

For the router, supply `PI_REMOTE_USERS` as a JSON array and run:

```sh
bun server/router.ts
```

The router expects systemd template units named `pi-remote@<user>.service`. `server/pi-remote-launch` is the generic gocryptfs mount wrapper used by those units.

## Test

```sh
bun test server/*.test.ts web/*.test.ts
cd android && ./gradlew test
```

## Security boundary

Bind the service to loopback or a private network. The application assumes network access control is handled by the deployment layer. Secrets and unlock keys must stay in local credential stores; they are never part of the JSON application configuration.

## License

MIT
