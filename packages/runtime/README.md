# Pi runtime packages

Reusable extensions and prompt-evaluation tools for [Pi](https://pi.dev).

## Packages

- `state-compactor` triggers Pi's native compaction before a provider request once context reaches 250,000 tokens.
- `bash-timeout-guard` caps every bash call at 55 seconds and forbids detached work.
- `publication-custody` ends model-side CI polling after a durable publication handoff.
- `pi-claude-code-use` adapts Pi tools and prompts for Anthropic subscription requests.
- `chatgpt-pro` exposes ChatGPT Pro through short-lived, authenticated Kernel browsers and verifies the persisted model evidence before returning an answer.
- `pi-cursor` adds Cursor subscription OAuth, live model discovery, usage reporting, and native Connect/protobuf streaming. Its imported upstream source is pinned at version 1.4.27.
- `prompt-eval` runs reproducible Pi prompt comparisons in isolated workspaces.

## Install

Install the runtime workspace from a Pi stack checkout:

```sh
pi install /absolute/path/to/pi-stack/packages/runtime
```

The root package enables every extension. Use Pi's package filters when only some extensions are wanted. Each extension also has its own package manifest and can be installed from a checkout path.

## Configuration

The packages contain no host identities, credential values, deployment paths, or service policy. Configuration stays on the machine running Pi. Each component README lists its environment variables and local files.

The ChatGPT Pro bridge requires a local configuration file. Other guards work with defaults and accept environment overrides. A host may connect their reporting hooks to an alert command or inbox without making that mechanism part of this repository.

## Development

```sh
cd /absolute/path/to/pi-stack
npm ci --ignore-scripts
npm run check
```

The supported Pi peer is `@earendil-works/pi-coding-agent` 0.84.x. Tests run without account credentials or browser sessions.

## License

MIT
