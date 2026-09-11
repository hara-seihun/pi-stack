# Deployment

One reviewed commit goes to every host with one command:

```bash
cd /home/kenan/projects/pi-stack && git pull --ff-only && deploy/host
```

`deploy/host` reads `/etc/pi-stack/host.json`, refuses a dirty checkout, holds one lock on the checkout, and must finish inside 50 seconds. Every artifact it publishes carries the commit in a `.pi-stack-commit` file; the deployed commit on a host is whatever `/srv/pi/pi-remote/.pi-stack-commit` says.

## What a host provides

The stack is the same on every machine. A host supplies three things.

**Unix accounts.** One for each person who uses Pi Remote, and one that runs the fleet daemon. The fleet account is ordinarily a person too.

**The host file** at `/etc/pi-stack/host.json`:

```json
{
  "version": 1,
  "fleetUser": "kenan",
  "environments": [
    { "id": "local", "name": "Local", "baseUrl": "" },
    { "id": "converge", "name": "Converge", "baseUrl": "/converge" }
  ],
  "packages": ["/etc/nixos/pi-agent/extensions/scratch-updates"],
  "skills": ["/etc/nixos/pi-agent/skills/math-research"]
}
```

`environments` lists the browser's host choices and their same-origin path prefixes. It is optional; without it, clients see only this host. The router and supervisors read this list from the host file, independent of the person registry. `PI_STACK_HOST_FILE` selects another host file for tests or custom installations. Restart the router after changing the list.

`fleetUser` runs `pi-orchestrator@<user>.service`. `packages` are extra Pi packages every account loads, placed after the reviewed ones and before the Pi Remote context observer. `skills` are extra skill directories linked into every account's skill directory under their own names. Both are optional and point at paths the host owns.

**systemd units.** [`deploy/systemd`](../deploy/systemd) holds reference units for `pi-remote-router.service`, `pi-remote@.service`, `pi-orchestrator@.service`, and `pi-stack-voice.service`. Debian installs these references; NixOS declares matching units with its packaged executables. Host release wrappers install changed references before `deploy/host`. The units select stable paths under `/srv/pi`; code releases do not rewrite unit files. Voice uses `/usr/bin/env bun` with both hosts' system paths and requires `systemd-notify`.

Voice requires `/var/lib/pi-stack-voice/openai-api-key`, root-owned mode `0600` in a root-owned `0700` directory. The host credential owner provisions it; deployment never fetches or copies a key. `LoadCredential` gives the dynamic service user a private copy. Its persistent session leases and expiry state live in `/var/lib/pi-stack-voice-runtime/sessions.sqlite3`. This is an OpenAI API connection, independent of Orchestrator OAuth credentials. Its loopback listener is `127.0.0.1:8796`; supervisors use `PI_STACK_VOICE_URL` to select another endpoint. Browser clients never receive the key.

Persons are not in the host file. They are Pi Remote's registry, `/var/lib/pi-remote/persons/<user>.json`, created with `pi-remote person add`. See [the Pi Remote README](../apps/remote/README.md#persons).

## What deploy/host does

Pi Remote runs parent and delegated child sessions in one SDK runner per person and release generation; see [runner ownership and admission](../apps/remote/README.md). The reference supervisor unit caps its complete process tree at 16 GiB RAM and 1 GiB swap. Hosts with multiple people also declare an aggregate cap on the implicit `system-pi\x2dremote.slice` (GMKtec uses the same 16 GiB / 1 GiB ceiling across all people). The runner checks constrained ancestors before admitting another session, including memory used by browser children. These limits contain runaway subprocesses; sharing SDK sessions does not make browser subprocesses share a heap. Keep `MemoryHigh` at the hard limit on these hosts to avoid the prolonged reclaim stalls seen with a lower soft limit.

Before publishing anything, `deploy/host` checks that the Voice unit and credential exist and that live-dev services and Voice source overrides have been retired. A rehearsal with overridden destinations skips host-service checks.

1. Prepares PiStack Meet's local transcription runtime through `deploy/transcription`. Its pinned Whisper model and hash-locked Python dependencies live under `/srv/pi/.pi-transcription`, selected by `/srv/pi/transcription`. Hosts need `uv`; model preparation runs alongside JavaScript dependency installation. `PI_STACK_TRANSCRIPTION_DEST` selects a separate destination for a rehearsal. Installs the JavaScript dependency tree once per manifest, lockfile and stack doctor source under `/srv/pi/dependencies`. Runtime, Orchestrator, and tools link that tree instead of copying it.
2. Publishes commit-addressed releases of the runtime (`/srv/pi/runtime`: Pi, `agent-browser`, and the runtime extensions), the Orchestrator, Pi Remote, the tools, and the skills. Each destination is a symlink switched atomically; prior generations stay under `/srv/pi/.pi-stack-releases` for processes that loaded them.
3. For every account (each person plus the fleet user): links `pi`, `agent-browser`, `pi-agent-browser-doctor`, `pi-orchestrator`, `pi-remote`, and every tool command into `~/.local/bin`; links the reviewed skills and the host's skills into `~/.pi/agent/skills`; rewrites the `packages` list in `~/.pi/agent/settings.json` under Pi's own lock, installs the pinned external packages, and writes the custom model catalog. The manifest selects the stack-owned [Codex compaction extension](../packages/runtime/extensions/codex-compaction/README.md); Pi owns its compaction timing and continuation.
4. Loads the deployed native browser tool under the fleet account's normal settings and proves open, interactive snapshot, title, and isolated-browser cleanup against a loopback page. A failure blocks service activation. Then restarts the fleet daemon. Live workers keep the release they recorded in their run row.
5. Enables Voice and starts the selected release when `/status` reports another commit. Voice's notify readiness and `/status.releaseCommit` must match Pi Remote before supervisor activation. Its provider sessions and heartbeat database survive a service restart. If Pi Remote changed, restarts the front door and hands each running supervisor the new release. Active Pi turns keep their process and stream; the replacement supervisor adopts them and replaces each runtime after it settles. The front door starts every open person's supervisor before it listens, so deployment first waits for `/v1/router-health`, then asks only the supervisors reporting another commit to hand over, then waits until every unlocked person's health response names the selected commit. A slow start or handoff therefore cannot race the smoke check or rollback. A rollback resets the supervisor units first, since one that crashed on the rejected release may have exhausted its start limit.
6. Walks the live front door through `deploy/smoke`: all three web entrypoints, their assets, the standalone Meet adapter, Android CORS, environment/person discovery, and every unlocked person's initial app calls, Voice release identity and transcription availability. A dead router is a failure, not a skipped check. Failure restores the previous Pi Remote selection and its Voice implementation before handing supervisors back. A generation without the shared Voice implementation stops that new unit. Each new Remote release carries its own smoke script and helper so rollback checks the restored release's contract rather than requiring new assets from older code.

An unchanged host redeploy takes a few seconds, including the native browser probe. A clean dependency install takes a few seconds. A deployment whose destinations are overridden with `PI_STACK_*_DEST` is a rehearsal: it publishes into those paths and touches no service unless `PI_STACK_SERVICES=1`.

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

Stopping the live-dev supervisor restores the deployed capture package and resumes its original supervisor wrapper. Do not restart `pi-remote@kenan.service`; that would kill active Pi turns. Change only the root Tailscale route, not the other applications or `/converge` route.

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

## Kenan

The Android app embeds its endpoint list from a JSON file named in `apps/kenan/android/local.properties`, which is not committed; see [the Kenan README](../apps/kenan/README.md#build-configuration). An SSH endpoint's account must allow local forwarding only to the front door's port. The browser client instead asks the host it was served from for its environment list, declared once as `environments` in `/etc/pi-stack/host.json`.

## Release verification

- `/srv/pi/pi-remote/.pi-stack-commit` matches on every host;
- `pi-remote-router.service`, each unlocked `pi-remote@<user>.service`, `pi-stack-voice.service`, and `pi-orchestrator@<fleet>.service` are active;
- `curl -fsS http://127.0.0.1:8796/status` reports the same `releaseCommit`;
- `/v1/meet` reports `transcriptionAvailable: true`, and `/meet-adapter.js` exports `startMeetAdapter`;
- `curl -H 'x-pi-remote-user: <user>' http://127.0.0.1:8788/v1/health` reports the intended environment id;
- `pi-orchestrator status` answers;
- Kenan can switch environments without crossing threads, keys, voice, or downloads.
