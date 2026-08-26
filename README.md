# Pi stack

This repository owns Hara's custom Pi runtime, agent orchestrator, remote clients, shared skills, and Pi-specific shell tools.

## Contents

- [`packages/runtime`](packages/runtime/README.md) pins Pi and owns the runtime extensions, model catalog, and prompt evaluator.
- [`packages/orchestrator`](packages/orchestrator/README.md) schedules and hosts persistent agent work.
- [`apps/remote`](apps/remote/README.md) contains the Pi Remote supervisor, web client, Android app, and context mirror extension.
- [`skills`](skills/README.md) contains the shared first-party skills loaded by interactive and fleet agents.
- [`tools`](tools/README.md) contains commands whose contracts depend on Pi or its session format.

The component histories were imported into their final directories. `git log --follow` reaches work from the repositories that preceded this one.

Upstream Pi and the third-party `pi-cursor` provider remain separate dependencies. Machine identities, URLs, ports, credentials, services, and mutable state stay in the NixOS and Converge infrastructure repositories.

## Development

Install every JavaScript workspace from the root:

```bash
npm ci --ignore-scripts
npm run check
cd apps/remote/android && ./gradlew test
```

`npm test` runs independent suites in parallel and normally finishes in under twenty seconds. The Android project keeps its Gradle build because it has no useful dependency boundary with the JavaScript workspaces.

[`config/package-sets.json`](config/package-sets.json) is the source of truth for package order by host role. Its check fails if Pi Remote's context observer is not last.

## Deployments

GMKtec and Converge deploy one reviewed repository commit. Host configuration chooses which components to publish and supplies local values. The scripts under [`deploy`](deploy) refuse an uncommitted checkout. See [`docs/deployment.md`](docs/deployment.md).

Pi Remote environments are independent servers:

- `local` runs Personal and Home threads on GMKtec.
- `converge` runs one work profile directly on Converge.

The Android drawer switches between them. Endpoint URLs enter the build through `apps/remote/android/local.properties`; they are not committed.

## Architecture

[`docs/architecture.md`](docs/architecture.md) describes repository boundaries, environment identity, Android state isolation, and the work-thread cutover.
