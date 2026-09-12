# Pi Remote

A self-hosted web and Android controller for persistent [Pi](https://pi.dev) coding-agent sessions.

Pi Remote keeps admission and its work outbox in SQLite. The selected core owns revisioned execution receipts, consumed through the same `CoreController` as fleet workers. Remote commits each named outcome through `server/execution-controller.ts`; activity events and idle status cannot complete work. It survives browser or app disconnects, queues prompts and slash commands durably, and streams tool and model activity. It observes autonomous agents through Pi Orchestrator's public read model rather than reading that service's SQLite tables. The Orchestrator tab groups running agents by host. A front door starts one supervisor per person, and a person's private directory is mounted only while she has unlocked it.

Root conversations share one Node runtime host per person and release generation. Each root has its own selected [agent core](../../docs/agent-cores.md), cwd, async-scoped environment, runtime socket and durable session state. Pi sessions use the SDK; Codex sessions use app-server. Each core owns its native child tree. Closing a root disposes its core and children, without closing unrelated roots. Session lifecycle operations use the socket, never the shared PID. The pinned upstream RPC implementation is adapted by `packages/runtime/patch-shared-rpc.mjs`, preserving its command and extension UI contract while moving stdin/stdout, signals and process exit to the host. The runtime's [session durability patch](../../packages/runtime/README.md#session-crash-durability) syncs each complete JSONL mutation through gocryptfs before Pi treats it as stored; rewrites are atomic.

The supervisor initializes at most two sessions concurrently, with root threads ahead of queued leaves. The runner admits at most 64 resident sessions by default (`PI_REMOTE_MAX_ACTIVE_RUNTIMES`), reserves four places for roots and explicitly prioritized coordinators, stops admission at 6 GiB RSS (`PI_REMOTE_RUNNER_MAX_RSS_MB`) or 80% of a cgroup memory ceiling, and leaves excess work in SQLite for retry. Cgroup admission measures the working set (`memory.current` minus reclaimable `inactive_file` cache), so a completed source-tree scan cannot indefinitely block new work. An idle session with committed context and no pending work can unload to make room; its saved conversation is retained. Each runner has an 8 GiB V8 heap ceiling. Browser and shell subprocesses remain separate and count toward the service's memory budget. This runner owns Remote threads and their delegated children; Orchestrator fleet workers retain their own transient-unit lifecycle.

`PUT /v1/sessions/:sessionId/admission` with `{"priority":true}` durably prioritizes an existing coordinator and makes its queued work immediately eligible. It creates no prompt or child and cancels no work. `{"priority":false}` removes the explicit priority. Active turns are never preempted. Initialization concurrency limits startup work, not concurrent model requests. Control timeouts retain the existing runner and retry the same session socket; only a refused or absent control socket permits replacement.

RPC output awaiting supervisor acknowledgement is spooled beside the session socket instead of accumulating in RAM. Reattachment streams the unacknowledged records with backpressure. A shared runner can shed an image-heavy socket without ending its session. The supervisor reconnects to that same socket at its last delivered sequence, discards any partial transport frame and does not resend commands. Only an explicit exit or a refused or absent endpoint starts session recovery. On September 12, treating a shed socket as exit 1 caused completed image workers to receive repeated recovery prompts. The transport tests cover interrupted frames and a 20 MiB output burst without a second command. Once all sessions close, the runner exits after five seconds. Runtime control sockets are under the person's data directory in `runtime-runners/`, separate from per-session sockets in `runtime-hosts/`.

Capacity-blocked threads retain a stable `QUEUED` state and stay visible in the Agents list. `server/runtime-capacity-queue.ts` checks capacity once for the entire waiting queue, wakes only the eligible coordinator or leaf slots, and checks again when a session closes. Waiting does not repeatedly initialize sessions, increment their revisions, or count as a failure. Prompts remain in SQLite and abort/archive removes the corresponding waiter. `STARTING` is published only after the runner admits the session; `server/runtime-admission.ts` continues to prioritize and serialize actual initialization.

Every runner starts under `flock --no-fork` with a generation-specific lease beside its control socket. Only the process holding that kernel lease can reclaim a stale control/session socket. A slow or reset connection is not proof of death and never authorizes deleting a live runner's endpoint. A real process exit releases the lease automatically. Retrying an uncertain open uses the same generation/thread address, so it cannot create a second session. Existing duplicates from a pre-lease release are removed by a controlled supervisor service restart after deploying the fix; saved prompts and conversation files are retained.

Interactive Pi children run at normal scheduler priority. Background services and CI must yield through their own scheduler settings. Lowering the interactive child priority makes every compiler, test, and file scan it starts lose CPU at the exact moment an operator is waiting for it.

For Pi cores, the interactive view is Pi's provider-neutral model context, not a transcript reconstructed by Pi Remote. Pi Remote is installed as the final Pi package so `server/context-mirror.ts` runs after every other `context` handler. It stores the effective system prompt, active tool schemas, and `convertToLlm()` messages at durable message boundaries. Only the owning RPC process publishes context; its `PI_REMOTE_CONTEXT_OWNER_PID` marker prevents nested Pi processes from inheriting ownership, and print/JSON/TUI diagnostics never publish into the parent thread. The supervisor resets that marker when starting an intentional Remote runtime. Captures also name the selected core generation and runtime instance. A retired publisher receives HTTP 410 and stops; captures from different core generations cannot overwrite each other by timestamp. The Pi native adapter does not run a second publisher for Remote roots. Live assistant text takes a separate in-memory path and wakes clients on the first delta, then at most once per 16 milliseconds. This avoids rewriting and hashing the full model context for every token. When a message ends, the supervisor keeps its final live text visible until the context mirror acknowledges the durable replacement containing that message. The mirror retries the latest unacknowledged document across transient request failures instead of dropping it. Ordinary message boundaries send a verified byte splice when it is smaller than a complete document; unchanged captures need no request unless a finalization acknowledgement is pending. Compaction always sends a complete replacement. [`server/context-journal.ts`](server/context-journal.ts) checkpoints before a chain reaches 32 patches, 1 MiB of inserted data, or a quarter of the document size. Cold reads assemble the persisted patches before copying and verifying the final document, rather than repeatedly copying unchanged images. Session startup, compaction, and tree navigation replace the durable context from Pi's current session branch immediately. A successful compaction must acknowledge that replacement before the server will keep any context visible. If capture fails, the server clears the old document rather than show messages Pi removed. Loaded AGENTS.md content appears inside the system prompt Pi received. The shared client renders the context whole. Codex app-server does not expose its assembled prompt. Its view is explicitly a portable activity projection with observed tools, messages and results, not a captured model request.

The browser and Android client synchronize through a resumable long poll rather than a timer. They request a display projection that omits provider continuation metadata while canonical API context stays untouched. Inline images remain in canonical model context but become content-addressed image URLs in the display document. The image endpoint reads from that thread's current context, serves the original bytes with immutable private caching, and returns 404 after the image leaves the current context. Tool-result images load when their card opens, rather than travelling inside every transcript update. Collapsed tool output also mounts only its visible text preview. On the September 7 commercial-thread snapshot, this reduced the display document from 16,029,997 to 358,221 bytes, and its gzip body from 11,891,693 to 107,060 bytes. These are payload measurements, not phone latency measurements. A later 16,247,013-byte canonical snapshot needed a 356-byte splice for a representative appended message. Restoring 31 small patches over that image-heavy base took 18.8 ms with shared byte ranges, versus 653 ms when rebuilding and hashing every intermediate document.

Synchronization commits the section versions only after all document updates verify. A failed patch retains the displayed text and requests complete documents and sections on the next attempt. Selection, foregrounding, restored connectivity and Reconnect interrupt the current operation immediately, including native setup or a transport that never settles. Every synchronization attempt has a 35-second deadline and a bounded retry delay. The connection state shows SYNCING during selection and OFFLINE with Reconnect after a failure. A late cache read cannot replace an authoritative empty context. The router propagates disconnects to the supervisor, and a thread's long poll ignores live-token wakeups from other threads. Server patch history has global byte and entry limits; it no longer retains repeated full canonical image documents.

Context and live output travel as SHA-256-verified byte splices against each client's last projected document, with gzip for complete snapshots. The response is divided into versioned sections: thread state carries the supervisor's version, the drawer dashboard carries its own, and the selected thread's context and live text are compared by hash on every request. A client echoes the versions and hashes it rendered and receives exactly the sections that moved, so a token wake never withholds a newly selected thread's transcript and a governor or ambience toggle reaches every client without that client patching its own copy. `server/protocol.ts` is the single definition of those shapes for the supervisor and both clients. The identity router remembers a healthy supervisor instead of spawning `systemctl` for every API call.

The browser interface is a React 19 and TypeScript application built by Vite. Sessions, context entries, messages, tool calls, plan rows, and machine controls have stable keys, so a synchronization response updates the changed properties without detaching the rest of the page. Consecutive system, thinking, tool, and status boxes appear as one collapsed "Agent details" box between user and assistant messages. Its box count grows with the work, and selecting it reveals each original box. When a details group is the newest transcript item, its latest box remains visible below the collapsed heading so the agent's current work stays in view. Live model text is isolated from the durable transcript and renders as Markdown while it streams. Each chunk is completed into a document that parses the way the finished one will, and the result is patched into the existing nodes rather than written over them, so a message never flips between source and rendered form and every existing SVG, selection, expanded tool card, and button stays mounted while unrelated state changes. Compiled formulas are remembered, so re-rendering a growing message does not run KaTeX over the part the reader has already seen. The composer grows with typed, pasted, restored, or wrapped text through six rows, then scrolls.

Every rendered message and live model block has a copy action. A finalized user message also has an edit action: while the thread is idle, Pi forks immediately before that message, the supervisor adopts the forked session file as the thread's current history, and the client places the original text in the composer without sending it. The client retains 32 verified documents in app-private IndexedDB across process restarts and reads them before the first network response for a thread. A cold view renders the latest 60 user messages, assistant messages, and collapsed detail groups first, then pages older items on request. Reverse-column layout keeps the latest entry at the bottom, while native scroll anchoring holds the visible message still when content grows below it. A delayed pointer gesture turns an active thread row into a drag target; dropping it saves the new drawer order in SQLite. Slash-command discovery waits until the composer starts with `/`, so browsing an idle thread never starts its Pi runtime. A queued follow-up can steer after the current tool call, hard steer by immediately terminating the current Pi process group and sending the chosen message first through a replacement on the same session, return to the composer, or be cancelled.

The New Thread picker keeps its destination and model choices open across dashboard updates. Tapping anywhere except a picker button dismisses it, including the gaps between choices, without activating the control underneath. Creation shows a pending state, and a failed request stays visible with Retry. The [picker state machine](docs/state-machine.md#new-thread-picker) owns these transitions in both clients.

The drawer reports only measured plan and hardware rows. Each plan row also carries how much of that model's prompt tokens came from the provider's cache over the last 24 hours, read from the orchestrator's usage ledger; a model nobody called in that window shows nothing rather than a zero. CPU sampling runs independently of client polling, and Android warms SSH-backed environments in the background so switching does not pay connection setup in the foreground.

[`apps/kenan`](../kenan/README.md) packages the same compiled React client with Capacitor as the Kenan Android app. A small native plugin owns endpoint selection, haptics, system-bar layout, and the pinned Converge SSH tunnel. The browser's environment selector reads `environments` from `/etc/pi-stack/host.json`, as described in [deployment](../../docs/deployment.md#what-a-host-provides). That list belongs to the host, not to any person; adding a person cannot change the available hosts.

Drop files anywhere in the client window to attach them to the open conversation's draft. A window-wide overlay names the destination. Dropping never sends a message, and read-only agent views do not accept attachments. Attachments stay with their conversation when switching threads, including while an upload is running.

The paintbrush beside Attach and Paste opens drawing paper with top-left Cancel and Undo buttons, Done and a current-colour button. Undo removes the most recent stroke without changing the paper's position, scale or rotation. Cancel returns to chat without attaching anything and keeps the sketch available for reopening. The composer is hidden while drawing. Drag with a mouse, finger or pen to draw. Two fingers grab the paper to pan, scale and rotate it; the mouse wheel zooms around the pointer. Brush radius stays at 1% of the drawing viewport's shorter side, so zooming in produces finer strokes on the paper. Existing marks move with the paper rather than changing size independently. The colour button opens a wheel and brightness picker. Done attaches the whole paper as a white-background PNG without sending a message, regardless of the current pan, zoom or rotation. On empty paper, Done just returns to chat. A failed upload keeps the drawing open for retry. Each thread keeps its own paper and view while the client stays open, including across thread switches. Reloading clears unattached drawings. Both the browser and Android builds use this same component.

Enter sends the composer only where a hardware keyboard is typing. On touch devices the media query `(hover: none) and (pointer: coarse)` matches, Enter inserts a newline, the key is labelled as a return key, and the send button submits. Phone keyboards have no comfortable way to type a newline otherwise, so sending on Enter cost multi-paragraph prompts.

The drawer tabs use an icon and count for Interactive threads, Orchestrator agents, archived threads, and host files.

Orchestrator shows active Remote subagents, grouped once under their root coordinating thread. Idle, stopped, failed and archived children do not count or appear in the active list. Their transcripts and immutable identities remain stored, and their parent can reuse a settled child. Each active card shows its model and activity and opens its transcript. Parent links open the coordinator. Fleet cards retain their host identity and parent-run links. A failed fleet observation does not hide active Remote subagents or the last observed fleet cards.

The Files tab is a lazy tree rooted at `/`: opening a folder requests only that directory, dotfiles remain visible, and selecting a regular file downloads it. Headless Tree supplies keyboard and screen-reader tree behavior, while TanStack Virtual keeps directories such as `/nix/store` from creating tens of thousands of DOM rows. The tree remains mounted when another drawer tab is selected, so open folders and the current path survive tab switches.

Each Pi runtime also loads `server/thread-context.ts`. On a new thread's first request, the extension puts waiting machine alerts directly into model context and removes the consumed inbox files once the run starts. There is no thread-initialization tool. The extension treats process or model changes as continuation rather than a new thread. It also tells the agent how to offer downloadable files. A `<pi-remote-file src="/absolute/path" />` tag becomes a normal link in both clients, or an inline image linked to the original when the file has an image extension, and the session-scoped endpoint streams the file from the thread's host. It also describes [background inline images](docs/inline-images.md): assistant replies declare image prompts with thread-scoped IDs and optional image references. The supervisor owns generation and dependency ordering after the agent finishes. Both clients show a generating placeholder, the finished image or an error.

The globally loaded `server/context-mirror.ts` also registers [`server/session-history.ts`](server/session-history.ts) before checking Remote ownership. Remote and fleet sessions receive generated JSON metadata with their current JSONL path and the existing [`read-thread` command contract](../../tools/read-condensed-session/README.md). This system metadata omits the changing branch leaf, keeping the prompt prefix stable as the conversation advances. The extension reads `read-thread --contract` once per instance; the reader generates that JSON and its own `--help` from the same source. The metadata uses the reader's exported `pi-stored-jsonl-history` marker and contains no separate behavioral policy. `read-thread self` and explicit JSONL paths need no supervisor database. Titles and ids use the local Remote store when available. Default reads follow the newest stored parent chain, including history before compaction; `--leaf ID` selects a specific branch, `--all --raw` exposes all complete stored records, and `--search` returns bounded excerpts with original line numbers. The reader needs no VCC cache and leaves stored JSONL unchanged. The display projection does not infer compaction from synthetic user text.

The supervisor names a thread after its first user message and updates the name every 20 user or assistant messages. It gives the latest 12 messages to a short-lived, tool-free `pi --print` process and applies the process's first output line to both the Pi session and the supervisor database. `PI_REMOTE_THREAD_NAMING_MODEL` is required and must explicitly select an OpenAI provider, model, and thinking level, such as `openai-codex/gpt-5.6-luna:low`. Numbered OpenAI account aliases from the shared pool are also accepted, for example `openai-codex-12/gpt-5.6-luna:low`.

Model menus, autonomous-agent labels, and plan cards use the catalog exported by `pi-orchestrator/api`. Plan cards project the orchestrator's account and meter facts; Pi Remote carries no provider usage parser or duplicate provider manifest. New Astra threads start in OpenAI's priority service tier. Existing threads keep their saved mode, and other models start in normal mode.

## Compaction recovery

`/compact` uses Pi's compact RPC command, not a model-facing user message. Remote saves and returns its HTTP 202 admission receipt before waiting for completion. Reusing the same request ID returns the saved receipt without dispatching again. The runtime owns the operation deadline; supervisor handoff does not resend it. Compaction events report success or the concrete failure, and the work receipt retains that error even when Pi subsequently aborts its next assistant response.

The [native Codex extension](../../packages/runtime/extensions/codex-compaction/README.md) keeps failed and interrupted attempts in the session JSONL. It blocks automatic resubmission until `/compact` succeeds or the caller selects another model. This prevents the repeated three-minute aborts seen on September 12. An unconfirmed RPC outcome stays with the running session; Remote reconciles its state rather than declaring it idle and starting another compaction.

## Subagent custody

[Agent cores](../../docs/agent-cores.md) own new native child delegation. Pi uses the [shared Codex-derived delegation guidance](../../packages/orchestrator/docs/delegation-policy.md); Codex uses its native delegation tools and policy. Remote observes children and sends inspection, steering and cancellation commands through the core adapter. Voice keeps its separate backend-handoff policy.

The external parent/child thread API and its existing delivery records below remain owned by Remote. They are separate from a core's native agent tree. Core-hosted Pi sessions do not register the external `thread_delegate` tool.

`thread_read` reads another thread by title or ID, with paginated conversation/actions and full-entry chunking. `thread_subagents` lists a thread's direct children by most recent message, with `includeIdle`, `limit` and `cursor`. Both are available to root agents and children. Idle and archived children remain discoverable through the list tool without appearing in the frontend's active cards. The [session reader](../../tools/read-condensed-session/README.md#native-thread-tools-and-pages) owns the matching shell commands, cursor rules and transcript parsing.

Only root coordinators can delegate. Subagent runtimes do not register `thread_delegate`, and the Remote API rejects nested delegation with HTTP 403. Fleet children are not coordinators, including Astra and Sol children, so their dispatch API and tool registration also reject nesting. Remote coordinators dispatch through `thread_delegate`. Astra, Sol, Terra and Luna are available to subagents independently of the interactive destination's menu. A matching child can receive another task; selecting a different model creates another child. An explicit `threadId` with a different model returns HTTP 409. Each child retains its parent's workspace and meeting association, so personal mounts and the Meet transcript/browser handoff remain available.

The supervisor's `subagents` table owns the parent and selected model. Settings cannot change that model, and recovered runtimes receive the same selection. Existing delegated threads acquire their identity from their first recorded delegation. Completion commits `delegation_results` with the work item's terminal state, before result delivery. The relay atomically inserts a parent steering work item and saves its ID in `thread_delegations.reply_work_id`. A busy parent receives the result after its current tool calls, without ending its turn. Adoption changes pending automatic replies to steering without changing human follow-up preferences. Restarting either runtime or the supervisor retains both the result and its delivery receipt. Interrupted coordinators also receive the IDs and states of delegations accepted during their interrupted request, including a dispatch whose HTTP response was lost. An archived parent holds its results until restored. A settled child releases its runtime after its final context is saved and queued work is empty; its transcript remains resumable. Archiving during startup cancels and reaps the starting runtime host instead of leaving an unconnected runtime or detached process behind. Results include the originating work ID, selected model, outcome and output, with transcript access when output exceeds 32,000 characters.

## PiStack Meet

The thread header's centered camera icon beside the settings gear opens `/meet.html`. Meet keeps each person's camera and microphone separate, connects the room to the shared PiStack Voice service, publishes a camera dashboard of Kenan and worker activity, and shares an agent-controlled browser. Local recognition saves speaker-labelled transcripts in the person's supervisor database. The server delivers each worker's missing transcript after flushing unfinished speech; follow-ups reuse existing threads. The host tab owns the Voice connection and stays open for the meeting. The same renderer, Voice, transcription and delegation code builds into `meet-adapter.js` for Converge's thin Recall/calendar wrapper. Its mixed input is explicitly labelled. [Meet operations and adapter contract](docs/meet.md) covers media, module bootstrap, browser control, configuration and cleanup.

## Idle notifications

The drawer's **Enable notifications** button asks for notification permission and disappears once notifications are enabled. Both clients then monitor every configured environment, not just the selected one. Notifications use the Kenan head artwork and name the environment and thread. Tapping one selects that environment and opens the thread. Viewing a thread clears its notifications and suppresses new ones while it stays visible. Backgrounding the app restores delivery. Other threads, environments and people are unaffected. Browser tabs share visible-thread locks and broadcast dismissal to each other; Android's activity lifecycle and notification service share the selected thread.

The supervisor commits an `idle_notifications` row in the same SQLite transaction that changes a session from RUNNING or ABORTING to IDLE. Opening an idle runtime, repeated idle updates, and supervisor startup do not create notifications. A queued follow-up keeps the session RUNNING until its work settles. `GET /v1/notifications` establishes a cursor without replaying history; `?after=CURSOR` returns up to 100 later transitions. The feed includes its environment identity. The [feed implementation](server/notifications.ts) and [schema](server/database.ts) own this contract.

Clients poll each environment independently every five seconds and retain separate cursors for each person and environment. An unavailable host does not stop another host's notifications. Reconnection replays transitions since the saved cursor, including sessions that completed entirely while the client was disconnected. Locked environments report that they need unlocking rather than asking for a key in the background.

Android's [notification service](../kenan/android/app/src/main/java/works/kenan/piremote/kenan/IdleNotificationService.java) runs outside the WebView and keeps an ongoing monitoring notification with connection status. Environment selection does not close other environments' SSH tunnels. Cursors live in app-private `idle-notifications` preferences. Android may delay delivery during network loss or device sleep; force-stopping the app stops monitoring until it is opened again. The browser monitors while its page is open and executing, with cursors in localStorage and Web Locks preventing duplicate delivery across tabs. Browser suspension delays delivery until the page resumes. Neither client requires a third-party push service.

## Requirements

- [Bun](https://bun.sh/), `jq`, and `gocryptfs` for encrypted folders
- Node.js and util-linux `flock` on the supervisor's `PATH`, and the pinned Pi SDK in the deployed dependency tree
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

The `environment` map accepts ordinary process variable names, including host runtime settings such as `NX_NATIVE_FILE_CACHE_DIRECTORY`. Values become process environment variables before the supervisor loads. Existing process variables win. Arrays and objects are JSON-encoded automatically. All persons on a machine must agree on the environment id and name.

The built-in Home destination and new persons' Personal and Home destinations default to Astra at `high` thinking. Their model menus offer Astra, Sol, Terra, Luna, Fable, and Opus. Both startup paths use [`server/thread-model-defaults.ts`](server/thread-model-defaults.ts).

Existing persons' `PI_REMOTE_THREAD_DESTINATIONS` remains authoritative. Each destination sets `models`, `defaultModel`, and `thinkingLevel`; deployment does not rewrite these saved choices. Changing a destination affects new threads, not the model or thinking level saved on existing threads. Autonomous lane profiles are separate Orchestrator configuration.

Each Pi thread starts with a 30-minute maximum for foreground bash calls. Its Thread settings panel can change that limit to 60 seconds, 5 minutes, or half an hour. Pi Remote stores the choice with the thread and restarts its idle runtime so the next agent request receives the new limit. Codex uses its native command execution and does not accept this Pi-specific setting.

### The front door

The front door listens on the published port (8788), holds no state and no keys, and hands each request to the right supervisor. Identity is the `x-pi-remote-user` header, which the web client and the Android app send once a person has been chosen, or the `user` query on a navigation that cannot carry a header (a download link opened in a tab or saved from its context menu; the client names the person in every link it builds to the API); a machine with one person needs no name. The folders are what protect anything worth protecting, and they are open exactly while their owner is working, so a name on a request grants nothing a key does not already grant.

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

A reload of a supervisor unit replaces the supervisor process immediately. Shared runners remain in the same service cgroup and mount namespace, so active sessions finish their turns and the replacement supervisor reconnects their RPC streams in parallel. Health and saved thread state remain available during that reconnection; an action that needs a runtime waits for it to finish. Once an adopted session settles, the supervisor replaces it before its next use so provider and extension changes take effect. A release handoff can temporarily retain the preceding runner generation until its active turns finish. Stopping the unit still kills every process and destroys the private mount. The encrypted ledger backup runs in an owned worker on a separate SQLite connection. It retains the last good snapshot on failure and reuses snapshots younger than six hours across restarts. Copying a large database cannot block the supervisor's runtime-attachment deadlines or client requests.

## Test

```sh
bun test server/*.test.ts web/*.test.ts
npm run android:test --workspace=kenan
```

## Security boundary

Bind the service to loopback or a private network. Direct endpoints rely on deployment-layer network access. SSH endpoints pin the server host key and carry their private identity in the local Android build. Unlock keys stay in Android's private preferences and never enter the JSON server configuration.

## License

MIT
