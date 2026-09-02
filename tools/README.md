# Pi tools

These commands depend on Pi sessions, Pi models, or the orchestrator ledger.

| Directory | Command | Purpose |
|---|---|---|
| [`agent-workspace`](agent-workspace/README.md) | `agent-workspace` | Lease, recover, and release agent Git checkouts. |
| [`fleet-errors`](fleet-errors/README.md) | `fleet-errors` | Classify failed fleet tool calls. |
| [`mcp`](mcp/README.md) | `mcp` | Discover and call configured MCP servers. |
| [`mcp-script`](mcp-script/README.md) | `mcp-script` | Run JavaScript over one MCP client. |
| [`read-condensed-session`](read-condensed-session/README.md) | `read-thread`, `read-condensed-session` | Find and render Pi Remote threads locally; use model-assisted condensation only when needed. |

[`../config/tools.json`](../config/tools.json) defines host availability, command names, and fleet installation. CI tests every command. Shared command-line parsing lives in [`shared`](shared). `../deploy/tools` links the reviewed runtime dependency tree into a commit-addressed release, switches `/srv/pi/tools` atomically, and reconciles the interactive and fleet users' command links.

Session files, summary caches, and credentials remain host state. This repository contains no private transcripts.
