# Deployment

Submit an immutable source commit to the durable publication worker from a writer checkout:

```bash
deploy/publication submit "$(git rev-parse HEAD)"
```

The returned receipt acknowledges custody. The worker owns integration checks, merging `main`, both host deployments and terminal reporting. `deploy/publication inspect REQUEST` reads its progress. Failed requests retain their source ref, integration SHA, exact command arguments, working directory, deadline, compact error excerpt and full log. The owner assigns each new failure one dedicated local repair agent. Submitting the same SHA again returns its existing receipt or rejects an unrepaired failure. Blind `retry` is disabled.

A submission from Remote records its supervisor URL and root thread ID. The worker sends blocked, failed, cancelled and published results back to that thread with a stable request ID. Its receipt distinguishes `report.status: accepted`, when Remote has queued the report, from `delivered`, when the thread's user event confirms dispatch. The timer retries transport failures and checks accepted reports without rerunning publication. Machine alerts are a separate inbox receipt, not proof of thread delivery. Successful publication sends its report before the worker exits.

For an external caller, set `PI_STACK_PUBLICATION_REPORT_URL` and `PI_STACK_PUBLICATION_REPORT_SESSION` to the requesting supervisor and root thread UUID. Without a Remote context, the custody receipt explicitly selects `machine-inbox` reporting. To attach a requester to a request created before thread reporting was available, use `deploy/publication report REQUEST REMOTE_URL SESSION_ID`. `deploy/publication report REQUEST` reconciles reporting only; it never retries checks or deployment.

`deploy/publication install` installs the GMKtec worker and timer from this checkout. Its state lives at `~/.local/state/pi-stack-publication/`. The `unified-threads-v1` contract has a first-activation gate. Before waiting for old runners, publication records each host's fleet launch control in `request.maintenance.hosts`, then uses the deployed `pi-orchestrator pause` command. The pause survives blocked reconciles and worker restarts. An existing operator pause stays paused, including after successful deployment. The fleet daemon must be active and unmasked when publication takes custody.

Remote remains available while active work drains. The worker waits for native runners, fleet worker units and admitted fleet runs, including waiting parents and in-process completions. Once those clear, it stops the router and freezes the Remote supervisors and old fleet daemon. With admission unable to race the final census, it reads their active claims and checks both user and system worker units and remaining child processes. A busy census thaws the owners and restores the router, retaining only the fleet launch pause. Receipts identify the host, units, PIDs, run IDs and Remote claim IDs. The timer retries without model polling. Idle runner residency and open meetings can keep the gate blocked; publication never aborts them to force a release.

Only an empty final census permits stopping the old owners and invoking the host release wrappers. The importer transfers native transcript references, held messages, pending result notifications and presentation references without model calls. A fleet daemon already running ThreadService uses live handoff, including recovery from a partial two-host deployment. After either host adopts unified threads, publication refuses a target that removes the contract. Ordinary later releases preserve shared runners through controller handoff and do not take a maintenance pause.

Failure restores recorded service and fleet admission states. `deploy/publication cancel REQUEST` records a durable cancellation request, which the worker honors at the next command boundary without killing an in-flight deployment. Cancellation restores admission but leaves completed host releases selected. Restoration failures retain custody and are retried by the worker even for terminal requests. The first-activation deployment and full checks belong to publication. Request processing takes maintenance custody; installation only installs the worker and its timer.

The worker invokes each host's release wrapper, which calls [`deploy/prepare`](../deploy/prepare) and then `deploy/host`. `deploy/prepare` installs checkout dependencies, builds Orchestrator and Remote, and installs the runtime and transcription trees under the host and checkout locks but without the deployment deadline; every step is receipt-cached and touches no running service. `deploy/host` reads `/etc/pi-stack/host.json`, refuses a dirty checkout, holds the host and checkout locks, and must finish inside 50 seconds. Its own preparation then reuses the prepared results, so the deadline covers publishing, activation and smoke checks. On September 15, `PUB-9beb82e8ca4b412da6a4eebd` failed on Converge because a fresh build inside `deploy/host` consumed the whole budget; even a fully cached Converge release took 36 to 44 seconds before this split. Every artifact it publishes carries the commit in a `.pi-stack-commit` file; the deployed commit on a host is whatever `/srv/pi/pi-remote/.pi-stack-commit` says.

## Publication progress and repair

Enqueue syncs the request and a `wake` marker before acknowledging custody. It starts the worker immediately; the systemd path closes the filesystem wakeup path. The worker re-reads the queue after every request instead of stopping after one item. Both timers run every ten seconds to recover missed wakeups. No general fleet admission is involved.

[`deploy/publication-control.mjs`](../deploy/publication-control.mjs) owns the progress policy. Each subprocess records its exact command, arguments, directory, start and deadline before launch. The independent watchdog stops the publication cgroup after a command deadline plus 15 seconds, after 120 seconds without log progress, or after 90 seconds without a recorded step. It records the failed command before assigning repair. The command timeout also kills its process group; inherited output pipes cannot hold the watchdog. Request and worker locks prevent the watchdog from overwriting a live worker's receipt.

A failure does not automatically rerun publication. A contract gate can be revisited at 30-second intervals, with at most three publication attempts and a five-minute gate budget. Interrupted workers first restore any recorded host intake custody. Failed restoration blocks further deployments, retains the restoration plans and receives at most three recovery attempts before its repair owner must intervene. A proved infrastructure repair grants one further publication attempt. Attempt numbers and logs never reset.

Each new failure has `repairs/REQUEST/receipt.json`, a saved prompt, `session.jsonl`, `agent.log` and `result.json`. The receipt includes the original request, source and integration SHAs, command and log context, agent unit, registered workspace and terminal outcome. The watchdog launches `pi-stack-publication-repair@REQUEST.service` locally. That unit runs the installed Pi CLI with Astra High and normal Kenan model-account routing; it does not submit work to Remote, Orchestrator's paused fleet queue, or Converge. One repair agent runs at a time. It gets one 20-minute attempt, with a 22-minute unit ceiling including workspace creation and handoff. A failed service-start request gets at most three launch attempts. An interrupted agent is terminally blocked with its session and unit result retained, never replayed automatically.

The agent must return a cause/repair summary and a focused evidence file. A `source-fixed` result submits the corrected descendant commit with `submit SHA --repair-of REQUEST`. Its deterministic successor ID makes a repeated handoff idempotent. The successor names `repairOf` and `repairId`; the repair receipt records the successor's custody receipt. An `infrastructure-fixed` result queues the original request once with `repairedRetry` pointing to the evidence. The original failure stays in `failures`. A blocked result reports the remaining dependency. Two source-repair generations are allowed; further failures remain terminal for Hara to assign rather than growing an unbounded agent chain. Repair status and successor links participate in terminal thread-report idempotency keys. Transport retries run in the separate notices service and do not occupy the watchdog.

An interrupted repair can be completed without launching another model. Finish its registered workspace and write its existing `repairs/REQUEST/result.json` using the result contract above. Then run `deploy/publication repair-result REQUEST`. The command requires an inactive repair service and a failed request, preserves the interruption in `resultRecovery`, copies and hashes the evidence, and uses the same result acceptance and successor submission as the repair service. It never retries a published result, rewrites the original failure or launches a second repair agent. Repeating a completed handoff returns its receipt.

Installation creates `repair-policy.json` with its activation time. Existing queued and in-flight requests stay owned. Failures predating activation retain their receipts without starting a wave of historical repairs. Use `deploy/publication repair REQUEST` to adopt a specific earlier failure. This command cannot create a second repair for the same request. To inspect repair custody directly, read `~/.local/state/pi-stack-publication/repairs/REQUEST/receipt.json`.

The GMKtec installation needs `node`, `timeout`, `flock`, `systemctl`, `git`, `agent-workspace` and `/home/kenan/.local/bin/pi` in the user service environment, plus Kenan's existing model-account routing and release authority. All four publication services put `/run/wrappers/bin` before `/run/current-system/sw/bin` in `PATH`. NixOS supplies setuid `sudo` through that wrapper directory; the system package binary cannot elevate. This also applies to the repair agent and commands the worker launches, including host restoration. The installer copies the command and its module into `~/machine`, copies the seven reference units into `~/.config/systemd/user`, reloads systemd and enables the queue path and both timers. It does not restart the worker. When upgrading an in-flight publisher that lacks progress records, coordinate activation first: the new watchdog will classify its missing progress, and the earlier worker's final installation step could overwrite the new command. Source integration and both-host release still belong to the submitting parent and durable publication worker.

Focused checks run in seconds:

```bash
node --test scripts/publication.test.mjs scripts/publication-gate.test.mjs scripts/publication-progress.test.mjs
```

## Release checkout ownership

Host wrappers select source in `~/.local/state/pi-stack-release/repository`, not the editable `~/projects/pi-stack` checkout. The Pi Stack-owned [`deploy/release-checkout`](../deploy/release-checkout) helper is installed at `~/machine/pi-stack-release-checkout` and sourced by each host's `machine/pi-stack-release`. A wrapper refreshes that installed helper from the selected release before preparation and deployment. On first installation, copy the reviewed helper with `install -m 644 deploy/release-checkout ~/machine/pi-stack-release-checkout`.

`pi_stack_select_release_checkout STATE REPOSITORY COMMIT LIVE_MARKER ALLOW_ROLLBACK` takes `/srv/pi/.pi-stack-deploy.lock` before reading source or live state, fetches committed source, selects detached HEAD and exports the deployment locks. The wrapper holds the host lock, `STATE/release.lock` and the selected checkout's deployment lock through preparation, activation and host proof. Direct component deployments and `deploy/prepare` take the same host lock before their checkout lock. Children inherit the parent's ownership, including commands run as another Pi account. Lock acquisition waits at most 40 seconds and reports contention without changing source or release links.

Publication `PUB-cdced51d851da604e79ca204` exposed the missing host lock on September 15. Converge deployed `eade24c8` from its release-owned checkout while another SSH caller deployed `ae374aff` from `~/projects/pi-stack`. The second caller changed `/srv/pi/runtime` before the first caller checked its artifact markers. Checkout locks alone cannot protect shared destinations.

Install the updated release-checkout helper on both hosts before using this locking contract, so wrappers take locks in the same order as component deployments. The host lock is a persistent root-owned, readable file, not a release artifact. Never replace or delete it while a deployment can run. Isolated tests set `PI_STACK_HOST_LOCK_PATH` to a scratch file shared by every simulated checkout. The requested commit must descend from the previously selected commit and the installed live marker unless the host explicitly allows rollback. An unexpected origin or dirty release-owned checkout stops deployment without discarding its contents. Recover that checkout's changes into their owning source before retrying. Neither a dirty writer checkout nor its index and branches are touched.

The release checkout, ignored dependencies and build outputs are reproducible. Keep the state directory while a release holds its locks; remove it only with no release running and no unique source work. The next release recreates it from the configured remote, and the live marker still prevents accidental rollback. Host handbooks own wrapper-specific services and checks.

`node --test scripts/deploy-lock.test.mjs scripts/release-checkout.test.mjs scripts/publication-progress.test.mjs` checks cross-checkout exclusion, source isolation, rollback protection, interrupted initialization, lock ownership and repair-result acceptance in seconds.

## What a host provides

The stack is the same on every machine. A host supplies three things.

**Unix accounts.** One for each person who uses Pi Remote, and one that runs the fleet daemon. The fleet account is ordinarily a person too.

**The host file** at `/etc/pi-stack/host.json`:

```json
{
  "version": 1,
  "fleetUser": "kenan",
  "environments": [
    { "id": "local", "name": "Local", "icon": "house" },
    {
      "id": "converge",
      "name": "Converge",
      "icon": "cloud",
      "upstreams": { "kenan": "http://127.0.0.1:18792" }
    }
  ],
  "packages": ["/etc/nixos/pi-agent/extensions/scratch-updates"],
  "skills": ["/etc/nixos/pi-agent/skills/math-research"]
}
```

`environments` is the router's endpoint catalog. Entries have `id`, `name`, optional `icon`, and remote entries have `upstreams`. This host's own entry has no `upstreams`. Each remote map names a person and the absolute HTTP or HTTPS origin of her supervisor. Origins cannot contain credentials, paths, queries or fragments. The example port `18792` is a host-owned forward to the remote `kenan` supervisor, not its router. Configure the actual listener before granting access. Without a catalog, the router supplies only its own endpoint. `PI_STACK_HOST_FILE` selects another host file for tests or custom installations. Restart the router after configuration changes.

`fleetUser` runs `pi-orchestrator@<user>.service`. `packages` are extra Pi packages every account loads, placed after the reviewed ones and before the Pi Remote context observer. `skills` are extra skill directories linked into every account's skill directory under their own names. Both are optional and point at paths the host owns.

**systemd units.** [`deploy/systemd`](../deploy/systemd) holds reference units for `pi-remote-router.service`, `pi-remote@.service`, `pi-orchestrator@.service`, and `pi-stack-voice.service`. Debian installs these references; NixOS declares matching units with its packaged executables. Host release wrappers install changed references before `deploy/host`. The units select stable paths under `/srv/pi`; code releases do not rewrite unit files. Voice uses `/usr/bin/env bun` with both hosts' system paths and requires `systemd-notify`.

Voice requires `/var/lib/pi-stack-voice/openai-api-key`, root-owned mode `0600` in a root-owned `0700` directory. The host credential owner provisions it; deployment never fetches or copies a key. `LoadCredential` gives the dynamic service user a private copy. Its persistent session leases and expiry state live in `/var/lib/pi-stack-voice-runtime/sessions.sqlite3`. This is an OpenAI API connection, independent of Orchestrator OAuth credentials. Its loopback listener is `127.0.0.1:8796`; supervisors use `PI_STACK_VOICE_URL` to select another endpoint. Browser clients never receive the key.

Persons are not in the host file. They are Pi Remote's registry, `/var/lib/pi-remote/persons/<user>.json`, created with `pi-remote person add`. See [the Pi Remote README](../apps/remote/README.md#persons).

## Browser prefix hosting

Publish the router at `/` or a directory prefix such as `/pi-stack/`. The same release works at either path without a rebuild or a base-path setting:

1. Redirect `/pi-stack` to `/pi-stack/` and retain its query string.
2. Proxy every `/pi-stack/*` request to the router with `/pi-stack` removed. For example, `/pi-stack/meet.html` becomes `/meet.html`, and `/pi-stack/v1/environment` becomes `/v1/environment`.
3. Apply the host's access policy to the entire prefix. Do not expose a supervisor or add root `/v1`, asset or Meet aliases.

The [shared client](../apps/remote/web/README.md#browser-mount-path) derives its mount from the page URL. Static assets and the manifest are relative; API bootstrap, downloads and Meet links use that mount. No service worker is installed. The host ingress owns routing and any external identity check. An unencrypted person can obtain a router session with an empty unlock request, so an open-person deployment needs the ingress to enforce its intended audience.

## Gateway access and host boundaries

Each person registry may set `"remoteAccess": ["local", "converge"]`. Omission allows only this host's own endpoint. The list must include this host's own ID, and every grant must name a catalog entry. Remote grants require an encrypted-folder identity and an `upstreams` mapping for that person or router startup fails. Add each person's mapping explicitly; never send several people's requests to one shared supervisor. Endpoint names and icons do not affect authorization.

`POST /v1/unlock` accepts `{ "key": "..." }` with the `x-pi-remote-user` hint and returns `{ "ok": true, "user": "...", "session": "..." }`. Clients send `session` in `x-pi-remote-session`. A user header or query parameter is only a selection hint, even on a single-person host or while that person's folder is already open. This replaces the previous name-only identity contract. Missing authentication on protected `/v1/*` routes returns `423`. The chooser at `/v1/environment`, `/v1/router-health`, app updates and static assets remain public; unlock is the session bootstrap. Lock revokes all sessions for that person.

Authenticated `GET /v1/environments` returns only that person's allowed endpoints, with an empty `baseUrl` for this host and generated same-origin `/v1/remotes/<id>` prefixes for remote endpoints. Clients never receive upstream origins. The gateway checks the person's grant for every forwarded request and removes client authentication and person hints before reaching the configured supervisor. A host tunnel forwards directly to the matching remote supervisor, not another router.

The router must be the sole published API entrance. Before activating this contract, remove the unauthenticated `/converge` and `/editor` host routes and any direct supervisor publication. Bind supervisor, forwarded upstream and control listeners to loopback and apply UID gates on both hosts. Permit root for deployment, the gateway identity for upstream access, and each owning service identity only where needed. Loopback alone is not a UID boundary. Include Voice/control listeners and the tunnel's local listener; restrict the remote forwarding account to its person's supervisor port. The host handbook and declarative host configuration own these rules and tunnels. Reference units do not install a firewall.

Revoke the restricted Converge SSH key embedded in existing APKs by removing its `authorized_keys` entry at the host's source of truth and deployed account. Removing SSH code from the new app does not revoke installed APKs or copies of their key. Retire active forwards authenticated by that key, and remove its declaration from host provisioning so it cannot return. The gateway tunnel uses a separate server-owned identity that has never been distributed to clients. Record the revocation and new tunnel owner in the host handbook before accepting the deployment.

Deployment health checks use root-run requests to the supervisor port read from the person registry. `deploy/smoke` instead exercises router authentication. It checks unauthenticated rejection, reads existing root-only `/run/pi-remote-keys/<user>` credentials through a pipe, unlocks only people already reported open, and uses the returned session for app calls. Unencrypted people bootstrap with an empty key. `PI_REMOTE_KEY_DIR` selects another credential directory for a rehearsal. Smoke accepts only a loopback router URL, keeps temporary session headers in a private directory, and removes them on exit. It neither prints keys/tokens nor calls lock, which would interrupt the person and revoke her other clients.

Host routing, UID gates, tunnels and Android local build configuration require coordinated host changes. A code release alone does not install them.

## What deploy/host does

Orchestrator runs threads in shared SDK runners within each person, release and application execution boundary; see [unified threads](threads.md). Remote is a client of that owner. The reference supervisor unit caps its complete process tree at 16 GiB RAM and 1 GiB swap. Hosts with multiple people also declare an aggregate cap on the implicit `system-pi\x2dremote.slice` (GMKtec uses the same 16 GiB / 1 GiB ceiling across all people). The runner checks constrained ancestors before admitting another session, including memory used by browser children. These limits contain runaway subprocesses; sharing SDK sessions does not make browser subprocesses share a heap. Keep `MemoryHigh` at the hard limit on these hosts to avoid the prolonged reclaim stalls seen with a lower soft limit.

Before publishing anything, `deploy/host` checks that the Voice unit and credential exist and that live-dev services and Voice source overrides have been retired. A rehearsal with overridden destinations skips host-service checks.

1. Prepares the Orchestrator and Remote builds concurrently through [`scripts/build-workspace.mjs`](../scripts/build-workspace.mjs), after installing checkout dependencies. Their output directories are separate; publication still selects Orchestrator before linking Remote to it. Build receipts in `node_modules/.pi-stack-build-*.json` hash source paths and contents, root manifests, the installed dependency lock, the builder and output files. Changed or missing outputs force a rebuild, and failed builds cannot retain a success receipt. Removing `node_modules` removes these generated receipts. Both builds must settle successfully before Orchestrator and Remote publication proceeds. This preparation runs alongside the production runtime and transcription installation, within the existing 50-second deadline. On September 15, publication `PUB-3eb53799fb4d489db9bdc265` spent 47 seconds preparing a Converge release before activation; serial compilation left no time for smoke checks after the two-second supervisor handoff.

   Prepares PiStack Meet's local transcription runtime through `deploy/transcription`. Its pinned Whisper model and hash-locked Python dependencies live under `/srv/pi/.pi-transcription`, selected by `/srv/pi/transcription`. Hosts need `uv`; model preparation runs alongside JavaScript dependency installation. `PI_STACK_TRANSCRIPTION_DEST` selects a separate destination for a rehearsal. Installs the JavaScript dependency tree once per manifest, lockfile and stack doctor source under `/srv/pi/dependencies`. Runtime, Orchestrator, and tools link that tree instead of copying it.
2. Publishes commit-addressed releases of the runtime (`/srv/pi/runtime`: Pi, `agent-browser`, and the runtime extensions), the Orchestrator, Pi Remote, the tools, and the skills. Each destination is a symlink switched atomically; prior generations stay under `/srv/pi/.pi-stack-releases` for processes that loaded them.
3. Settings reconciliation runs as the owning account with reviewed code and configuration sent over stdin. It reads installed packages from `/srv/pi`, never the administrator's private checkout. Home traversal permissions stay unchanged. For every account (each person plus the fleet user): links `pi`, `agent-browser`, `pi-agent-browser-doctor`, `pi-orchestrator`, `pi-remote`, and every tool command into `~/.local/bin`; links the reviewed skills and the host's skills into `~/.pi/agent/skills`; rewrites the `packages` list in `~/.pi/agent/settings.json` under Pi's own lock, installs the pinned external packages, and writes the custom model catalog. The manifest selects the stack-owned [Codex compaction extension](../packages/runtime/extensions/codex-compaction/README.md); Pi owns its compaction timing and continuation.
4. Loads the deployed native browser tool under the fleet account's normal settings and proves open, interactive snapshot, title, and isolated-browser cleanup against a loopback page. A failure blocks service activation. Then restarts the fleet daemon. Live workers keep the release they recorded in their run row.
5. Enables Voice and starts the selected release when `/status` reports another commit. Voice's notify readiness and `/status.releaseCommit` must match Pi Remote before supervisor activation. Its provider sessions and heartbeat database survive a service restart. If Pi Remote changed, restarts the front door and hands each running supervisor the new release. An interrupted deployment may already have selected the artifact without reaching that handoff; rerunning the same release detects any unlocked supervisor on another commit and performs the missed activation. Active Pi turns keep their process and stream; the replacement supervisor adopts them and replaces each runtime after it settles. The front door starts every open person's supervisor before it listens, so deployment first waits for `/v1/router-health`, then asks only the supervisors reporting another commit to hand over, then waits until every unlocked person's health response names the selected commit. A slow start or handoff therefore cannot race the smoke check or rollback. During handoff, the supervisor stops accepting client work but keeps its context ingestion listener alive until Pi shutdown hooks finish. Publication `PUB-1faf5975f779e789f91258c9` exposed the reversed order on Converge: an idle session retried its final context upload to the closed listener, preventing the supervisor from exiting. Cleanup errors now retain ingestion and permit an explicit activation retry rather than leaving a closed listener behind a shutdown flag. A rollback resets the supervisor units first, since one that crashed on the rejected release may have exhausted its start limit.
6. Walks the live front door through `deploy/smoke`: all three web entrypoints, their assets, the standalone Meet adapter, Android CORS, environment/person discovery, and every unlocked person's initial app calls, Voice release identity and transcription availability. A dead router is a failure, not a skipped check. Failure restores the previous Pi Remote selection and its Voice implementation before handing supervisors back. A generation without the shared Voice implementation stops that new unit. Each new Remote release carries its own smoke script and helper so rollback checks the restored release's contract rather than requiring new assets from older code.

An unchanged host redeploy takes a few seconds, including the native browser probe. A clean dependency install takes a few seconds. A deployment whose destinations are overridden with `PI_STACK_*_DEST` is a rehearsal: it publishes into those paths and touches no service unless `PI_STACK_SERVICES=1`.

Pi is the sole agent runtime. OpenAI models, shared subscription credentials and native server-side compaction remain available through Pi. Deployment does not install the Codex CLI or app-server.

The native browser extension and executable belong to the same immutable dependency tree. The [browser runtime entrypoint](../packages/runtime/extensions/browser/README.md) resolves that tree when Pi loads it and puts its physical `.bin` path first in the process environment. Live turns keep their pair across a release switch. New, recovered and reloaded sessions select both together. The native extension is not installed into an account's mutable npm directory. Pi resolves the physical extension entrypoint before importing it, so its native ESM cache cannot keep the first target of a switched symlink on reload.

Retain runtime releases and their dependency trees while any Pi process or browser daemon uses them. A run's recorded Orchestrator release is not a complete browser reference: recovery may load a newer browser pair through current settings. Deployment does not garbage-collect these trees.

Pi normally comes from the npm registry. When an unpublished upstream commit is selected, [`vendor/pi`](../vendor/pi/README.md) holds the built source packages and their exact provenance. `deploy/runtime` copies those packages into its isolated production install before running `npm ci`.

Pi Remote links its declared dependencies and peers from the same immutable production dependency tree, while keeping `pi-orchestrator` pinned to the matching code release. Before publication, deployment resolves the supervisor, router, person CLI and shared Voice service import graphs from the staged artifact with Bun. It also requires the livedev skill, Voice delegation policy, ASR worker/model/lock, normal frontend pages and artwork, and the self-contained `web/dist/meet-adapter.js`. `apps/remote/skills` is dereferenced into the artifact, so a checkout-relative symlink cannot escape the installed release. Converge reads that exact adapter bundle from the selected Remote release; there is no independent browser asset deployment. This check does not start services or open person data, and runs even when every person is locked; dependencies available only in the source checkout cannot mask an incomplete release. An unchanged redeploy repeats the import check.

## Leaving live development

The September 10 Meet release was assembled in `/home/kenan/work/clones/meet-converge` while `/home/kenan/projects/pi-stack` continued serving live development. Finish the shared release, its adapter integration and required checks before changing services. A supervisor handoff ends live rooms, so end the meeting and save its final transcript first.

Preserve the source checkout's work in the final Git ancestry rather than resetting a dirty tree. After all source writers have settled:

1. Review and commit the original live-dev changes in `/home/kenan/projects/pi-stack`. Record that snapshot SHA. Do not add ignored credential or Android local-configuration files.
2. Commit the completed tree in the shared release checkout. Fetch the snapshot locally with `git fetch /home/kenan/projects/pi-stack SNAPSHOT_SHA`. Compare it with the release tree and incorporate any useful late changes that were not copied.
3. Once the release tree includes or deliberately replaces every snapshot change, run `git merge -s ours --no-ff FETCH_HEAD -m 'Retain Meet live-development provenance'`. This preserves the working snapshot as an ancestor without undoing the integrated release tree. Publish the resulting final release through the normal owner. The canonical checkout can now fast-forward; no `reset`, `clean` or stash is needed.

GMKtec's `/etc/nixos/pi-voice.nix` declaration and import must be installed before `deploy/host`. Stage new Nix files so flake evaluation sees them, build the system to an explicit store path, and inspect its dry activation through the host's `machine/operations.md`. Prepare that build before stopping live development. The unit's `ConditionPathExists` skips startup until the selected Remote release contains the Voice service.

When the complete release is ready, retire the active development services and restore the existing frontend route:

```sh
sudo systemctl stop pi-remote-dev-web.service pi-remote-dev-supervisor.service
sudo tailscale serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:8788
sudo systemctl stop pi-stack-voice.service
sudo rm -f /run/systemd/system/pi-stack-voice.service.d/source.conf \
  /run/systemd/system/pi-stack-voice.service \
  /run/systemd/system/pi-remote-dev-supervisor.service \
  /run/systemd/system/pi-remote-dev-web.service
sudo rmdir --ignore-fail-on-non-empty /run/systemd/system/pi-stack-voice.service.d
sudo systemctl daemon-reload
```

Stopping the live-dev supervisor restores the deployed capture package and resumes its original supervisor wrapper. Do not restart `pi-remote@kenan.service`; that would kill active Pi turns. Restore only the router as the published API entrance. Remove the `/converge` and `/editor` bypass routes as described under [host boundaries](#gateway-access-and-host-boundaries); do not restore them after live development.

Persist the prepared Nix generation in `/nix/var/nix/profiles/system` and activate it through a separate root transient systemd unit, exactly as the GMKtec handbook describes. Never run the switch inside the supervisor's cgroup. Then release the same final SHA on both machines:

```sh
/home/kenan/machine/pi-stack-release FINAL_SHA
ssh converge-kenan /home/kenan/machine/pi-stack-release FINAL_SHA
```

Converge's release wrapper installs `pi-stack-voice.service`; its `kenan-vm.tf` boot unit list must carry the same reference. Converge's credential is provisioned from its existing `production-openai-api-key` Secret Manager secret, as recorded in that host's `machine/secrets.md`. Neither release command changes credential custody. The Converge adapter owner then activates the wrapper against this exact installed bundle through Converge's publication workflow.

After release, `systemctl show pi-stack-voice.service -p FragmentPath -p DropInPaths -p Environment` must select the host's production declaration, with no working-checkout override. `deploy/voice --check`, `deploy/smoke`, both live commit markers and each host wrapper's own checks must pass. `tailscale serve status` must show `/` proxying `8788`, not Vite's `5175`. No live-dev process should own a service or selected Pi package. Remove preparation-only handbook notes once both deployments are accepted.

## Browser recovery

A version mismatch is evidence that the loaded native tool and executable came from different installations. Do not disable the guard, downgrade the shared command, or export a different PATH in a child shell. A child shell cannot repair its parent Pi process.

- Interactive Pi with the patched loader can use `/reload` while idle. Processes started before the loader fix need one process replacement, reopening the same file with `pi --session /absolute/path/session.jsonl`. A reload in that earlier process can still retain its original factory.
- Pi Remote deployment replaces idle runtimes and adopts active turns until they settle. The next runtime loads the selected pair. It does not replay a completed turn.
- Fleet workers keep their process during deployment. Workers using the browser entrypoint retain a matched pair and need no restart. A worker loaded before that entrypoint must reach its checkpoint before process replacement. The daemon recovers an interrupted, still-admitted run using its recorded Orchestrator release and exact JSONL; current settings select the browser pair. `abort` and `kill` are terminal operator actions, not dependency-reload commands. Completed research remains completed unless its owner explicitly resumes it.

To prove native browser availability without asking a model or changing research history:

```sh
pi-agent-browser-doctor
pi-agent-browser-doctor \
  --worker-release /srv/pi/.pi-stack-releases/orchestrator/COMMIT \
  --session-file /absolute/path/to/settled-session.jsonl
```

The stack's [doctor](../packages/runtime/browser-doctor.mjs) runs both extension-loading phases, including project-trust resolution, before checking actual Pi source registration and the native version guard. A successful first load alone is insufficient: mismatched symlink and physical path keys once discarded the handlers between those phases. The recovery probe copies the JSONL into a temporary directory and opens it through the recorded release's SDK. Use a settled session because its extension startup hooks may recover browser cleanup leases. The browser script uses a separate, disposable browser identity. Success removes the probe files; failure reports the retained session path and cleanup state. The canonical JSONL and Orchestrator ledger are not written. This proves browser recovery, not a new research turn. Cached npm copies from earlier installations can be removed after their loading processes exit; deployment does not uninstall code underneath them.

To test release switching against the deployed SDK and bundled RPC:

```sh
PI_TEST_RUNTIME_ENTRY=file:///srv/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  node --test packages/runtime/extensions/browser/browser.test.mjs
```

## Build checks

```bash
npm ci --ignore-scripts
npm run check
npm run android:test --workspace=kenan
```

CI runs the same gate from a persistent self-hosted checkout. Deployment does not repeat tests that already passed on the commit.

`node --test scripts/deploy-lock.test.mjs scripts/deploy-build.test.mjs` checks concurrent preparation, build reuse and invalidation, failure propagation, host activation and rollback in seconds using temporary artifacts and mocked services. Its unlocked router people must have matching person registry files. The HTTP fixture accepts supervisor health only at the registered listener, so it also checks that deployment avoids the authenticated client routes.

## Kenan

The publication worker also distributes Android updates. After the checked source is integrated and both hosts are deployed, it publishes the APK built on GMKtec to both hosts and verifies the manifest and downloaded bytes through each front door. A release is unfinished if either app download fails. The native client compares the published version code with its installed package and shows Update app only for a newer build.

[`deploy/android-update`](../deploy/android-update) owns artifact preparation, atomic installation and download verification. `apps/kenan/release-info.mjs` supplies the Git revision, application id and monotonic version code. The APK contains that identity at `assets/app-release.json`; preparation checks it against the source and Android package metadata, then records its SHA-256 and byte count. GMKtec is the only APK producer, using the existing Android signing key and host-owned `piRemoteRouterUrl`. Both hosts receive identical bytes. The APK contains the router bootstrap URL, not endpoint lists or SSH identities. Packages remain on the private Pi Remote hosts, not public GitHub assets.

Each host stores packages in `/var/lib/pi-remote/app-updates/releases/<revision>/`, with `current` selecting the manifest atomically. The installer retains three generations. When a host is under an explicit no-deletion hold, pass `PI_REMOTE_APP_UPDATES_KEEP_ALL=1` to the installer to retain every existing generation. `PI_REMOTE_APP_UPDATES_DIR` selects a separate root for a rehearsal. The router serves `GET /v1/app-update` and `GET /v1/app-update/<revision>.apk` before person selection or unlock. Missing initial publication returns `release: null`; a broken manifest or package reports an error.

Publication receipts keep the app manifest and each host's verified hash. Failed requests retain their staged APK under the request's proof directory. Successful requests remove that staging copy after both hosts own it. Converge's transfer directory is `/home/kenan/.cache/pi-stack-app-updates/<request>` and is removed after verification. Normal releases build and distribute this automatically through `deploy/publication submit SHA`.

For an artifact repair using an already built, clean source checkout:

```bash
deploy/android-update prepare /absolute/private/artifact-directory
sudo deploy/android-update install /absolute/private/artifact-directory
deploy/android-update verify /absolute/private/artifact-directory/manifest.json
```

Set `piRemoteRouterUrl` in the ignored `apps/kenan/android/local.properties`; see [the Kenan README](../apps/kenan/README.md#build-configuration). Remove the embedded endpoint/SSH configuration from build inputs. Both clients authenticate at the bootstrap router and fetch their allowed list from `/v1/environments`. Adding or withdrawing a grant requires no APK rebuild.

## Release verification

- `/srv/pi/pi-remote/.pi-stack-commit` matches on every host;
- `pi-remote-router.service`, each unlocked `pi-remote@<user>.service`, `pi-stack-voice.service`, and `pi-orchestrator@<fleet>.service` are active;
- `sudo curl -fsS http://127.0.0.1:8796/status` reports the same `releaseCommit`;
- `/v1/meet` reports `transcriptionAvailable: true`, and `/meet-adapter.js` exports `startMeetAdapter`;
- `deploy/smoke` authenticates each open person and health reports the intended environment id;
- name-only API requests return `423`, and each authenticated endpoint list matches that person's grants;
- no `/converge` or `/editor` bypass is published, and non-owning UIDs cannot reach supervisor, forwarded upstream or control ports;
- `pi-orchestrator status` answers;
- Kenan can switch environments without crossing threads, keys, voice, or downloads.
