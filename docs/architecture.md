# Architecture

## Repository boundaries

The repository contains several packages because they run in different processes and have different release artifacts. One Git commit still identifies the whole deployed stack.

Pi Remote imports Pi Orchestrator's voice and quota controls through the `pi-orchestrator` workspace. It does not discover a built module through an environment variable. Host deployment publishes the compiled orchestrator before starting Pi Remote.

The runtime package owns the exact Pi development dependency. Root npm overrides keep every workspace on the same Pi and TypeBox versions. `package-lock.json` is the only JavaScript lockfile.

## Pi package order

Pi applies extensions in package order. Pi Remote's `context-mirror.ts` records the context after every other extension has transformed it, so any role that loads Pi Remote must load it last.

[`../config/package-sets.json`](../config/package-sets.json) names the package order for each role. `scripts/check-package-sets.mjs` checks the ordering rule. Pi Remote also checks the effective settings file at startup.

## Environments

A Pi Remote server has a stable lowercase ID and a display name. `GET /v1/environment` returns that identity, its thread profiles, and client capabilities. Health responses carry the same ID.

The two current environments are:

| ID | Name | Host | Profiles | Unlock |
|---|---|---|---|---|
| `local` | Local | GMKtec | Personal, Home | encrypted folder key |
| `converge` | Converge | `converge-kenan` | one work profile | none |

Android knows the two endpoint URLs because it cannot discover a server before choosing one. It verifies the reported ID before sending ordinary requests. A URL aimed at the wrong server fails instead of mixing state.

Converge uses Tailscale Serve and binds Pi Remote to loopback. Tailscale authenticates the caller and keeps the service off the public Internet.

## Android state

`PiRemoteEnvironment` owns the selected endpoint. `PiRemoteApi` captures an endpoint for each request and rejects foreground responses after an environment switch.

Android keys these values by environment ID:

- folder unlock keys;
- selected thread;
- composer drafts;
- completion watches;
- open-thread visibility and notification routes;
- drawer tab.

Completion monitoring can poll both servers while the activity shows one. Notifications include the environment ID, switch the drawer to that environment, and then open the named thread. Identical session IDs on the two servers remain distinct.

The thread-start menu uses the server's profile list. With two Local profiles it shows profile selection before model selection. With Converge's one profile it opens model selection immediately.

## Session ownership

Each Pi Remote deployment owns local Pi RPC processes, local uploads, and the local orchestrator ledger view. The GMKtec deployment currently has an SSH work bridge only to carry existing work sessions through migration. Cutover removes that bridge after those sessions move to Converge.

A work-thread move includes its supervisor rows, events, context snapshots, work items, uploads, service-tier files, and Pi JSONL. The destination keeps the existing session ID. Import completes before Converge creates any new work thread, which avoids ID and notification ambiguity.
