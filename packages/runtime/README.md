# Pi runtime packages

Reusable extensions and prompt-evaluation tools for [Pi](https://pi.dev).

## Packages

- `context-guard` bounds long-running conversation context while preserving a protected opening and recent verbatim tail.
- `bash-timeout-guard` requires bounded bash calls and can forbid detached work.
- `mcp-size-guard` reports MCP responses that cross a configurable size threshold.
- `pi-claude-code-use` adapts Pi tools and prompts for Anthropic subscription requests.
- `chatgpt-pro` exposes ChatGPT Pro through short-lived, authenticated Kernel browsers and verifies the persisted model evidence before returning an answer.
- `prompt-eval` runs reproducible Pi prompt comparisons in isolated workspaces.

## Install

Install the repository as a Pi package:

```sh
pi install git:github.com/hara-seihun/pi-runtime@v1.0.0
```

The root package enables every extension. Use Pi's package filters when only some extensions are wanted. Each extension also has its own package manifest and can be installed from a checkout path.

## Configuration

The packages contain no host identities, credential values, deployment paths, or service policy. Configuration stays on the machine running Pi. Each component README lists its environment variables and local files.

The ChatGPT Pro bridge requires a local configuration file. Other guards work with defaults and accept environment overrides. A host may connect their reporting hooks to an alert command or inbox without making that mechanism part of this repository.

## Development

```sh
npm ci --ignore-scripts
npm test
```

The supported Pi peer is `@earendil-works/pi-coding-agent` 0.84.x. Tests run without account credentials or browser sessions.

## License

MIT
