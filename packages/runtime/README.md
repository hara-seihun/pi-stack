# Pi runtime packages

Reusable extensions and prompt-evaluation tools for [Pi](https://pi.dev).

## Packages

- `state-compactor` triggers Pi's native compaction before a provider request once context reaches 250,000 tokens.
- `bash-timeout-guard` requires a bounded bash call, defaults to 30 minutes with a UI and 55 seconds for autonomous sessions, accepts a host-configured ceiling, and forbids detached work.
- `publication-custody` ends model-side CI polling after a durable publication handoff.
- `pi-claude-code-use` adapts Pi tools and prompts for Anthropic subscription requests.
- `prompt-eval` runs reproducible Pi prompt comparisons in isolated workspaces.

## Install

Install the runtime workspace from a Pi stack checkout:

```sh
pi install /absolute/path/to/pi-stack/packages/runtime
```

The root package enables every extension. Use Pi's package filters when only some extensions are wanted. Each extension also has its own package manifest and can be installed from a checkout path.

## Configuration

The packages contain no host identities, credential values, deployment paths, or service policy. Configuration stays on the machine running Pi. Each component README lists its environment variables and local files.

The guards work with defaults and accept environment overrides. A host may connect reporting hooks to an alert command or inbox without making that mechanism part of this repository.

## Development

```sh
cd /absolute/path/to/pi-stack
npm ci --ignore-scripts
npm run check
```

The supported Pi peer is `@earendil-works/pi-coding-agent` 0.84.x. Tests run without account credentials or browser sessions.

## License

MIT
