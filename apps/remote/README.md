# Pi Remote

A self-hosted web and Android controller for persistent [Pi](https://pi.dev) coding-agent sessions.

Pi Remote keeps session state in SQLite, talks to Pi through RPC mode, survives browser or app disconnects, queues prompts durably, and streams tool and model activity. It observes autonomous agents through Pi Orchestrator's public read model rather than reading that service's SQLite tables. An optional identity router starts per-user supervisors whose private directories are mounted only while unlocked.

The interactive view is Pi's provider-neutral model context, not a transcript reconstructed by Pi Remote. Pi Remote is installed as the final Pi package so `server/context-mirror.ts` runs after every other `context` handler. It stores the effective system prompt, active tool schemas, and `convertToLlm()` messages; streaming and finalized model messages update that same document. Both clients consume that document, so compaction removes exactly what Pi removed and loaded AGENTS.md content appears inside the system prompt Pi received. The web client renders it whole. Android keeps the complete display projection but builds a keyed tail window: instructions and tool definitions remain collapsed rows, recent conversation appears first, and older rows are created only when requested. It fills that window within a per-frame work budget rather than delaying every row by a frame.

Android synchronizes through a resumable long poll rather than a timer. It requests a display projection that omits provider continuation metadata while canonical browser and API context stays untouched. Context and live output travel as SHA-256-verified byte splices against the client's last projected document, with gzip for complete snapshots. The app keeps verified context in private storage for offline reading and records prompts in an idempotent outbox before clearing the composer. Completion watches receive only the named thread states. Attachment uploads resume from hash-checked committed chunks, and downloads support validators and byte ranges.

The Files drawer tab browses the selected environment from `/`. It includes dotfiles and reads one directory per request. Android uses a recycled list for large directories. Folder taps navigate, file taps download without opening a preview, and a long press copies the absolute path.

Each runtime also loads `server/thread-context.ts`. The extension offers initialization only while the durable session title is numeric, removes that control from named threads, and treats process or model changes as continuation rather than a new thread. It tells the agent how to offer downloadable files. A `<pi-remote-file src="/absolute/path" />` tag becomes a normal link in both clients, and the session-scoped endpoint streams the file from the thread's host.

On hosts that load `pi-runtime`'s state-compactor, the extension keeps previously read mandatory skill contents in the compacted provider view. It validates those contents against the current files and asks the agent to finish a paged read or refresh a changed file instead of silently retaining stale instructions.

Model menus, autonomous-agent labels, and plan cards use the catalog exported by `pi-orchestrator/api`. Plan cards project the orchestrator's account and meter facts; Pi Remote carries no provider usage parser or duplicate provider manifest.

## Requirements

- [Bun](https://bun.sh/)
- Pi on the supervisor's `PATH`
- `apps/remote` installed as Pi's final configured package
- the root npm workspaces installed and Pi Orchestrator built
- Android SDK 36 and Java 17 to build the Android client

## Configuration

Pi Remote loads `$XDG_CONFIG_HOME/pi-remote/config.json`, falling back to `~/.config/pi-remote/config.json`. Set `PI_REMOTE_CONFIG` to use another path.

```json
{
  "version": 1,
  "environment": {
    "PI_REMOTE_ENVIRONMENT_ID": "local",
    "PI_REMOTE_ENVIRONMENT_NAME": "Local",
    "PI_REMOTE_REQUIRES_UNLOCK": true,
    "PI_REMOTE_DATA": "/var/lib/pi-remote",
    "PI_REMOTE_HOST": "127.0.0.1",
    "PI_REMOTE_PORT": 8788,
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

Host identities, Tailscale names, private directory paths, alert integration, remote targets, workspace menus, app branding, and provider custody belong in this untracked configuration or in the host's service manager, not in the repository.

The Android client reads ignored `android/local.properties` values. Direct endpoints use a URL:

```properties
piRemoteLocalUrl=https://local-pi-remote.example.ts.net
piRemoteConvergeAuth=direct
piRemoteConvergeUrl=https://converge-pi-remote.example.ts.net
piRemoteApplicationId=dev.example.piremote
piRemoteAppLabel=Pi Remote
```

An SSH-backed Converge endpoint replaces its direct URL with a restricted local-forward:

```properties
piRemoteConvergeAuth=ssh
piRemoteConvergeSshHost=converge.example.net
piRemoteConvergeSshPort=22
piRemoteConvergeSshUser=pi-remote-android
piRemoteConvergeSshPrivateKeyFile=/owner-only/path/to/android-converge-key
piRemoteConvergeSshHostKey=ecdsa-sha2-nistp256 <base64-encoded host key>
piRemoteConvergeSshLocalPort=8789
piRemoteConvergeSshRemoteHost=127.0.0.1
piRemoteConvergeSshRemotePort=8788
```

The app pins the SSH host key and opens only the declared forward. Keep the private key out of Git.

## Run

Install Pi Remote after every other Pi package. This is what makes the read-only context mirror the final `context` handler; the supervisor refuses to start if the ordering invariant is missing.

```sh
cd /absolute/path/to/pi-stack
npm ci --ignore-scripts
npm run build
pi install /absolute/path/to/pi-stack/apps/remote
npm start --workspace=pi-remote
```

If another package was installed later, remove and reinstall the `apps/remote` path so it returns to the end.

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

Bind the service to loopback or a private network. Direct endpoints rely on deployment-layer network access. SSH endpoints pin the server host key and carry their private identity in the local Android build. Unlock keys stay in Android's private preferences and never enter the JSON server configuration.

## License

MIT
