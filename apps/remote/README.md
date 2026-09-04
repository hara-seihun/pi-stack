# Pi Remote

A self-hosted web and Android controller for persistent [Pi](https://pi.dev) coding-agent sessions.

Pi Remote keeps session state in SQLite, talks to Pi through RPC mode, survives browser or app disconnects, queues prompts durably, and streams tool and model activity. It observes autonomous agents through Pi Orchestrator's public read model rather than reading that service's SQLite tables. The Orchestrator tab groups running agents by host. A front door starts one supervisor per person, and a person's private directory is mounted only while she has unlocked it.

Interactive Pi children run at normal scheduler priority. Background services and CI must yield through their own scheduler settings. Lowering the interactive child priority makes every compiler, test, and file scan it starts lose CPU at the exact moment an operator is waiting for it.

The interactive view is Pi's provider-neutral model context, not a transcript reconstructed by Pi Remote. Pi Remote is installed as the final Pi package so `server/context-mirror.ts` runs after every other `context` handler. It stores the effective system prompt, active tool schemas, and `convertToLlm()` messages at durable message boundaries. Live assistant text takes a separate in-memory path and wakes clients on the first delta, then at most once per 16 milliseconds. This avoids rewriting and hashing the full model context for every token. When a message ends, the supervisor keeps its final live text visible until the context mirror acknowledges the durable replacement containing that message. The mirror retries the latest unacknowledged document across transient request failures instead of dropping it. Session startup, compaction, and tree navigation replace the durable context from Pi's current session branch immediately. A successful compaction must acknowledge that replacement before the server will keep any context visible. If capture fails, the server clears the old document rather than show messages Pi removed. Loaded AGENTS.md content appears inside the system prompt Pi received. The shared client renders the context whole.

The browser and Android client synchronize through a resumable long poll rather than a timer. They request a display projection that omits provider continuation metadata while canonical API context stays untouched. After automatic compaction, pi-vcc adds the visible user message `your context was compacted, you now have tons of space to keep working as long as you like`. When it follows the empty aborted assistant response created by compaction, the projection labels that response `Context compacted` instead of `Assistant error`. Context and live output travel as SHA-256-verified byte splices against each client's last projected document, with gzip for complete snapshots. The response is divided into versioned sections: thread state carries the supervisor's version, the drawer dashboard carries its own, and the selected thread's context and live text are compared by hash on every request. A client echoes the versions and hashes it rendered and receives exactly the sections that moved, so a token wake never withholds a newly selected thread's transcript and a governor or ambience toggle reaches every client without that client patching its own copy. `server/protocol.ts` is the single definition of those shapes for the supervisor and both clients. The identity router remembers a healthy supervisor instead of spawning `systemctl` for every API call.

The browser interface is a React 19 and TypeScript application built by Vite. Sessions, context entries, messages, tool calls, plan rows, and machine controls have stable keys, so a synchronization response updates the changed properties without detaching the rest of the page. Consecutive system, thinking, tool, and status boxes appear as one collapsed "Agent details" box between user and assistant messages. Its box count grows with the work, and selecting it reveals each original box. When a details group is the newest transcript item, its latest box remains visible below the collapsed heading so the agent's current work stays in view. Live model text is isolated from the durable transcript and renders as Markdown while it streams. Each chunk is completed into a document that parses the way the finished one will, and the result is patched into the existing nodes rather than written over them, so a message never flips between source and rendered form and every existing SVG, selection, expanded tool card, and button stays mounted while unrelated state changes. Compiled formulas are remembered, so re-rendering a growing message does not run KaTeX over the part the reader has already seen. The composer grows with typed, pasted, restored, or wrapped text through six rows, then scrolls.

Every rendered message and live model block has a copy action. A finalized user message also has an edit action: while the thread is idle, Pi forks immediately before that message, the supervisor adopts the forked session file as the thread's current history, and the client places the original text in the composer without sending it. The client retains 32 verified documents in app-private IndexedDB across process restarts and reads them before the first network response for a thread. A cold view renders the latest 60 user messages, assistant messages, and collapsed detail groups first, then pages older items on request. Reverse-column layout keeps the latest entry at the bottom, while native scroll anchoring holds the visible message still when content grows below it. A delayed pointer gesture turns an active thread row into a drag target; dropping it saves the new drawer order in SQLite. Slash-command discovery waits until the composer starts with `/`, so browsing an idle thread never starts its Pi runtime. A queued follow-up can steer after the current tool call, hard steer by immediately terminating the current Pi process group and sending the chosen message first through a replacement on the same session, return to the composer, or be cancelled.

The drawer reports only measured plan and hardware rows. Each plan row also carries how much of that model's prompt tokens came from the provider's cache over the last 24 hours, read from the orchestrator's usage ledger; a model nobody called in that window shows nothing rather than a zero. CPU sampling runs independently of client polling, and Android warms SSH-backed environments in the background so switching does not pay connection setup in the foreground.

[`apps/kenan`](../kenan/README.md) packages the same compiled React client with Capacitor as the Kenan Android app. A small native plugin owns endpoint selection, haptics, system-bar layout, and the pinned Converge SSH tunnel.

Enter sends the composer only where a hardware keyboard is typing. On touch devices the media query `(hover: none) and (pointer: coarse)` matches, Enter inserts a newline, the key is labelled as a return key, and the send button submits. Phone keyboards have no comfortable way to type a newline otherwise, so sending on Enter cost multi-paragraph prompts.

The drawer tabs use an icon and count for Interactive threads, Orchestrator agents, archived threads, and host files. The Files tab is a lazy tree rooted at `/`: opening a folder requests only that directory, dotfiles remain visible, and selecting a regular file downloads it. Headless Tree supplies keyboard and screen-reader tree behavior, while TanStack Virtual keeps directories such as `/nix/store` from creating tens of thousands of DOM rows. The tree remains mounted when another drawer tab is selected, so open folders and the current path survive tab switches.

Each runtime also loads `server/thread-context.ts`. On a new thread's first request, the extension puts waiting machine alerts directly into model context and removes the consumed inbox files once the run starts. There is no thread-initialization tool. The extension treats process or model changes as continuation rather than a new thread, tells every model to use `read-thread` for local access to another thread, and reserves `read-condensed-session` for explicit semantic condensation. It also tells the agent how to offer downloadable files. A `<pi-remote-file src="/absolute/path" />` tag becomes a normal link in both clients, and the session-scoped endpoint streams the file from the thread's host.

The supervisor names a thread after its first user message and updates the name every 20 user or assistant messages. It gives the latest 12 messages to a short-lived, tool-free `pi --print` process and applies the process's first output line to both the Pi session and the supervisor database. `PI_REMOTE_THREAD_NAMING_MODEL` is required and must explicitly select an OpenAI provider, model, and thinking level, such as `openai-codex/gpt-5.6-luna:low`.

Model menus, autonomous-agent labels, and plan cards use the catalog exported by `pi-orchestrator/api`. Plan cards project the orchestrator's account and meter facts; Pi Remote carries no provider usage parser or duplicate provider manifest. New Sol threads start in OpenAI's priority service tier. Existing threads keep their saved mode, and other models start in normal mode.

## Requirements

- [Bun](https://bun.sh/), `jq`, and `gocryptfs` for encrypted folders
- Pi on the supervisor's `PATH`
- `PI_REMOTE_THREAD_NAMING_MODEL` set to an explicit OpenAI Pi model selection
- `apps/remote` installed as Pi's final configured package
- the root npm workspaces installed and Pi Orchestrator built
- Android SDK 36 and Java 21 to build Kenan

## Persons

Every machine runs one front door, `pi-remote-router.service`, and one supervisor per person, `pi-remote@<user>.service`. A person is a unix account with a registry file under `/var/lib/pi-remote/persons/<user>.json`:

```bash
sudo pi-remote person add sibyl --display-name Sibyl --thread-naming-model openai-codex/gpt-5.6-luna:low
sudo pi-remote person add kenan --display-name Kenan --thread-naming-model openai-codex/gpt-5.6-luna:low --no-encrypt --folder converge --environment converge --environment-name Converge
pi-remote person list
sudo pi-remote person remove sibyl                              # forgets her; deletes nothing
```

`add` creates `/home/<user>/<folder>` (the folder defaults to the user name). Unless `--no-encrypt` is given, that folder is a [gocryptfs](https://nuetzlich.net/gocryptfs/) mount of `/home/<user>/.<folder>.crypt`, and the command prints the key exactly once. **Losing the key is unrecoverable data loss**; there is no admin who can help, which is the point. `--existing` adopts a crypt directory that already exists and prints nothing.

The registry file is the whole per-person configuration. Its `environment` object is what the supervisor loads as `PI_REMOTE_CONFIG`, so edit it to change workspaces, thread destinations, models, the data directory, or the orchestrator ledger path; the front door reads it again on restart. `port` is the supervisor's loopback port, and `unlock` names the crypt directory and mountpoint when the folder is encrypted.

```json
{
  "version": 1,
  "user": "kenan",
  "displayName": "Hara",
  "port": 18790,
  "unlock": { "cipherDir": "/home/kenan/.hara.crypt", "mountpoint": "/home/kenan/hara" },
  "environment": {
    "PI_REMOTE_ENVIRONMENT_ID": "local",
    "PI_REMOTE_ENVIRONMENT_NAME": "Local",
    "PI_REMOTE_REQUIRES_UNLOCK": true,
    "PI_REMOTE_PRIVATE_DIR": "/home/kenan/hara",
    "PI_REMOTE_DATA": "/home/kenan/hara/.pi-remote",
    "PI_REMOTE_PORT": 18790,
    "PI_REMOTE_THREAD_NAMING_MODEL": "openai-codex/gpt-5.6-luna:low",
    "PI_REMOTE_ORCHESTRATOR_DB": "/home/kenan/.local/share/pi-orchestrator/ledger.sqlite3",
    "PI_REMOTE_ORCHESTRATOR_RUNS": "/home/kenan/.local/share/pi-orchestrator/runs",
    "PI_REMOTE_WORKSPACES": [{ "id": "home", "name": "Kenan", "path": "/home/kenan" }],
    "PI_REMOTE_DESTINATIONS": "home"
  }
}
```

`PI_REMOTE_ACTIONS` adds toggle buttons to the drawer for things the host can do: each action has an `id`, `label`, `icon` (a web asset name such as `thunder`, or a `/path.svg` or `data:` URL), a `status` argv whose exit code 0 means on and 1 means off, and `on` and `off` argvs. Pi Remote runs them and shows the result; it knows nothing about what they do. GMKtec configures one for its thunder ambience:

```json
"PI_REMOTE_ACTIONS": [{
  "id": "thunder", "label": "Thunder", "icon": "thunder",
  "status": ["bash", "-c", "audio status | jq -e '.kind == \"thunder\" and .status != \"stopped\"' >/dev/null"],
  "on": ["/home/kenan/.local/bin/audio", "thunder"],
  "off": ["/home/kenan/.local/bin/audio", "stop"]
}]
```

Values in `environment` become process environment variables before the supervisor loads. Existing process variables win. Arrays and objects are JSON-encoded automatically. All persons on a machine must agree on the environment id and name.

Each thread starts with a 30-minute maximum for foreground bash calls. Its Thread settings panel can change that limit to 60 seconds, 5 minutes, or half an hour. Pi Remote stores the choice with the thread and restarts its idle runtime so the next agent request receives the new limit.

### The front door

The front door listens on the published port (8788), holds no state and no keys, and hands each request to the right supervisor. Identity is the `x-pi-remote-user` header, which the web client and the Android app send once a person has been chosen; a machine with one person needs no header. The folders are what protect anything worth protecting, and they are open exactly while their owner is working, so a name on a request grants nothing a key does not already grant.

A person with an encrypted folder has a supervisor only while her key is in memory. Her unit runs with `PrivateMounts=yes`; [`server/pi-remote-launch`](server/pi-remote-launch) mounts the folder inside that namespace and then becomes the supervisor, so every Pi thread she runs sees an ordinary directory and nothing else on the machine sees anything. The key reaches the unit as a systemd credential from a root-only tmpfs file that the front door writes on unlock and removes on lock. Stopping the unit destroys the namespace, the mount, and the key together. A wrong key fails the mount; the unit's start limit (five tries in a minute) is how the front door tells a wrong key from a slow one. Locked requests answer `423`, and both clients respond by unlocking with the stored key and repeating the request.

A person without an encrypted folder is started by the front door when it starts and whenever her unit is found down. Nothing is ever locked for her.

Root can still read a running mount by entering a live supervisor's namespace. The guarantee is that a folder is unreadable while its owner is not working, including to disk theft and to every backup; it is not a guarantee against another administrator attacking a live session.

## Run

Install the root workspaces, build the orchestrator, and add a person. `deploy/host` does all of this on a real machine; by hand:

```sh
cd /absolute/path/to/pi-stack
npm ci --ignore-scripts
npm run build
npm run build --workspace=pi-remote
sudo PI_REMOTE_PERSONS_DIR=/var/lib/pi-remote/persons bun apps/remote/server/person-cli.ts person add "$USER" --display-name Me --thread-naming-model openai-codex/gpt-5.6-luna:low --no-encrypt
sudo systemctl start pi-remote-router
```

The reference units in [`../../deploy/systemd`](../../deploy/systemd) show what the front door and supervisor need. Pi Remote must be the last configured Pi package so its read-only context mirror is the final `context` handler; the supervisor refuses to start otherwise.

A reload of a supervisor unit replaces the supervisor process immediately. Per-thread runtime hosts remain in the same service cgroup and mount namespace, so active Pi processes finish their turns and the replacement supervisor reconnects their RPC streams in parallel. Health and saved thread state remain available during that reconnection; an action that needs a runtime waits for it to finish. Once an adopted runtime settles, the supervisor replaces it before its next use so provider and extension changes take effect. Stopping the unit still kills every process and destroys the private mount.

## Test

```sh
bun test server/*.test.ts web/*.test.ts
npm run android:test --workspace=kenan
```

## Security boundary

Bind the service to loopback or a private network. Direct endpoints rely on deployment-layer network access. SSH endpoints pin the server host key and carry their private identity in the local Android build. Unlock keys stay in Android's private preferences and never enter the JSON server configuration.

## License

MIT
