# Pi runtime packages

Reusable extensions for [Pi](https://pi.dev), plus the pinned Pi and `agent-browser` versions every host runs.

## Packages

- `bash-timeout-guard` requires a bounded bash call, defaults to 30 minutes with a UI and 55 seconds for autonomous sessions, accepts a host-configured ceiling, and forbids detached work.
- `pi-claude-code-use` adapts Pi tools and prompts for Anthropic subscription requests. It is loaded on every host and does nothing until a session uses Anthropic OAuth.

## Install

Install the runtime workspace from a Pi stack checkout:

```sh
pi install /absolute/path/to/pi-stack/packages/runtime
```

The root package enables every extension. Use Pi's package filters when only some extensions are wanted. Each extension also has its own package manifest and can be installed from a checkout path.

## Configuration

The packages contain no host identities, credential values, deployment paths, or service policy. Configuration stays on the machine running Pi. Each component README lists its environment variables and local files.

## Development

```sh
cd /absolute/path/to/pi-stack
npm ci --ignore-scripts
npm run check
```

The supported Pi peer is `@earendil-works/pi-coding-agent` 0.84.x. Tests run without account credentials or browser sessions.

## License

MIT
