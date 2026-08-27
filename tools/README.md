# Pi tools

These commands depend on Pi sessions, Pi models, or the orchestrator ledger.

| Directory | Command | Purpose |
|---|---|---|
| [`fleet-errors`](fleet-errors/README.md) | `fleet-errors` | Classify failed fleet tool calls. |
| [`hara-messages`](hara-messages/README.md) | `hara-messages` | Extract Hara's messages from local Pi sessions. |
| [`mcp`](mcp/README.md) | `mcp` | Discover and call configured MCP servers. |
| [`mcp-script`](mcp-script/README.md) | `mcp-script` | Run JavaScript over one MCP client. |
| [`read-condensed-session`](read-condensed-session/README.md) | `read-condensed-session` | Render a complete Pi session as a condensed transcript. |

[`../config/tools.json`](../config/tools.json) defines host availability, command names, and fleet installation. `../deploy/tools` tests the selected role, publishes an immutable copy under `/srv/pi/tools`, and links commands into the interactive and fleet users' bin directories.

Session files, summary caches, prompt-experiment records, credentials, and generated corpora remain host state. This repository contains no extracted messages or private transcripts.
