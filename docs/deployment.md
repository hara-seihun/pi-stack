# Deployment

Pi Stack separates reviewed source from host-owned accounts, credentials, network routes and release paths. This guide describes the shared deployment contract. A host handbook owns its actual values and acceptance receipts.

## Publication owner

From a writer checkout, submit an immutable commit:

```sh
deploy/publication submit "$(git rev-parse HEAD)"
```

Before it pushes the immutable request ref, `submit` fetches current `main` and refuses a source commit with any Git root absent from that branch. Merging current `main` into a checkout with another root does not make it safe: replay the intended changes onto current `main` instead. A shallow checkout or grafted history cannot prove this ancestry and is rejected. The gate protects the request ref as well as the later integration push.

The receipt acknowledges durable custody. The owner integrates the source with `main`, runs the checks, deploys each configured target in order, publishes the Android update, verifies the targets and reports the terminal result. `deploy/publication inspect REQUEST` shows progress. Submitting the same source SHA returns its receipt or rejects an unrepaired failure. `deploy/publication cancel REQUEST` records cancellation for the next command boundary; it does not kill an in-flight deployment or undo a completed host release.

Install the local owner with `deploy/publication install` after creating `/etc/pi-stack/publication.json`. The installer copies the command and its modules to the configured `paths.installedCommand`, renders its seven systemd units in `paths.userUnitRoot`, reloads the user manager and enables the wake path and timers. It does not restart the active worker. On a successful release, the worker updates itself from the checked integration checkout, never from the mutable writer checkout. Coordinate a manual owner upgrade with any in-flight worker before changing its watchdog.

[`config/publication.example.json`](../config/publication.example.json) shows the schema. Set:

- `repositoryUrl` to the canonical Git origin and `mergeAuthor` to the name and email for integration commits.
- `targets` in deployment order. Each has a stable receipt `id`, an expected supervisor `environmentId`, an SSH alias or `null` for the sole local target, absolute `releaseCommand`, `releaseRepository` and `checkServicesCommand` paths, a `hostConfig` path, `requiredUnits`, and a loopback `voiceStatusUrl`. Remote targets also specify an absolute writable `androidTransferRoot`.
- `paths` for the publication user's canonical checkout, ignored Android `local.properties`, state directory, installed command, user unit directory, repair workspaces, Pi CLI and alert inbox. Omitted paths use home-relative defaults, except for the alert inbox.

The file contains host identities and routes, not credential values. `PI_STACK_PUBLICATION_CONFIG` selects a different file for a fixture. Provision it before either installation or submission. Keep target IDs stable while receipts carry maintenance or restoration custody. The target's host file supplies `fleetUser`. Its installed `checkServicesCommand` checks the router, failed Pi units, fleet service and every unlocked supervisor's unit. Publication then checks each unlocked supervisor's health, commit and environment ID, along with the configured required units and Voice status. It does not assume any named person is unlocked. The remote SSH user must already have release authority. Its credential and Android signing key remain in host custody.

The worker's state is under `paths.stateRoot`, by default `~/.local/state/pi-stack-publication`. Requests are `queued`, `running`, `failed` or `published`. A busy first-activation gate returns to `queued` with `blockedSince`, `waiting.reason` and `nextAttemptAt`. Cancellation is a failed request with reason `cancelled`. Requests and repair receipts are the issue source of truth. `deploy/publication issues` reads their complete index without taking the worker lock, so inspection remains available during a release. The owner maintains one bounded alert at the configured inbox; `acknowledge-issues` silences the current notification without clearing repair or host custody. Delivery resolution considers every successful publication's ancestry and names its receipt and proof, even after a source-root cutover. Retain those Git objects in the publication repository. Unrelated source remains unresolved, and outstanding host restoration always remains an issue.

To report back to a Remote thread, set `PI_STACK_PUBLICATION_REPORT_URL` and `PI_STACK_PUBLICATION_REPORT_SESSION` when submitting. `deploy/publication report REQUEST REMOTE_URL SESSION_ID` attaches a requester to an earlier request; without arguments, it reconciles an existing report only. `report.status: accepted` means Remote queued the report. `delivered` means its thread confirmed dispatch. Notices retry transport separately from release work.

### Ancestry and live handoff

Before changing intake or pushing `main`, the owner checks that the integration descends from every target's selected live commit and release-checkout HEAD. Missing selected source is fetched by exact SHA from the configured `releaseRepository` and retained under `refs/pi-stack-publication/selected/<sha>`. The ancestry proof names each host and baseline. A divergent commit fails before deployment; merge the missing history into a repair descendant rather than disabling rollback protection. Each host wrapper repeats the check under its deployment lock.

`unified-threads-v1` has a first-activation gate. The worker records each target's fleet launch state, pauses new launches, waits for active runners and fleet work, then freezes the router, supervisors and pre-contract owner for a final census. Busy hosts are restored and retried without replaying accepted work. The recorded operator pause remains paused. An empty census permits the release wrapper to transfer native transcript references, held messages and pending results. Later releases use live controller handoff without the first-activation pause. A target that already selected the thread contract cannot be replaced by code without it.

Failure or cancellation restores recorded intake and service states. Unfinished restoration remains explicit custody in the receipt and blocks new deployment until repaired. If `main` moves after checks, the worker retains the checked integration, restores host custody, and queues a fresh integration and full checks; it never force-pushes or deploys an unchecked merge. The final host proof, per-target deployment receipts, Android hashes and source refs stay with the request.

## Publication progress and repair

[`deploy/publication-control.mjs`](../deploy/publication-control.mjs) owns command deadlines and retry budgets. Each subprocess records its arguments, directory, start, deadline and log before launch. The independent watchdog records a stalled command and stops its cgroup. A waiting gate has a bounded retry budget; a failed release does not replay automatically.

Each new failure gets `repairs/REQUEST/receipt.json`, a saved prompt, Pi session, agent log and `result.json`. The local `pi-stack-publication-repair@REQUEST.service` uses the configured Pi CLI and a registered writer workspace, not the paused fleet. A `source-fixed` result submits a new descendant commit with `--repair-of REQUEST`; an `infrastructure-fixed` result grants one unchanged-source retry with evidence. An irrecoverable or interrupted repair remains assigned with its evidence. After manually completing an interrupted agent's existing workspace and `result.json`, run `deploy/publication repair-result REQUEST`; it checks service inactivity and hands off that same result once. `deploy/publication repair REQUEST` adopts a failed request predating the repair-policy activation. Inspect the named receipt before either command.

Focused checks:

```sh
node --test scripts/publication-config.test.mjs scripts/publication-roots.test.mjs scripts/publication-proof.test.mjs scripts/publication.test.mjs scripts/publication-gate.test.mjs scripts/publication-source.test.mjs scripts/publication-progress.test.mjs
```

## Release checkout ownership

Host release wrappers use [`deploy/release-checkout`](../deploy/release-checkout), not an editable working tree. Install that reviewed helper as `~/machine/pi-stack-release-checkout` and source it from the host's release wrapper. The wrapper selects committed source in `~/.local/state/pi-stack-release/repository`, runs [`deploy/prepare`](../deploy/prepare) and [`deploy/host`](../deploy/host), then checks host-specific invariants. The publication target's `releaseRepository` must name that same release-owned checkout.

`pi_stack_select_release_checkout STATE REPOSITORY COMMIT LIVE_MARKER ALLOW_ROLLBACK` takes the shared `/srv/pi/.pi-stack-deploy.lock`, selects detached HEAD and holds host, state and checkout locks through preparation and activation. Direct component deployments and preparation use the same lock order. The requested commit must descend from both the selected checkout and the live marker unless the host explicitly authorizes rollback. An unexpected origin or dirty release-owned checkout fails without discarding changes. Recover unique edits into their source owner before retrying. A writable source checkout's index and branches are never reset by the release wrapper.

The release checkout and its ignored dependencies are reproducible. Retain its state while a release holds locks; remove it only after checking for unique source work and running releases. The next wrapper recreates it from its configured remote. `node --test scripts/deploy-lock.test.mjs scripts/release-checkout.test.mjs` covers locks and source isolation in seconds.

## What a host provides

Every host supplies Unix people, a host file and systemd services. The host file at `/etc/pi-stack/host.json` names a `fleetUser`, its endpoint catalog and optional extra packages and skills. This is a fictional example, not a production host file:

```json
{
  "version": 1,
  "fleetUser": "operator",
  "environments": [
    { "id": "home", "name": "Home" },
    { "id": "studio", "name": "Studio", "upstreams": { "alice": "http://127.0.0.1:19000" } }
  ],
  "packages": [],
  "skills": []
}
```

`environments` is the router's endpoint catalog. The local entry has no `upstreams`; remote entries map each granted Unix person to that person's supervisor origin, not another router. Those origins have no credentials, paths, queries or fragments. `PI_STACK_HOST_FILE` selects a different file for a fixture. Restart the router after changing its catalog. Persons live separately in `/var/lib/pi-remote/persons/<user>.json`, managed by `pi-remote person add` and `pi-remote person update USER` with JSON on stdin. The person writer preserves supervisor-readable permissions, including for locked people. `deploy/account USER` onboards a registered Unix account against the selected release.

[`deploy/systemd`](../deploy/systemd) contains reference units for the router, supervisors, Orchestrator and Voice. A host installs those references or declares matching units with its own package paths. Voice loads its OpenAI credential from root-owned `/var/lib/pi-stack-voice/openai-api-key` through systemd `LoadCredential`; deployment does not provision it. The Voice service owns its lease database under `/var/lib/pi-stack-voice-runtime`. Supervisors select its loopback endpoint with `PI_STACK_VOICE_URL`. No browser client receives the key.

## Browser prefix hosting

Publish the router at `/` or a directory prefix. For `/pi-stack/`, redirect `/pi-stack` to `/pi-stack/` with its query string, strip `/pi-stack` when proxying requests to the router, and apply the host's access policy to the whole prefix. Keep OAuth cookies and the callback under the same prefix if using [company browser sign-in](../apps/remote/README.md#company-browser-sign-in). The [shared client](../apps/remote/web/README.md#browser-mount-path) derives its mount from the page URL. Do not publish supervisor ports or create root-level aliases around the router.

## Gateway access and host boundaries

A person registry's `remoteAccess` lists allowed environment IDs. Omitting it grants only this host's endpoint. A remote grant requires that person's encrypted-folder identity and an upstream mapping. The router authenticates `POST /v1/unlock`, then sends only that person's allowed same-origin `/v1/remotes/<id>` endpoints through `GET /v1/environments`. Client person hints do not authenticate requests. The router rechecks the person's grant for every forwarded request and removes client authentication before reaching the remote supervisor. Bind private listeners to loopback and enforce host UID gates for the gateway, root deployment and each owning service. Host-owned SSH tunnels forward to a matching remote supervisor, never a shared router.

`deploy/smoke` checks router authentication, static assets, active supervisor health, Voice and transcription. For a key-bootstrap host, it reads existing root-only `/run/pi-remote-keys/<user>` credentials through a pipe and unlocks only people already open. `PI_REMOTE_KEY_DIR` selects a fixture directory. For an OAuth host it checks unauthenticated rejection and probes supervisors as root; a real browser sign-in remains a host acceptance check. It does not create an OAuth bypass, print keys or lock a person. A code release cannot configure ingress, UID gates, DNS, credentials or tunnels for the host.

## What deploy/host does

`deploy/host` first reads every person registry as that Unix user, including locked people. Invalid or unreadable configuration fails before publication or service handoff. A rehearsal with `PI_STACK_*_DEST` destinations skips host-service checks unless `PI_STACK_SERVICES=1`.

1. [`deploy/prepare`](../deploy/prepare) installs dependencies and builds Orchestrator and Remote concurrently. It prepares transcription with `uv` and the pinned model under `/srv/pi/.pi-transcription`, plus the shared JavaScript tree under `/srv/pi/dependencies`. Preparation receipts hash their inputs and build outputs; unchanged stages are reused. The inherited deadline bounds all children. No running service changes during preparation.
2. Deployment publishes commit-addressed runtime, Orchestrator, Remote, tools and skill releases under `/srv/pi/.pi-stack-releases`, switching stable symlinks atomically. Settings reconciliation runs as each registered person and the fleet user. It links the reviewed tools, packages and skills, selects custom models, and leaves their private homes and credentials untouched.
3. The deployed `pi-agent-browser-doctor` proves the native browser tool and executable from one immutable dependency tree. The fleet and enabled or running per-person Orchestrator daemons select the release. Voice readiness and `releaseCommit` match Remote before router and supervisor handoff. Active Pi turns continue under their recorded release; a replacement supervisor adopts them after settlement.
4. `deploy/smoke` checks all web entrypoints, assets, Meet, Android CORS, Voice, transcription and every open person's app calls. Failure restores the earlier Remote and Voice selection and hands supervisors back. The restored release's own smoke script checks its own contract.

Pi is the sole agent runtime. Runtime generations and dependency trees remain while any Pi process or browser daemon uses them. An unpublished upstream Pi commit may be carried in [`vendor/pi`](../vendor/pi/README.md) with its source provenance. Pi Remote's staged import check uses the production dependency tree, not a writer checkout, and checks the supervisor, router, person CLI, Voice and Meet adapter before service activation.

## Leaving live development

Live development uses optional `pi-remote-dev-web@USER.service` and `pi-remote-dev-supervisor@USER.service` units with `/etc/pi-stack/dev-remote-USER.env`. See [the development unit contract](../apps/remote/README.md#live-development) for installation and the package restoration on stop. A production release should not select the live checkout or its overrides.

When moving work from live development into a release, first commit the source checkout's useful changes and record its SHA. Fetch that SHA into the release writer, incorporate its content, and retain its ancestry if the final tree deliberately replaces it. Do not reset, clean or stash away unique source. End live meetings and save transcripts before a supervisor handoff. After the checked release is ready, stop the relevant per-person development instances with `systemctl stop pi-remote-dev-web@USER.service pi-remote-dev-supervisor@USER.service`. Confirm `ExecStopPost` restored the selected production package. Remove that person's `/etc/pi-stack/dev-remote-USER.env` only after stopping the units; remove any temporary source override in host service configuration and reload the manager. Do not restart `pi-remote@USER.service` just to leave live development, since it may own an active turn.

The host handbook owns any NixOS generation switch, ingress route change and release wrapper invocation. Run the configured publication target wrappers for the same integration SHA. After release, check that Voice's effective unit has no development source override, the router serves the production frontend, host smoke and commit markers match, and no development unit owns the selected Pi package. Retire any direct supervisor or development-web ingress route; keep the router as the published API entrance.

## Browser recovery

If a loaded native browser extension and executable have different versions, replace the process after its work settles rather than changing a child shell's `PATH`. Interactive Pi can use `/reload` when its loader supports physical extension entrypoints; older processes must reopen their existing session. Remote adopts active turns and replaces their runtimes when they settle. Fleet recovery uses the recorded Orchestrator release and exact JSONL without replaying finished work. `abort` and `kill` are terminal actions, not dependency reloads.

```sh
pi-agent-browser-doctor
pi-agent-browser-doctor \
  --worker-release /srv/pi/.pi-stack-releases/orchestrator/COMMIT \
  --session-file /absolute/path/to/settled-session.jsonl
```

The [doctor](../packages/runtime/browser-doctor.mjs) checks both extension-loading phases, native registration, an interactive snapshot, screenshot and cleanup. Its saved-session probe copies a settled JSONL to a temporary directory rather than modifying the canonical session or ledger. A failed probe retains its files for diagnosis. Retain old runtime trees until their loading processes exit. `PI_TEST_RUNTIME_ENTRY=file:///srv/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js node --test packages/runtime/extensions/browser/browser.test.mjs` tests release switching against the deployed SDK.

## Checks and Android updates

```sh
npm ci --ignore-scripts
npm run check
npm run android:test --workspace=kenan
```

CI owns the full source gate; deployment reuses passing preparation results instead of rebuilding unchanged stages. `node --test scripts/deploy-lock.test.mjs scripts/deploy-build.test.mjs scripts/deploy-prepare.test.mjs` checks the deployment lock, build reuse, source isolation, activation and rollback with fixture people, services and listeners.

The publication owner builds the Android artifact on its local target using the host-owned, ignored `apps/kenan/android/local.properties`. [`deploy/android-update`](../deploy/android-update) checks the APK's embedded release identity against source and package metadata, hashes it, and packages its embedded web assets as `<revision>.web.zip` with a manifest. It installs identical bytes on each configured target and checks manifests and downloads through their front doors. The app applies a matching web bundle in place and offers an APK only for a native change; [the app README](../apps/kenan/README.md#in-app-updates) owns the client decision.

Each host stores current and retained releases under `/var/lib/pi-remote/app-updates`. The installer normally keeps three generations. `PI_REMOTE_APP_UPDATES_KEEP_ALL=1` preserves every generation during a no-deletion hold; `PI_REMOTE_APP_UPDATES_DIR` chooses a rehearsal root. Failed requests retain staged artifacts under their proof directory. Successful requests remove staging copies only after all targets verify. A remote transfer uses `<androidTransferRoot>/<request>` and the deployed release checkout, not a mutable writer checkout. Packages stay on private Pi Remote hosts rather than public GitHub assets. For an artifact-only repair from a clean source checkout:

```sh
deploy/android-update prepare /absolute/private/artifact-directory
sudo deploy/android-update install /absolute/private/artifact-directory
deploy/android-update verify /absolute/private/artifact-directory/manifest.json
```

## Release verification

- Every target's `/srv/pi/pi-remote/.pi-stack-commit`, Orchestrator marker and Voice `/status.releaseCommit` match the integration SHA.
- The configured required units and fleet daemon are active; the router identifies the configured environment and every unlocked supervisor reports the expected commit and environment ID. Locked people do not need to be unlocked for proof. Failed Pi units reject the release.
- `deploy/smoke` passes for the router, open people, Voice, transcription and web assets. Name-only protected requests fail, and each authenticated endpoint list respects its person's grants.
- No direct supervisor or development-web route bypasses the router. UID gates protect loopback supervisor and control ports.
- The target wrappers' own host-specific checks and Android manifest/download hashes pass. Publication records both those proofs and its final target proofs before it reports success.
