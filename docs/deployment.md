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
  "packages": ["/etc/nixos/pi-agent/extensions/scratch-updates"],
  "skills": ["/etc/nixos/pi-agent/skills/math-research"]
}
```

`fleetUser` runs `pi-orchestrator@<user>.service`. `packages` are extra Pi packages every account loads, placed after the reviewed ones and before the Pi Remote context observer. `skills` are extra skill directories linked into every account's skill directory under their own names. Both are optional and point at paths the host owns.

**systemd units.** [`deploy/systemd`](../deploy/systemd) holds reference units for `pi-remote-router.service`, `pi-remote@.service`, and `pi-orchestrator@.service`, written for a Debian host with Bun and Node under `/usr/local/bin`. A Debian host installs them as they are; a NixOS host declares the same units in its configuration. They point at stable paths under `/srv/pi`, so a release never changes them.

Persons are not in the host file. They are Pi Remote's registry, `/var/lib/pi-remote/persons/<user>.json`, created with `pi-remote person add`. See [the Pi Remote README](../apps/remote/README.md#persons).

## What deploy/host does

1. Installs the dependency tree once per lockfile under `/srv/pi/dependencies`. Runtime, Orchestrator, and tools link that tree instead of copying it.
2. Publishes commit-addressed releases of the runtime (`/srv/pi/runtime`: Pi, `agent-browser`, and the runtime extensions), the Orchestrator, Pi Remote, the tools, and the skills. Each destination is a symlink switched atomically; prior generations stay under `/srv/pi/.pi-stack-releases` for processes that loaded them.
3. For every account (each person plus the fleet user): links `pi`, `agent-browser`, `pi-orchestrator`, `pi-remote`, and every tool command into `~/.local/bin`; links the reviewed skills and the host's skills into `~/.pi/agent/skills`; rewrites the `packages` list in `~/.pi/agent/settings.json` under Pi's own lock, installs the pinned npm packages, and writes the VCC policy and custom model catalog.
4. Restarts the fleet daemon. Live workers keep the release they recorded in their run row.
5. If Pi Remote changed, restarts the front door and hands each running supervisor the new release. Active Pi turns keep their process and stream; the replacement supervisor adopts them and replaces each runtime after it settles.
6. Walks the live front door the way the clients do (`deploy/smoke`): the web assets, the Android preflight for the person header, the environment and person lists, and for every unlocked person the first calls the app makes. A release that fails this is switched back to the previous Pi Remote release on the spot, the supervisors are handed that release again, and the command fails. Tests prove a release works; this proves nobody is locked out of the app by it.

An unchanged host redeploy takes about a second. A clean dependency install takes a few seconds. A deployment whose destinations are overridden with `PI_STACK_*_DEST` is a rehearsal: it publishes into those paths and touches no service unless `PI_STACK_SERVICES=1`.

## Build checks

```bash
npm ci --ignore-scripts
npm run check
npm run android:test --workspace=kenan
```

CI runs the same gate from a persistent self-hosted checkout. Deployment does not repeat tests that already passed on the commit.

## Kenan

The Android app embeds its endpoint list from a JSON file named in `apps/kenan/android/local.properties`, which is not committed; see [the Kenan README](../apps/kenan/README.md#build-configuration). An SSH endpoint's account must allow local forwarding only to the front door's port. The browser client instead asks the host it was served from for its environment list (`PI_REMOTE_ENVIRONMENTS` in the person files).

## Release verification

- `/srv/pi/pi-remote/.pi-stack-commit` matches on every host;
- `pi-remote-router.service`, each unlocked `pi-remote@<user>.service`, and `pi-orchestrator@<fleet>.service` are active;
- `curl -H 'x-pi-remote-user: <user>' http://127.0.0.1:8788/v1/health` reports the intended environment id;
- `pi-orchestrator status` answers;
- Kenan can switch environments without crossing threads, keys, voice, or downloads.
