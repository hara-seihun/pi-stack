# Architecture

## Repository boundaries

The repository contains several packages because they run in different processes and have different release artifacts. One Git commit still identifies the whole deployed stack.

Pi Remote imports Pi Orchestrator's public API through the `pi-orchestrator` workspace. One catalog owns model identities, labels, default thinking levels, and plan-meter definitions. `OrchestratorClient` owns account, quota, governor, run, and transcript reads, so Pi Remote does not know the ledger schema. Host deployment publishes the compiled orchestrator before starting Pi Remote.

The runtime package owns the exact Pi development dependency. Root npm overrides keep every workspace on the same Pi and TypeBox versions. `package-lock.json` is the only JavaScript lockfile.

## Pi package order

Pi applies extensions in package order. Pi Remote's `context-mirror.ts` records the context after every other extension has transformed it, so it must load last.

[`../config/packages.json`](../config/packages.json) names the package order. Every account on every host loads the same list, plus whatever the host file adds ahead of the observer. Repository packages name their deployed path. External npm and Git packages use Pi's pinned source syntax directly. `scripts/check-manifests.mjs` checks the ordering rule, and Pi Remote checks the effective settings file at startup.

## Environments

A Pi Remote server has a stable lowercase ID and a display name. Public `GET /v1/environment` supplies the person chooser and host identity. Authenticated responses supply the selected person's profiles and client capabilities. Health responses carry the supervisor's environment ID.

The host's `/etc/pi-stack/host.json` supplies its endpoint catalog. Each person's registry supplies her profiles, data location, unlock requirements and allowed endpoints. No particular host or person is built into the environment contract.

Each host runs the same front door and one supervisor per person. A person's registry file says whether her folder is encrypted; the front door starts an open person's supervisor at boot and an encrypted person's when her key arrives.

The router is the sole published API entrance. `POST /v1/unlock` with `{key}` and the `x-pi-remote-user` hint mints a person-bound session. Requests authenticate with `x-pi-remote-session`; headers and query parameters naming a person grant no authority. This supersedes the previous claim that choosing a name was sufficient while a folder was open. Locking revokes that person's sessions.

Authenticated `GET /v1/environments` intersects the host's endpoint catalog with the person's `remoteAccess` list, which defaults to the host's own endpoint. Remote entries carry server-only `upstreams` maps keyed by person. Each value is an absolute HTTP or HTTPS origin for that person's supervisor, never another router. Remote grants require an encrypted-folder identity; a grant without a matching upstream is a startup error. IDs, names and icons are configuration, not access branches.

Clients receive an empty prefix for their own host and generated `/v1/remotes/<id>` prefixes for remotes, not upstream addresses. The gateway checks each request against the authenticated person's grants and strips client authentication before forwarding to her supervisor. Host-owned tunnels may reach another machine, but no tunnel identity or endpoint list is embedded in the app. Keep any tunnel credentials on the server. An app update cannot revoke a credential distributed in an earlier client; revoke such grants at the credential owner. Host UID rules admit only the router, the owning service identities and root to private supervisor, upstream and control listeners. See [deployment boundaries](deployment.md#gateway-access-and-host-boundaries).

## Android state

Android bootstraps from `piRemoteRouterUrl` and shares the router's person/session identity with native downloads and notifications. Browser and Android clients discover allowed endpoints only after authentication. Switching endpoints cancels requests owned by the previous endpoint. Switching person clears the previous session and endpoint state.

Drafts, notification cursors and selected threads are scoped by person and endpoint. Session lists and context come from the selected supervisor. The thread-start menu uses that supervisor's profile list.

## Session ownership

[Orchestrator threads](threads.md) own conversation identity, input delivery, execution state and parent notifications. Pi owns each individual session's native execution, compaction and JSONL transcript. The shared runner keeps many sessions in one process within each existing person and execution boundary. Remote owns presentation, uploads and person routing, not another scheduler.

Profiles and workspaces belong to each person's configured environment. Clients combine environments only at the presentation boundary. Thread directories include only explicitly authorized owners in the selected environment. Fleet control is available to the fleet's configured owning person, not to every person who can observe account usage. There is no cross-machine agent bridge.
