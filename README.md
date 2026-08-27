# Pi stack

This repository owns Hara's custom Pi runtime, agent orchestrator, remote clients, shared skills, and Pi-specific shell tools.

## Contents

- [`packages/runtime`](packages/runtime/README.md) pins Pi and owns the runtime extensions, model catalog, and prompt evaluator.
- [`packages/orchestrator`](packages/orchestrator/README.md) schedules and hosts persistent agent work.
- [`apps/remote`](apps/remote/README.md) contains the Pi Remote supervisor, shared client, and context mirror extension.
- [`apps/kenan`](apps/kenan/README.md) packages the shared client for Android.
- [`skills`](skills/README.md) contains the shared first-party skills loaded by interactive and fleet agents.
- [`tools`](tools/README.md) contains commands whose contracts depend on Pi or its session format.

The component histories were imported into their final directories. `git log --follow` reaches work from the repositories that preceded this one. The upstream `pi-cursor` history is retained as merge ancestry from its import at version 1.4.27.

Upstream Pi remains a pinned npm dependency. The reviewed `pi-cursor` source lives at [`packages/runtime/extensions/pi-cursor`](packages/runtime/extensions/pi-cursor/) and tracks upstream releases inside this repository. Machine identities, URLs, ports, credentials, services, and mutable state stay in the NixOS and Converge infrastructure repositories.

## Development

Install every JavaScript workspace from the root:

```bash
npm ci --ignore-scripts
npm run check
npm run android:test --workspace=kenan
```

`npm test` runs independent suites in parallel and normally finishes in under twenty seconds. The Android project keeps its Gradle build because it has no useful dependency boundary with the JavaScript workspaces.

[`config/package-sets.json`](config/package-sets.json) owns package order by host role. [`config/skill-sets.json`](config/skill-sets.json) owns the first-party skills each role loads. Their checks reject unknown or misplaced entries, including a Pi Remote context observer that is not last.

## Deployments

GMKtec and Converge deploy one reviewed repository commit. Host configuration supplies local values. The scripts under [`deploy`](deploy) refuse an uncommitted checkout, serialize work from the same source tree, and enforce a 50-second deadline. Commit-addressed releases share one production dependency tree and switch atomically. Host deployment keeps the source lock until every artifact carries one commit. `deploy/settings` and `deploy/skills` derive each role from the manifests. See [`docs/deployment.md`](docs/deployment.md).

Pi Remote environments are independent servers:

- `local` runs Personal and Home threads on GMKtec.
- `converge` runs one work profile directly on Converge.

The Kenan drawer switches between them. Endpoint URLs enter the build through `apps/kenan/android/local.properties`; they are not committed.

## Architecture

[`docs/architecture.md`](docs/architecture.md) describes repository boundaries, environment identity, Android state isolation, and the work-thread cutover.
