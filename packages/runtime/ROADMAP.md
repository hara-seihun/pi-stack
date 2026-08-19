# Pi runtime roadmap

[Machine handbook](../../machine/README.md) → [Pi and Pi Remote](../../machine/pi.md) → Roadmap

Planned work on this repository that is agreed but not yet done. An item leaves this file when it is
implemented (and its behavior is documented in the owning component README) or when it is dropped.

---

## Publish this runtime layer as versioned packages with a non-disruptive upgrade path

**Requested by Hara, 2026-08-19. Not started.**

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

1. **Published artifact.** Choose and document the registry (public npm under a Kenan scope, GitHub
   Packages against `owi-link/pi-runtime`, or Artifact Registry). *Open question for Hara: is this
   published publicly, or privately for our own hosts?* The answer changes naming, licensing, and how
   much machine-specific behavior must first be factored out.
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
5. **Machine-independent code, machine-local state.** The package must not assume this host. Config and
   state stay outside it: `~/data/agent-orchestrator/{config.json,orchestrator.sqlite3,...}` (already
   overridable through `AGENT_ORCHESTRATOR_DATA`), `providers.json`, `~/.pi/agent/*`, credentials, and
   the systemd units in `/etc/nixos`. Audit the remaining hard-coded paths first — currently the alerts
   inbox in `extensions/context-guard/index.mjs`, `extensions/pi-usage-logger/database.mjs`, and
   `extensions/chatgpt-pro/browser.mjs` — and give each one an environment or config override with a
   documented default.
6. **Pinned upstream compatibility.** The package declares which `@earendil-works/pi-coding-agent`
   versions it supports and fails clearly on an unsupported one, so a runtime upgrade cannot silently
   break the extension API surface the orchestrator depends on.
7. **Validation on both installations.** After the switch, GMKtec and `converge-kenan` both install by
   version, both report the same version and schema, neither loses a session across an upgrade, and
   `machine/pi.md` plus each component README describe the new install/update path instead of `deploy`.

### Why now

Two hosts share one Codex/Anthropic/Cursor account pool and one decentralized governor design, so a fix
to admission, attribution, or quota accounting on one machine is only half-deployed until the other takes
it. The 2026-08-19 operator-grant attribution change is the concrete example: committed and live here the
same hour, but it reaches `converge-kenan` only when someone manually deploys there, and deploying there
today would kill running agents.
