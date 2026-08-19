# Pi runtime roadmap

[Machine handbook](../../machine/README.md) → [Pi and Pi Remote](../../machine/pi.md) → Roadmap

Planned work on this repository that is agreed but not yet done. An item leaves this file when it is
implemented (and its behavior is documented in the owning component README) or when it is dropped.

---

## Publish this runtime layer as versioned packages with a non-disruptive upgrade path

**Requested by Hara, 2026-08-19. Not started.**

**Decided:** publication is **public**, under the GitHub account **[`hara-seihun`](https://github.com/hara-seihun)** (already authenticated here through `gh`, and the owner of the public `hara-seihun/pi-cursor` fork). The present private `owi-link/pi-runtime` remote is a work-side deployment channel, not the publication home. Because the artifact is public, **all machine-specific behavior must be factored out**, not merely made overridable: nothing in the published packages may assume this host, this user, these accounts, this systemd layout, or NixOS.

Everything in this repository is currently consumed by copying a Git checkout onto a host and running
[`deploy`](deploy), which symlinks executables and extension directories straight out of the working
tree. Two installations already exist — GMKtec and `converge-kenan` — and they drift: on 2026-08-19
`converge-kenan` was a commit behind, still ran sessions in-process rather than under agent hosts, and
could not take a controller restart without killing five live agents. A shared repository with two
hand-deployed working copies is not a distribution mechanism.

### Goal

The orchestrator and the locally owned Pi additions become published, versioned packages that any
installation consumes by version, so both machines (and any later one) can be updated continuously and
independently, and so an update is a routine, reversible, non-destructive operation.

### Scope: what becomes a package

| Component | Today | Notes |
|---|---|---|
| [`orchestrator/`](orchestrator/README.md) | script symlinked into `~/.local/bin`, systemd unit in `/etc/nixos` | the controller, agent hosts, governors, CLI |
| [`extensions/context-guard/`](extensions/context-guard/README.md) | directory symlinked into `~/.pi/agent/extensions` | pi extension |
| [`extensions/pi-usage-logger/`](extensions/pi-usage-logger/README.md) | local package path in `settings.json` | pi extension + `pi-usage` CLI |
| [`extensions/chatgpt-pro/`](extensions/chatgpt-pro/README.md) | symlinked directory + `pro` executable | pi extension, Kernel browser bridge |
| [`extensions/pi-claude-code-use/`](extensions/pi-claude-code-use/README.md) | local package path, deliberately shadowing an npm package | pi extension |
| [`plan-meter/`](plan-meter/README.md), [`prompt-eval/`](prompt-eval/README.md), [`usage/`](usage/) | symlinked CLIs | may publish separately or as one tool package |

Decide package granularity as part of the work: one umbrella package is simplest to keep version-coherent
(the orchestrator imports `extensions/chatgpt-pro/browser.mjs` and `extensions/pi-usage-logger/logger.mjs`
directly today), while separate packages let a pi user adopt one extension without the orchestrator.

### Requirements

1. **Published artifact.** Public npm packages, source public on `hara-seihun`. Needs a package scope,
   a licence, a public README per package written for a reader with none of our context, and a
   contribution/issue posture. Our two installations then consume the same public versions as anyone
   else; there is no private fork path.
2. **Semantic versions and a release command.** One command tests, versions, publishes, and tags. A host
   updates by installing a version, never by pulling a branch; `orchestrator check` reports the running
   package version alongside the existing code fingerprint.
3. **Deployment that does not kill running work.** GMKtec already has the right shape: a code fingerprint
   pins each agent host, a new generation starts on change, the superseded host is marked `draining` and
   exits when empty, and control flows through SQLite so an older host stays governable. That property
   must become universal and enforced by the installer — an upgrade must never terminate a live session,
   on any installation, and the in-process session mode that still exists on `converge-kenan` has to go.
   Include a rollback path: installing the previous version must be equally safe.
4. **Real schema migrations.** `openDb()` currently carries ~28 ad-hoc `PRAGMA table_info` /
   `ALTER TABLE` blocks executed on every open, with no recorded schema version. Replace this with an
   ordered, numbered, tested migration ledger that records the applied version, is forward-only, and is
   additive-first — a mixed-version window is normal here, because a draining host runs older code
   against the same database while the new controller runs the new code. Add a test that opens every
   historical schema and migrates it forward.
5. **Factor out every machine-specific behavior.** Config and state stay outside the package —
   `~/data/agent-orchestrator/{config.json,orchestrator.sqlite3,…}` (already overridable through
   `AGENT_ORCHESTRATOR_DATA`), `providers.json`, `~/.pi/agent/*`, credentials, and the systemd units in
   `/etc/nixos`. A published default may point at a conventional location, but no code path may depend
   on this machine. Known items to remove or generalize:

   - **Absolute local paths.** `/home/kenan/data/alerts/inbox` in `extensions/context-guard/index.mjs`;
     the `/home/kenan` fallback in `extensions/pi-usage-logger/database.mjs`; the
     `/home/kenan/tools/pi-runtime/...` documentation path quoted in `extensions/chatgpt-pro/browser.mjs`
     failure text; the two hard-coded settings-path spellings inside [`deploy`](deploy).
   - **This household's hosts.** `plan-meter` defaults its remote to `converge-kenan`; the roll-up and
     its docs assume a second named machine reachable by SSH alias. A published tool takes peers from
     configuration or has none.
   - **Alerts inbox as a machine surface.** context-guard writes to a private directory this machine's
     agents poll. Published behavior needs a general reporting hook (callback, log, or configured path)
     with the inbox as one local configuration.
   - **systemd and cgroup assumptions.** `pi-agents.slice`, `pi-tools.slice`,
     `agent-orchestrator.service`, `/sys/fs/cgroup/system.slice/...` memory reads, `systemd-run --user`
     transient hosts, and [`tool-shell`](orchestrator/tool-shell) are Linux+systemd specific. Either
     declare that dependency explicitly as a supported execution backend and provide a portable
     fallback, or ship the units as documented examples rather than hard-coded strings.
   - **Our account naming and subscription policy.** `openai-codex-N` provider-index conventions,
     Multi-Pass pool assumptions, `chatgpt-pro-profiles.json`, the Kernel browser bridge, and
     model-policy bans on specific models belong in configuration and the provider manifest, not in
     package code.
   - **Our operating policy in prompts and docs.** Component READMEs quote this machine's paths,
     research campaigns, and quota anecdotes. Public docs describe the mechanism; machine-specific
     operating detail moves to [`machine/pi.md`](../../machine/pi.md) and this repository's private
     deployment notes.
   - **Secrets and identities.** Verify no account label, subscription identity, tailnet name, IP, or
     credential path reaches the public artifact — including test fixtures and committed sample state.
6. **Pinned upstream compatibility.** The package declares which `@earendil-works/pi-coding-agent`
   versions it supports and fails clearly on an unsupported one, so a runtime upgrade cannot silently
   break the extension API surface the orchestrator depends on.
7. **Validation on both installations.** After the switch, GMKtec and `converge-kenan` both install by
   version, both report the same version and schema, neither loses a session across an upgrade, and
   `machine/pi.md` plus each component README describe the new install/update path instead of `deploy`.
8. **Prove the factoring worked.** A clean checkout must pass its tests on a host with a different user,
   home directory, and hostname, with no `/home/kenan` present. Grepping the published tree for this
   machine's paths, hostnames, account labels, and unit names returns nothing.

### Why now

Two hosts share one Codex/Anthropic/Cursor account pool and one decentralized governor design, so a fix
to admission, attribution, or quota accounting on one machine is only half-deployed until the other takes
it. The 2026-08-19 operator-grant attribution change is the concrete example: committed and live here the
same hour, but it reaches `converge-kenan` only when someone manually deploys there, and deploying there
today would kill running agents.
