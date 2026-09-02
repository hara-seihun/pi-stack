# Architecture

## Repository boundaries

The repository contains several packages because they run in different processes and have different release artifacts. One Git commit still identifies the whole deployed stack.

Pi Remote imports Pi Orchestrator's public API through the `pi-orchestrator` workspace. One catalog owns model identities, labels, default thinking levels, and plan-meter definitions. `OrchestratorClient` owns account, quota, governor, run, and transcript reads, so Pi Remote does not know the ledger schema. Host deployment publishes the compiled orchestrator before starting Pi Remote.

The runtime package owns the exact Pi development dependency. Root npm overrides keep every workspace on the same Pi and TypeBox versions. `package-lock.json` is the only JavaScript lockfile.

## Pi package order

Pi applies extensions in package order. Pi Remote's `context-mirror.ts` records the context after every other extension has transformed it, so it must load last.

[`../config/packages.json`](../config/packages.json) names the package order. Every account on every host loads the same list, plus whatever the host file adds ahead of the observer. `scripts/check-manifests.mjs` checks the ordering rule, and Pi Remote checks the effective settings file at startup.

## Environments

A Pi Remote server has a stable lowercase ID and a display name. `GET /v1/environment` returns that identity, its thread profiles, and client capabilities. Health responses carry the same ID.

The two current environments are:

| ID | Name | Host | Profiles | Unlock |
|---|---|---|---|---|
| `local` | Local | GMKtec | Personal, Home | each person's encrypted folder key |
| `converge` | Converge | `converge-kenan` | one work profile | none |

Both hosts run the same front door and one supervisor per person. A person's registry file says whether her folder is encrypted; the front door starts an open person's supervisor at boot and an encrypted person's when her key arrives.

Kenan knows how to reach both endpoints because it cannot discover a server before choosing one. It verifies the reported ID before sending ordinary requests. A connection aimed at the wrong server fails instead of mixing state.

An endpoint can use direct network access or an SSH local-forward. Local uses its existing Tailscale Serve URL. Converge binds Pi Remote to loopback and accepts only the app's restricted SSH identity, which may forward to that listener but cannot open a shell or reach another port. Ignored local properties supply the Converge SSH host, pinned host key, user, and owner-only private-key path. The build embeds that key in the app artifact.

## Kenan state

The native `RemoteEnvironment` owns the selected endpoint in Android preferences. It prepares the direct connection or pinned SSH tunnel and verifies `/v1/health` before the shared client sends ordinary requests. Switching environments reloads the page, which cancels requests owned by the previous endpoint.

The shared client keeps the selected drawer tab, composer drafts, and Local unlock key in WebView storage. Session lists and context come from the selected server after every reload. The thread-start menu uses that server's profile list.

## Session ownership

Each Pi Remote deployment owns its Pi RPC processes, uploads, and local orchestrator view. Local owns Personal and Home; Converge owns work. Kenan combines the two environments at the client boundary. There is no server-to-server agent bridge or remote ledger reader.
