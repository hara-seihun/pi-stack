# Pi stack

This repository owns Hara's custom Pi runtime, agent orchestrator, remote clients, shared skills, and Pi-specific shell tools.

## Contents

- [`packages/runtime`](packages/runtime/README.md) pins Pi and owns the runtime extensions.
- [`packages/orchestrator`](packages/orchestrator/README.md) schedules and hosts persistent agent work.
- [`apps/remote`](apps/remote/README.md) contains the Pi Remote supervisor, shared client, and context mirror extension.
- [`apps/kenan`](apps/kenan/README.md) packages the shared client for Android.
- [`skills`](skills/README.md) contains the shared first-party skills loaded by interactive and fleet agents.
- [`tools`](tools/README.md) contains commands whose contracts depend on Pi or its session format.

The component histories were imported into their final directories. `git log --follow` reaches work from the repositories that preceded this one.

Upstream Pi remains a pinned npm dependency. Machine identities, URLs, ports, credentials, services, and mutable state stay in the NixOS and Converge infrastructure repositories.

## Development

Install every JavaScript workspace from the root:

```bash
npm ci --ignore-scripts
npm run check
npm run android:test --workspace=kenan
```

`npm run check` launches builds, static checks, and independent suites together. It takes about four seconds on GMKtec. GitHub runs the same gate from a private persistent checkout whose tracked source is reset for every event. Its lock-validated `node_modules` tree survives runner and machine restarts. The Android project keeps its Gradle build because it has no useful dependency boundary with the JavaScript workspaces.

[`config/packages.json`](config/packages.json) owns the Pi package order every account loads, including the pinned `npm:pi-agent-browser-native` package; its separate `agent-browser` executable comes from the runtime dependency tree. [`config/skills.json`](config/skills.json) lists the first-party skills and [`config/tools.json`](config/tools.json) the commands. The checks reject unknown or misplaced entries, including a Pi Remote context observer that is not last.

## Deployments

Every host deploys one reviewed commit with `deploy/host`, which reads a small host file naming the fleet account and any local packages and skills. Persons come from Pi Remote's registry. The scripts under [`deploy`](deploy) refuse an uncommitted checkout, serialize work from the same source tree, and enforce a 50-second deadline. Commit-addressed releases share one production dependency tree and switch atomically. See [`docs/deployment.md`](docs/deployment.md).

Pi Remote environments are independent servers:

- `local` runs Personal and Home threads on GMKtec.
- `converge` runs one work profile directly on Converge.

The Kenan drawer switches between them, and would between more. The browser client reads the list from the host that served it; the Android build embeds its own list from a file named in `apps/kenan/android/local.properties`, which is not committed.

## Architecture

[`docs/architecture.md`](docs/architecture.md) describes repository boundaries, environment identity, Android state isolation, and the work-thread cutover.
