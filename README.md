# Pi stack

Pi Stack runs persistent agents through [Pi](https://github.com/badlogic/pi-mono), with an orchestrator, browser and Android clients, shared skills, and shell tools.

## Contents

- [`packages/runtime`](packages/runtime/README.md) pins Pi and owns the runtime extensions.
- [`packages/orchestrator`](packages/orchestrator/README.md) schedules and hosts persistent agent work.
- [`packages/kenan-memory`](packages/kenan-memory/README.md) owns optional shared host memory, discretion tools and the disclosure log. The [life model](docs/life-model.md) owns versioned per-person authority, goals, commitments, preferences, steering history and Remote's Needs-you projection.
- [`apps/remote`](apps/remote/README.md) contains the Pi Remote supervisor, shared client, and context mirror extension. [Per-person VS Code](docs/editor.md) owns Files editing, isolated origins and provisioning.
- [`apps/kenan`](apps/kenan/README.md) packages the shared client for Android.
- [Feature use](docs/feature-usage.md) records own-person metadata for actual feature actions and observed availability.
- [`skills`](skills/README.md) contains the shared first-party skills loaded by interactive and fleet agents.
- [`tools`](tools/README.md) contains commands whose contracts depend on Pi or its session format.

This public repository starts from a reviewed source snapshot. Earlier development history contains private operational records and is not part of the public Git history.

[Explicit app states](docs/state-dispatch.md) requires exhaustive state/event dispatch, boundary rejection of invalid discriminators, and no first-party switch default clauses. The source gate enforces the switch rule; typed dispatch and transition tests enforce behavior.

Upstream Pi is a pinned dependency. Host identities, endpoints and deployment routes belong in host configuration. Credentials, person registries and mutable runtime state stay outside Git. See [configuration and publication boundaries](docs/publication.md).

## Development

Install every JavaScript workspace from the root:

```bash
npm ci --ignore-scripts
npm run check
npm run android:test --workspace=kenan
```

`npm run check` runs builds, static checks, and independent suites in a bounded pool (up to four jobs by default; `PI_STACK_CHECK_CONCURRENCY` sets the budget). [`scripts/run-jobs.mjs`](scripts/run-jobs.mjs) divides that budget among active jobs so nested pools, workspace shards and the [`Node test runner`](scripts/test-node.mjs) do not multiply host concurrency. It streams labelled output immediately, bounds each admitted job to two minutes, and fails an exited job whose descendants keep its output streams open. This prevents a detached test runtime from silently keeping publication alive after the tests finish. Deployment checks partition the two complete host-activation/rollback matrices into separate guest-enabled and guest-disabled jobs; the lock/build job owns every other deployment contract. All three share the pool budget and retain every check without charging both matrices against one deadline. The Orchestrator shard regression invokes `npm test --workspace=pi-orchestrator` just like the publication shards: its `pretest` builds memory and prepares shared RPC before the native wake proof runs, including after an install with scripts disabled. Maintainers run the same gate through the configured publication owner. This repository has no GitHub Actions runner or workflow. Public pull requests never execute automatically on deployment hosts. The Android project keeps its Gradle build because it has no useful dependency boundary with the JavaScript workspaces.

[`config/packages.json`](config/packages.json) owns the Pi package order every account loads, including the [Claude OAuth runtime](packages/runtime/extensions/claude-oauth/README.md) and the browser runtime entrypoint. The Claude runtime loads upstream `@pi-plugins/claude-oauth` 0.3.7 with a release-owned version patch advertising Claude Code 2.1.280 and preserves Pi's model-specific output limits, cache-retention markers and request-specific feature betas. It also handles mid-conversation system messages. Those upstream fixes replace the temporary `hara-seihun/pi-plugins` fork. That entrypoint loads `pi-agent-browser-native` and pins `agent-browser` from the same immutable dependency tree. [`config/skills.json`](config/skills.json) lists the first-party skills and [`config/tools.json`](config/tools.json) the commands. The checks validate package identities, pins and deployed paths.

## Deployments

The maintained fleet uses an Ubuntu local server and a Debian remote VM. Hosts can declare the CPU-only [Meet recognition service](apps/meet-recognition/README.md) for external meeting transcripts. Linux hosts supply systemd services and their own package provisioning; see [host platforms](docs/deployment.md#host-platforms).

`deploy/publication submit SHA` hands a reviewed source commit to the durable worker for one checked integration and independent delivery to every configured target. Each ready host receives its matching Android/web artifact before server activation, retains durable delivery proof and releases its reservation immediately. Meetings, native prerequisites, locks or failure on another host do not hold it back. Newer checked requests can advance ready hosts while older deliveries wait; older requests accept checked descendant proofs without downgrading source or artifacts. Full completion still requires valid source and artifact delivery on every target.

Its host wrappers call `deploy/host`, which reads a small host file naming the fleet account and any local packages and skills. Persons come from Pi Remote's registry. The scripts under [`deploy`](deploy) refuse an uncommitted checkout and serialize host deployment across source checkouts. Preparation shares the publication owner's deadline; host activation and standalone component deployment enforce a 50-second deadline. Commit-addressed releases share one production dependency tree and switch atomically. See [`docs/deployment.md`](docs/deployment.md).

### Account onboarding

Run `sudo deploy/account USER` from the clean source checkout of the installed release. It checks the runtime, Orchestrator, Remote, tools and skills commit markers before changing the account. It then reconciles that user's command links, skills, settings and model catalog without installing dependencies, publishing shared artifacts or restarting services. The Unix account and home must already exist.

The command takes `/srv/pi/.pi-stack-deploy.lock` without waiting. A host provisioning hook that already holds that lock passes `PI_STACK_HOST_LOCK_HELD=1`. Source and live commit mismatches fail with exit 66; a busy host deployment fails with exit 75. Retry after the host release finishes. `deploy/runtime`, `deploy/tools` and `deploy/skills` expose the same reconciliation through `--links-only USER`. Reviewed npm packages in settings resolve to exact installed pins in the shared runtime, so onboarding does not fetch packages into a new user's home.

Pi Remote exposes one authenticated router entrance. A person unlocks there, then `GET /v1/environments` returns only the endpoints allowed by her `remoteAccess` registry entry. The default is this host alone. Host configuration owns endpoint IDs, names, icons and per-person supervisor upstreams; no endpoint name grants access.

Browser and Android clients switch endpoints through same-origin `/v1/remotes/<id>` routes. Android embeds only `piRemoteRouterUrl`, not endpoint lists or SSH credentials. A name in a header or query is a hint, never authentication. Router sessions replace the previous name-only identity contract. See [gateway configuration](docs/deployment.md#gateway-access-and-host-boundaries).

## Architecture

[Kena: one agent model](docs/agents.md) owns named agents, foreground/background placement, protected peer dependencies and the shared execution budget. [Unified threads](docs/threads.md) describes the persistent conversation API, shared Pi execution, messaging, cancellation and model defaults. Remote, fleet lanes and agents use the same thread operations. The [personal watch list](docs/watch-list.md) lets agents maintain persistent checks and wakes an Opus 5.5 thread only when work is due.

[`docs/architecture.md`](docs/architecture.md) describes repository boundaries, environment identity, Android state isolation, and the work-thread cutover. [One Kenan per machine](docs/one-kenan.md) owns the optional root runtime, fixture staging and reversible cutover. The flag-gated [action journal](docs/action-journal.md) captures outbound sends into Kenan's shared memory.
