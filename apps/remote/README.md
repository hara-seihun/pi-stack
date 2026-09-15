# Pi Remote

A self-hosted web and Android controller for persistent [Pi](https://pi.dev) coding-agent threads.

Pi Remote presents and controls persistent [unified threads](../../docs/threads.md). Orchestrator's `ThreadService` owns thread state, durable input, settings, cancellation and parent notifications. Pi owns each native session and its JSONL history. A front door starts one Remote supervisor per person, and a person's private directory is mounted only while she has unlocked it.

The supervisor creates one person-owned thread service over `PI_REMOTE_DATA/threads.sqlite3`. Its existing `/v1/sessions` routes translate client operations into the common `/v1/threads` API used by humans, model tools and the CLI. A configured fleet service joins that directory as another authorized owner. Local and fleet threads use the same drawer rows, conversation view and controls. Remote does not read a fleet database or keep another execution registry.

`PI_REMOTE_DATA/supervisor.sqlite3` contains Remote presentation and feature state. This includes drawer order, unread markers, context-display patches, bounded events, uploads, inline images, meeting receipts, notification cursors and error dismissals. Server-owned error feedback has occurrence IDs and durable acknowledgements through `POST /v1/errors/:errorId/dismiss`. Dismissal removes the current feedback from synchronized clients without rewriting failure history or treating the underlying operation as successful. The [client contract](web/README.md#dismissible-errors) covers acknowledgement failures and renewed errors. It is not a conversation journal or an execution queue. Native Pi JSONL and the owning thread database remain authoritative.

Many Pi sessions share one Node runner inside each Unix-person, execution and application-isolation boundary. Each session retains its own cwd, environment, native file and runtime socket. The runner admits at most 64 resident sessions by default through `PI_THREAD_MAX_ACTIVE_SESSIONS`, keeps four slots available to forced work, stops admission at 6 GiB RSS through `PI_THREAD_RUNNER_MAX_RSS_MB` or 80% of a cgroup memory ceiling, and leaves excess work queued with its thread owner. Cgroup admission subtracts reclaimable `inactive_file` cache from the working set. Idle settled sessions unload without losing their thread or history. Each runner has an 8 GiB V8 heap ceiling. Browser and shell subprocesses remain separate and count toward the service's memory budget.

The [Pi session adapter](../../packages/orchestrator/docs/pi-sessions.md) preserves Pi's RPC command and extension UI contract. The runtime's [session durability patch](../../packages/runtime/README.md#session-crash-durability) syncs each complete JSONL mutation through gocryptfs before Pi treats it as stored, and rewrites are atomic. Stable native input and settlement receipts let the thread owner recover accepted work without replaying completed work.

Thread settings GET reads the durable thread's accepted model, thinking and speed plus native pooled-provider model metadata. Child listing uses its separate endpoint, so a child-directory failure cannot prevent loading or saving settings. It does not open a Pi session, inspect a workspace, acquire model admission or publish context. PUT validates the whole request before changing settings and returns the thread owner's result, without a follow-up native read. Held messages keep valid accepted settings and remain held; viewing or changing settings does not resume them. Selecting an explicit model repairs only undispatched messages with invalid model IDs, preserves their accepted thinking and speed, and records the previous model in the thread's `modelSettingsRepairs` provenance. A model change selects the next execution and does not rewrite the running execution's model or pooled-account attribution. Thinking and speed changes apply to a running session only when its actual model matches the saved selection; each acknowledged change updates only that field in the execution record. The picker offers the six supported catalog models using the same native provider definitions and custom Fable definition as routing. A saved model outside that list is appended as a selectable option, with its native capabilities when available or its saved thinking level otherwise. Numbered pooled provider aliases resolve to the same canonical identity as the options. A partial write failure states whether thread settings were saved but the running session did not apply them, or whether the later bash-timeout update was not confirmed. Native account authentication and quota admission happen when execution needs them, not when opening the tray.

The [runtime event projection](docs/runtime-wire.md) keeps live text, thinking and bounded tool previews for display. These fields cannot admit or settle work. Native history stays complete, and selecting or reading an unloaded thread does not start it.

Runner output uses one backpressured disk spool beside each session socket. Reconnection starts at the acknowledged sequence, discards partial frames and does not resend commands. A controller handoff detaches its channel while accepted work stays in the runner; the replacement opens the same thread and replays unacknowledged output. Once all sessions close, the runner exits after five seconds. Control sockets live under `thread-runners/`, and session sockets live under `thread-sockets/` in the owner's data directory.

Every runner starts under `flock --no-fork` with a lease beside its control socket. Only the process holding that kernel lease can reclaim a stale endpoint. A slow or reset connection is not proof of death and does not authorize a second owner. Retrying an uncertain open uses the same boundary and thread address.

The interactive view is Pi's provider-neutral model context, not a transcript reconstructed by Pi Remote. Pi Remote is installed as the final Pi package so `server/context-mirror.ts` runs after every other `context` handler. It stores the effective system prompt, active tool schemas, and `convertToLlm()` messages at durable message boundaries. Only the owning RPC process publishes context; its `PI_REMOTE_CONTEXT_OWNER_PID` marker prevents nested Pi processes from inheriting ownership, and print/JSON/TUI diagnostics never publish into the parent thread. The supervisor resets that marker when starting an intentional Remote runtime. Live assistant text takes a separate in-memory path and wakes clients on the first delta, then at most once per 16 milliseconds. This avoids rewriting and hashing the full model context for every token. When a message ends, the supervisor keeps its final live text visible until the context mirror acknowledges the durable replacement containing that message. The mirror retries the latest unacknowledged document across transient request failures instead of dropping it. Ordinary message boundaries send a verified byte splice when it is smaller than a complete document; unchanged captures need no request unless a finalization acknowledgement is pending. Compaction always sends a complete replacement. [`server/context-journal.ts`](server/context-journal.ts) checkpoints before a chain reaches 32 patches, 1 MiB of inserted data, or a quarter of the document size. Cold reads assemble the persisted patches before copying and verifying the final document, rather than repeatedly copying unchanged images. Session startup, compaction, and tree navigation replace the durable context from Pi's current session branch immediately. A successful compaction must acknowledge that replacement before the server will keep any context visible. If capture fails, the server clears the old document rather than show messages Pi removed. Loaded AGENTS.md content appears inside the system prompt Pi received. The shared client renders the context whole.

Remote's HTTP mirror is the sole persistent context writer for its sessions. The runner still emits `context_update` for ThreadService inspection, marked `contextOwner: "remote-mirror"`; the supervisor does not persist that observation again. Sessions without a Remote mirror keep runner-owned capture. Two independent writers previously raced on September 14, 2026: a runner observation advanced the stored capture by two milliseconds, and the HTTP mirror retried its superseded snapshot indefinitely, blocking the native turn and Stop. An acknowledgement carrying a different hash at the same or a later capture time now supersedes the pending snapshot. The mirror discards its patch base and advances its clock before the next boundary. A mismatched hash without a superseding timestamp remains an integrity error.

The browser and Android client synchronize through a resumable long poll rather than a timer. They request a display projection that omits provider continuation metadata while canonical API context stays untouched. Inline images remain in canonical model context but become content-addressed image URLs in the display document. The image endpoint reads from that thread's current context, serves the original bytes with immutable private caching, and returns 404 after the image leaves the current context. Tool-result images load when their card opens, rather than travelling inside every transcript update. Collapsed tool output also mounts only its visible text preview. On the September 7 commercial-thread snapshot, this reduced the display document from 16,029,997 to 358,221 bytes, and its gzip body from 11,891,693 to 107,060 bytes. These are payload measurements, not phone latency measurements. A later 16,247,013-byte canonical snapshot needed a 356-byte splice for a representative appended message. Restoring 31 small patches over that image-heavy base took 18.8 ms with shared byte ranges, versus 653 ms when rebuilding and hashing every intermediate document.

Synchronization commits the section versions only after all document updates verify. A failed patch retains the displayed text and requests complete documents and sections on the next attempt. Selection, foregrounding, restored connectivity and Reconnect interrupt the current operation immediately, including native setup or a transport that never settles. Every synchronization attempt has a 35-second deadline and a bounded retry delay. The connection state shows SYNCING during selection and OFFLINE with Reconnect after a failure. A late cache read cannot replace an authoritative empty context. The router propagates disconnects to the supervisor, and a thread's long poll ignores live-token wakeups from other threads. Server patch history has global byte and entry limits; it no longer retains repeated full canonical image documents.

Context and live output travel as SHA-256-verified byte splices against each client's last projected document, with gzip for complete snapshots. The response is divided into versioned sections: thread state carries the supervisor's version, the drawer dashboard carries its own, and the selected thread's context and live text are compared by hash on every request. A client echoes the versions and hashes it rendered and receives exactly the sections that moved, so a token wake never withholds a newly selected thread's transcript and a governor or ambience toggle reaches every client without that client patching its own copy. `server/protocol.ts` is the single definition of those shapes for the supervisor and both clients. The identity router remembers a healthy supervisor instead of spawning `systemctl` for every API call.

The [shared web client](web/README.md) owns person-session handling and endpoint selection for browsers and Android. The browser interface is a React 19 and TypeScript application built by Vite. Sessions, context entries, messages, tool calls, plan rows, and machine controls have stable keys, so a synchronization response updates the changed properties without detaching the rest of the page. Consecutive system, thinking, tool, and status boxes appear as one collapsed "Agent details" box between user and assistant messages. Its box count grows with the work, and selecting it reveals each original box. When a details group is the newest transcript item, its latest box remains visible below the collapsed heading so the agent's current work stays in view. Live model text is isolated from the durable transcript and renders as Markdown while it streams. Each chunk is completed into a document that parses the way the finished one will, and the result is patched into the existing nodes rather than written over them, so a message never flips between source and rendered form and every existing SVG, selection, expanded tool card, and button stays mounted while unrelated state changes. Compiled formulas are remembered, so re-rendering a growing message does not run KaTeX over the part the reader has already seen. The composer grows with typed, pasted, restored, or wrapped text through six rows, then scrolls.

Every rendered message and live model block has a copy action. A finalized user message also has an edit action: while the thread is idle, Pi forks immediately before that message, the supervisor adopts the forked session file as the thread's current history, and the client places the original text in the composer without sending it. The client retains 32 verified documents in app-private IndexedDB across process restarts and reads them before the first network response for a thread. A cold view renders the latest 60 user messages, assistant messages, and collapsed detail groups first, then pages older items on request. Reverse-column layout keeps the latest entry at the bottom, while native scroll anchoring holds the visible message still when content grows below it. A delayed pointer gesture turns an active thread row into a drag target; dropping it saves the new drawer order in SQLite. Slash-command discovery waits until the composer starts with `/`, so browsing an idle thread never starts its Pi runtime. A queued follow-up can steer after the current tool call, hard steer by cancelling the current execution and its local tools before sending the chosen message first, return to the composer, or be cancelled.

The New Thread picker keeps its destination and model choices open across dashboard updates. Tapping anywhere except a picker button dismisses it, including the gaps between choices, without activating the control underneath. Creation shows a pending state, and a failed request stays visible with Retry. The [picker state machine](docs/state-machine.md#new-thread-picker) owns these transitions in both clients.

The drawer reports only measured plan and hardware rows. Each plan row also carries how much of that model's prompt tokens came from the provider's cache over the last 24 hours, read from the orchestrator's usage ledger; a model nobody called in that window shows nothing rather than a zero. CPU sampling runs independently of client polling. Endpoint connections pass through the authenticated router; Android opens no SSH tunnels.

[`apps/kenan`](../kenan/README.md) packages the same compiled React client with Capacitor as the Kenan Android app. The shared client owns endpoint selection. A small native plugin owns session-aware notification transport, haptics and system-bar layout. Its build embeds only `piRemoteRouterUrl`. Both clients fetch `/v1/environments` after authentication. The router combines the host's catalog with the person's `remoteAccess` grants, as described in [deployment](../../docs/deployment.md#gateway-access-and-host-boundaries). Adding a host does not grant every person access to it.

The Android drawer shows Update app only when the bootstrap router advertises a newer installed-package version. The native client downloads the APK, checks its hash and opens Android's installer. App updates do not depend on a person being unlocked. Both hosts serve the same package through the [publication workflow](../../docs/deployment.md#kenan); the browser client has no APK update button.

The bottom-right composer button shows a square stop icon while its thread is running and the text box is empty, including admission, startup and unconfirmed cancellation. Typing a non-whitespace message switches it to the send icon; submitting queues that message without stopping the thread. Clearing the text restores the stop icon. Uploads do not hide Stop, but must finish before sending. The control request disables the button without adding a lifecycle state. Confirmed stop returns it to Send; a cancellation error leaves Stop available when the text box is empty. Stopping keeps attachments. Threads with children ask whether to stop those children too.

Paste opens a modal text-document editor above the app. Attach uploads the document to the thread that opened it without sending a message. Upload failures keep the editor and pasted text open for retry; the error can be dismissed.

Drop files anywhere in the client window to attach them to the open conversation's draft. A window-wide overlay names the destination. Dropping never sends a message. Attachments stay with their conversation when switching threads, including while an upload is running.

The paintbrush beside Attach and Paste opens white paper. Tapping an image in an interactive conversation opens that image in the same drawing editor, fitted to the screen. This includes generated images, Markdown images and expanded tool-result images. Drag with a mouse, finger or pen to draw. Two fingers pan, zoom and rotate the paper; the mouse wheel zooms around the pointer. Brush radius stays at 1% of the viewport's shorter side, so zooming in produces finer strokes.

Both entry points have Cancel, Undo, a colour picker and Done. Undo removes the latest stroke without changing the background or view. Cancel or Escape returns to chat without attaching anything. Reopening the same image or white paper restores its unfinished drawing; drafts belong to their thread and remain separate from one another. The composer is hidden while drawing.

Done attaches a PNG to that thread's message draft without sending it or changing the original file. Image edits export the whole background and its strokes at the image's original pixel dimensions, regardless of the current pan, zoom or rotation. An unchanged image can also be attached; empty white paper just closes. Loading and export failures appear in the editor, and a failed upload retains the drawing for retry. A successful attachment clears that editor draft. Reloading clears unfinished drawings. Browser and Android use the same component.

Enter sends the composer only where a hardware keyboard is typing. On touch devices the media query `(hover: none) and (pointer: coarse)` matches, Enter inserts a newline, the key is labelled as a return key, and the send button submits. Phone keyboards have no comfortable way to type a newline otherwise, so sending on Enter cost multi-paragraph prompts.

The drawer tabs show threads, Orchestrator, archived threads and host files. Orchestrator lists fleet threads and children from the same thread directory. Its tab count includes only active threads; inactive threads remain available in the collapsed section. A selected thread links to its parent. Its right panel shows active direct children, with inactive children in a collapsed section. Each row opens the same conversation view regardless of owner. If a peer owner is unavailable, Remote retains its last listing and reports that owner's error without changing local thread state.

The Files tab is a lazy tree rooted at `/`: opening a folder requests only that directory, dotfiles remain visible, and selecting a regular file downloads it. Headless Tree supplies keyboard and screen-reader tree behavior, while TanStack Virtual keeps directories such as `/nix/store` from creating tens of thousands of DOM rows. The tree remains mounted when another drawer tab is selected, so open folders and the current path survive tab switches.

Each Pi runtime also loads `server/thread-context.ts`. On a new thread's first request, the extension puts waiting machine alerts directly into model context and removes the consumed inbox files once the run starts. There is no thread-initialization tool. The extension treats process or model changes as continuation rather than a new thread. It also tells the agent how to offer downloadable files. A `<pi-remote-file src="/absolute/path" />` tag becomes a normal link in both clients, or a tappable inline image when the file has an image extension, and the session-scoped endpoint streams the file from the thread's host. It also describes [background inline images](docs/inline-images.md): assistant replies declare image prompts with thread-scoped IDs and optional image references. The supervisor owns generation and dependency ordering after the agent finishes. Both clients show a generating placeholder, the finished image or an error.

The globally loaded `server/context-mirror.ts` also registers [`server/session-history.ts`](server/session-history.ts) before checking Remote ownership. Remote and fleet sessions receive generated JSON metadata with their current JSONL path and the existing [`read-thread` command contract](../../tools/read-condensed-session/README.md). This system metadata omits the changing branch leaf, keeping the prompt prefix stable as the conversation advances. The extension reads `read-thread --contract` once per instance; the reader generates that JSON and its own `--help` from the same source. The metadata uses the reader's exported `pi-stored-jsonl-history` marker and contains no separate behavioral policy. `read-thread self` and explicit JSONL paths need no thread database. Titles and IDs use the owner thread database, selected by `PI_THREAD_DATABASE` and then `PI_REMOTE_DATA/threads.sqlite3`. Default reads follow the newest stored parent chain, including history before compaction; `--leaf ID` selects a specific branch, `--all --raw` exposes all complete stored records, and `--search` returns bounded excerpts with original line numbers. The reader needs no VCC cache and leaves stored JSONL unchanged. The display projection does not infer compaction from synthetic user text.

The supervisor names a thread after its first user message and updates the name every 20 user or assistant messages. It gives the latest 12 messages to a short-lived, tool-free `pi --print` process and applies the process's first output line to the owning thread record. `PI_REMOTE_THREAD_NAMING_MODEL` is required and must explicitly select an OpenAI provider, model, and thinking level, such as `openai-codex/gpt-5.6-luna:low`. Numbered OpenAI account aliases from the shared pool are also accepted, for example `openai-codex-12/gpt-5.6-luna:low`.

Model menus, thread labels and plan cards use the catalog exported by `pi-orchestrator/api`. The thread picker shows Sol as ☀️, Astra as ⭐, Fable as 🪶, and Opus as 🎨. Plan cards project the orchestrator's account and meter facts; Pi Remote carries no provider usage parser or duplicate provider manifest. New Astra threads start in OpenAI's priority service tier. Existing threads keep their saved mode, and other models start in normal mode.

## Compaction recovery

`/compact` uses Pi's compact RPC command, not a model-facing user message. Remote saves and returns its HTTP 202 admission receipt before waiting for completion. Reusing the same request ID returns the saved receipt without dispatching again. The runtime owns the operation deadline; supervisor handoff does not resend it. Compaction events report success or the concrete failure, and the work receipt retains that error even when Pi subsequently aborts its next assistant response.

The [native Codex extension](../../packages/runtime/extensions/codex-compaction/README.md) keeps failed and interrupted attempts in the session JSONL. It blocks automatic resubmission until `/compact` succeeds or the caller selects another model. This prevents the repeated three-minute aborts seen on September 12. An unconfirmed RPC outcome stays with the running session; Remote reconciles its state rather than declaring it idle and starting another compaction.

## Thread relationships and delegation

Pi uses the [shared Codex-derived delegation guidance](../../packages/orchestrator/docs/delegation-policy.md). Voice keeps its separate backend-handoff policy. There is no Remote-only delegation API or Pi-owned child tree.

Every ordinary thread receives the same model-facing operations. `thread_spawn` creates a fresh persistent subthread, while `thread_send` continues an existing thread. `thread_list` can list the current environment or direct subthreads, `thread_read` pages native persisted history without starting the target, and `thread_control` stops, resumes or changes settings on a selected thread, including thinking level. Nested threads retain these tools. The [session reader](../../tools/read-condensed-session/README.md#thread-pages) documents matching shell pages and cursor rules.

Parentage is durable thread metadata used for discovery and completion notifications. A subthread has its own execution state, native session and settings. Its state never rolls up into its parent. When its execution settles, the thread service commits the outcome and a stable parent-message receipt together. A busy parent receives that message after its current tools, an idle parent wakes, and a stopped parent holds it. The notification includes thread and work IDs, the outcome and the final assistant message or an explicit absence.

## PiStack Meet

The thread header's centered camera icon beside the settings gear opens `/meet.html`. Meet keeps each person's camera and microphone separate, connects the room to the shared PiStack Voice service, publishes a camera dashboard of Kenan and worker activity, and shares an agent-controlled browser. Local recognition saves speaker-labelled transcripts in the person's supervisor database. The server delivers each worker's missing transcript after flushing unfinished speech; follow-ups reuse existing threads. The host tab owns the Voice connection and stays open for the meeting. The same renderer, Voice, transcription and delegation code builds into `meet-adapter.js` for Converge's thin Recall/calendar wrapper. Its mixed input is explicitly labelled. [Meet operations and adapter contract](docs/meet.md) covers media, module bootstrap, browser control, configuration and cleanup.

## Idle notifications

The drawer shows an IDLE status in green when a running thread has finished and the person has not viewed it. Selecting that thread in a visible client clears the stored unread marker, so every client returns the status to muted.

The drawer's **Enable notifications** button asks for notification permission and disappears once notifications are enabled. Both clients then monitor every endpoint granted to the authenticated person, not just the selected one. Only interactive conversation roots produce notifications. Child threads and all Orchestrator fleet threads remain silent; their drawer unread indicators still work. Notifications use the Kenan head artwork and name the environment and thread. Tapping one selects that environment and opens the thread. Viewing a thread clears its notifications and suppresses new ones while it stays visible. Backgrounding the app restores delivery. Other threads, environments and people are unaffected. Browser tabs share visible-thread locks and broadcast dismissal to each other; Android's activity lifecycle and notification service share the selected thread.

Each authorized thread owner exposes a sequenced settlement feed. The supervisor stores one cursor per owner and commits notification receipts with that cursor, so replay cannot mark a viewed thread unread again and one owner's cursor cannot skip another owner's completion. `GET /v1/notifications` establishes a client cursor without replaying history; `?after=CURSOR` scans up to 100 later transitions and returns only threads owned by that person's supervisor with no parent. Filtering at delivery also suppresses worker completions stored before this policy took effect, including after a client reconnects. The cursor advances past suppressed transitions even when a page has no notifications. The feed includes its environment identity. [`server/thread-notifications.ts`](server/thread-notifications.ts), the [feed implementation](server/notifications.ts) and the [schema](server/database.ts) own this contract.

Clients poll each environment independently every five seconds and retain separate cursors for each person and environment. An unavailable host does not stop another host's notifications. Reconnection replays transitions since the saved cursor, including sessions that completed entirely while the client was disconnected. Locked environments report that they need unlocking rather than asking for a key in the background.

Android's [notification service](../kenan/android/app/src/main/java/works/kenan/piremote/kenan/IdleNotificationService.java) runs outside the WebView and keeps an ongoing monitoring notification with connection status. Every native poll authenticates through the router; environment selection does not change the person session. Cursors live in app-private `idle-notifications` preferences. Android may delay delivery during network loss or device sleep; force-stopping the app stops monitoring until it is opened again. The browser monitors while its page is open and executing, with cursors in localStorage and Web Locks preventing duplicate delivery across tabs. Browser suspension delays delivery until the page resumes. Neither client requires a third-party push service.

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

The registry file is the whole per-person configuration. Its `environment` object is what the supervisor loads as `PI_REMOTE_CONFIG`, so edit it to change workspaces, thread destinations, models, the data directory, or the orchestrator ledger path; the front door reads it again on restart. `port` is the supervisor's UID-gated loopback port, and `unlock` names the crypt directory and mountpoint when the folder is encrypted. Optional `remoteAccess` lists allowed endpoint IDs. Omission grants only this host's own endpoint. The list must include this host's ID. Remote grants require an encrypted-folder identity and a per-person supervisor origin in the host catalog's `upstreams` map; an absent mapping is a startup error.

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

Session admission resolves configured workspace IDs to absolute directories. Configuration rejects relative or missing workspace roots. An absolute session cwd must resolve inside one of those roots, including after following symlinks. Unknown relative IDs such as `sibyl` are errors, never paths relative to the supervisor. Invalid saved sessions cannot start or resume work. Repair their `sessions.workspace_id` to the intended configured workspace ID while that person's supervisor is stopped; do not guess a directory from an obsolete spelling. Native Pi child workspaces and Unix filesystem permissions retain their own enforcement boundaries.

Existing persons' `PI_REMOTE_THREAD_DESTINATIONS` remains authoritative. Each destination sets `models`, `defaultModel`, and `thinkingLevel`; deployment does not rewrite these saved choices. Changing a destination affects new threads, not the model or thinking level saved on existing threads. Autonomous lane profiles are separate Orchestrator configuration.

Each Pi thread starts with a 30-minute maximum for foreground bash calls. Its Thread settings panel can change that limit to 60 seconds, 5 minutes, or half an hour. Pi Remote stores the choice with the thread so its next execution receives the new limit.

### The front door

The front door listens on published port `8788` and owns person-bound router sessions. `POST /v1/unlock` accepts `{key}` and the `x-pi-remote-user` selection hint, validates the unlock and returns a session. Clients authenticate with `x-pi-remote-session`. A user header or query is never authority, including on a single-person host. This explicitly supersedes the previous name-only identity claim: an already-open folder does not let a named request use its supervisor. Protected `/v1/*` calls without a session return `423`.

Public routes are the `/v1/environment` chooser, `/v1/router-health`, app updates and static assets. Unlock bootstraps authentication. Authenticated `GET /v1/environments` returns only that person's allowed endpoints. The host catalog owns IDs, names and optional icons, with remote `upstreams` keyed by person. The own-host entry has no upstreams; remote values are absolute HTTP or HTTPS supervisor origins without paths, credentials, queries or fragments. Clients receive an empty prefix for this host and generated `/v1/remotes/<id>` prefixes for remotes. The gateway authorizes each route and strips client authentication and person hints before forwarding to the configured supervisor. Endpoint names contain no access logic.

A person with an encrypted folder has a supervisor only while her key is in memory. Her unit runs with `PrivateMounts=yes`; [`server/pi-remote-launch`](server/pi-remote-launch) mounts the folder inside that namespace and then becomes the supervisor, so every Pi thread she runs sees an ordinary directory and nothing else on the machine sees anything. The key reaches the unit as a systemd credential from a root-only tmpfs file that the front door writes on unlock and removes on lock. Stopping the unit destroys the namespace, the mount, and the key together. A wrong key fails the mount; the unit's start limit (five tries in a minute) is how the front door tells a wrong key from a slow one. Locking revokes all router sessions for that person as well as stopping her supervisor. Clients receiving `423` must reauthenticate before repeating a protected request.

A person without an encrypted folder starts with the front door. She still bootstraps a router session through `/v1/unlock` with an empty key; merely naming her does not authenticate. This is local guest access without identity proof. Router startup rejects remote grants for an unencrypted person.

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

A release handoff suspends thread dispatch, fences Remote callbacks and detaches runner channels. The supervisor refuses new client requests with HTTP 503 but keeps context PUT/PATCH ingestion available until idle Pi sessions finish their shutdown hooks, including final captures for archived threads. Only then does it close image publication, the HTTP listener and the presentation database. If cleanup fails, the supervisor reports the failure, retains context ingestion and allows another explicit activation signal to retry cleanup without reopening intake.

Shared runners remain in the same service cgroup and mount namespace, so accepted native execution continues. The replacement supervisor opens the same thread database and session files, then reconnects unacknowledged output. Stopping the unit still kills every process and destroys the private mount.

The encrypted ledger backup runs in an owned worker on a separate SQLite connection. It retains the last good snapshot on failure and reuses snapshots younger than six hours across restarts. Copying a large database cannot block thread handoff or client requests.

## Test

```sh
bun test server/*.test.ts web/*.test.ts
npm run android:test --workspace=kenan
```

## Security boundary

Publish only the router. Remove unauthenticated `/converge` and `/editor` host routes. Supervisor, forwarded upstream and control ports require loopback binding plus host UID gates; a loopback listener alone lets other local users bypass the router. Root-run deployment probes may read private supervisor health directly. Router smoke probes use existing root-only unlock credentials to mint sessions without putting credentials in process arguments. Host-owned tunnels forward to the matching person's remote supervisor, never a remote router. Android carries no SSH identity or endpoint catalog. Existing APKs still contain the previously distributed Converge SSH key; remove its `authorized_keys` grant and terminate its active forwards on the host. The gateway tunnel must use a separate server-owned identity. See [host boundaries and probe operations](../../docs/deployment.md#gateway-access-and-host-boundaries).

## License

MIT
