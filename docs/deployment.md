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

**systemd units.** [`deploy/systemd`](../deploy/systemd) holds reference units for `pi-remote-router.service`, `pi-remote@.service`, and `pi-orchestrator@.service`, written for a Debian host with Bun and Node under `/usr/local/bin`. A Debian host installs them as they are; a NixOS host declares the same units in its configuration. They point at stable paths under `/srv/pi`, so a release never changes them.

Persons are not in the host file. They are Pi Remote's registry, `/var/lib/pi-remote/persons/<user>.json`, created with `pi-remote person add`. See [the Pi Remote README](../apps/remote/README.md#persons).

## What deploy/host does

1. Installs the dependency tree once per manifest, lockfile and stack doctor source under `/srv/pi/dependencies`. Runtime, Orchestrator, and tools link that tree instead of copying it.
2. Publishes commit-addressed releases of the runtime (`/srv/pi/runtime`: Pi, `agent-browser`, and the runtime extensions), the Orchestrator, Pi Remote, the tools, and the skills. Each destination is a symlink switched atomically; prior generations stay under `/srv/pi/.pi-stack-releases` for processes that loaded them.
3. For every account (each person plus the fleet user): links `pi`, `agent-browser`, `pi-agent-browser-doctor`, `pi-orchestrator`, `pi-remote`, and every tool command into `~/.local/bin`; links the reviewed skills and the host's skills into `~/.pi/agent/skills`; rewrites the `packages` list in `~/.pi/agent/settings.json` under Pi's own lock, installs the pinned npm packages, and writes the VCC policy and custom model catalog.
4. Loads the deployed native browser tool under the fleet account's normal settings and proves open, interactive snapshot, title, and isolated-browser cleanup against a loopback page. A failure blocks service activation. Then restarts the fleet daemon. Live workers keep the release they recorded in their run row.
5. If Pi Remote changed, restarts the front door and hands each running supervisor the new release. Active Pi turns keep their process and stream; the replacement supervisor adopts them and replaces each runtime after it settles. The front door starts every open person's supervisor before it listens, so deployment first waits for `/v1/router-health`, then asks only the supervisors reporting another commit to hand over, then waits until every unlocked person's health response names the selected commit. A slow start or handoff therefore cannot race the smoke check or rollback. A rollback resets the supervisor units first, since one that crashed on the rejected release may have exhausted its start limit.
6. Walks the live front door the way the clients do (`deploy/smoke`): the web assets, the Android preflight for the person header, the environment and person lists, and for every unlocked person the first calls the app makes. A release that fails this is switched back to the previous Pi Remote release on the spot, the supervisors are handed that release again, and the command fails. Tests prove a release works; this proves nobody is locked out of the app by it.

An unchanged host redeploy takes a few seconds, including the native browser probe. A clean dependency install takes a few seconds. A deployment whose destinations are overridden with `PI_STACK_*_DEST` is a rehearsal: it publishes into those paths and touches no service unless `PI_STACK_SERVICES=1`.

The native browser extension and executable belong to the same immutable dependency tree. The [browser runtime entrypoint](../packages/runtime/extensions/browser/README.md) resolves that tree when Pi loads it and puts its physical `.bin` path first in the process environment. Live turns keep their pair across a release switch. New, recovered and reloaded sessions select both together. The native extension is not installed into an account's mutable npm directory. Pi resolves the physical extension entrypoint before importing it, so its native ESM cache cannot keep the first target of a switched symlink on reload.

Retain runtime releases and their dependency trees while any Pi process or browser daemon uses them. A run's recorded Orchestrator release is not a complete browser reference: recovery may load a newer browser pair through current settings. Deployment does not garbage-collect these trees.

Pi normally comes from the npm registry. When an unpublished upstream commit is selected, [`vendor/pi`](../vendor/pi/README.md) holds the built source packages and their exact provenance. `deploy/runtime` copies those packages into its isolated production install before running `npm ci`.

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

The stack's [doctor](../packages/runtime/browser-doctor.mjs) uses actual Pi source registration and the native version guard, rather than upstream's package-name heuristic. The recovery probe copies the JSONL into a temporary directory and opens it through the recorded release's SDK. Use a settled session because its extension startup hooks may recover browser cleanup leases. The browser script uses a separate, disposable browser identity. Success removes the probe files; failure reports the retained session path and cleanup state. The canonical JSONL and Orchestrator ledger are not written. This proves browser recovery, not a new research turn. Cached npm copies from earlier installations can be removed after their loading processes exit; deployment does not uninstall code underneath them.

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
- `pi-remote-router.service`, each unlocked `pi-remote@<user>.service`, and `pi-orchestrator@<fleet>.service` are active;
- `curl -H 'x-pi-remote-user: <user>' http://127.0.0.1:8788/v1/health` reports the intended environment id;
- `pi-orchestrator status` answers;
- Kenan can switch environments without crossing threads, keys, voice, or downloads.
