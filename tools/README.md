# Pi tools

These commands depend on Pi sessions, Pi models, or the orchestrator ledger.

| Directory | Command | Purpose |
|---|---|---|
| [`agent-workspace`](agent-workspace/README.md) | `agent-workspace` | Lease, recover, and release agent Git checkouts. |
| [`codex-reset`](codex-reset/README.md) | `codex-reset` | Spend banked OpenAI rate-limit resets across the Codex account pool. |
| [`fleet-errors`](fleet-errors/README.md) | `fleet-errors` | Classify failed fleet tool calls. |
| [`user-usage`](user-usage/README.md) | `pi-user-usage` | Count a person's recorded tokens, logged API value, and estimated subscription dollars. |
| [`mcp`](mcp/README.md) | `mcp` | Discover and call configured MCP servers. |
| [`mcp-script`](mcp-script/README.md) | `mcp-script` | Run JavaScript over one MCP client. |
| [`read-condensed-session`](read-condensed-session/README.md) | `read-thread`, `read-condensed-session` | Read and search stored JSONL for self, fleet sessions and other Remote threads; optional model-assisted condensation. |

[`../config/tools.json`](../config/tools.json) defines the command names. CI tests every command. Shared command-line parsing lives in [`shared`](shared). `../deploy/tools` links the reviewed runtime dependency tree into a commit-addressed release, switches `/srv/pi/tools` atomically, and links every command into each Pi account's `~/.local/bin`.

Pi Remote also supplies [`pi-phone`](../apps/remote/docs/phone-control.md), linked by `deploy/tools` from the matching Remote release. It controls only Android phones connected to the caller's Unix-person supervisor. Start with `pi-phone --help`, `pi-phone list`, and `pi-phone catalogue`; `pi-phone --device ID screenshot --out /exact/path.png` saves native PNG bytes. `pi-phone command NAME '{"arg":"value"}'` exposes every catalogue command. Local callers use their own registry endpoint or the supervisor endpoint inherited by their thread. It never queues offline commands or automatically retries uncertain mutations.

Session files, summary caches, and credentials remain host state. This repository contains no private transcripts.
