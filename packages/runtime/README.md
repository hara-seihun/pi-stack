# Pi runtime packages

Reusable extensions for [Pi](https://pi.dev). The [stack manifest](../../package.json) pins Pi and the browser packages every host runs.

## Packages

- `bash-timeout-guard` requires a bounded bash call, defaults to 30 minutes with a UI and 55 seconds for autonomous sessions, accepts a host-configured ceiling, and forbids detached work.
- [Browser runtime](extensions/browser/README.md) loads the native browser tool with its executable from the same immutable dependency tree.

## Install

Install the runtime workspace from a Pi stack checkout:

```sh
pi install /absolute/path/to/pi-stack/packages/runtime
```

The root package enables every extension. Use Pi's package filters when only some extensions are wanted. Each extension also has its own package manifest and can be installed from a checkout path.

## Browser dependency

The stack manifest pins `agent-browser` and `pi-agent-browser-native` together. [`config/packages.json`](../../config/packages.json) loads the browser runtime entrypoint instead of installing the native package into each account's mutable npm tree. Deployment derives the expected executable version from the manifest.

On 2026-09-05, a running worker retained a native extension requiring 0.34.0 while a release switched its shared executable to 0.36.0. The entrypoint now resolves both packages and pins the process's executable path when the extension loads. The 0.6.6 native package also includes upstream's stdout-spill ordering repair for large JSON diagnostics.

## Configuration

The packages contain no host identities, credential values, deployment paths, or service policy. Configuration stays on the machine running Pi. Each component README lists its environment variables and local files.

Thinking defaults initialize sessions without a saved or explicit thinking level. Once set, the session's level survives model changes, account routing, and resume. Global and per-model startup defaults do not overwrite it. Explicit thinking selections and scoped-model levels still apply, and Pi clamps unsupported levels to the selected model's capabilities. The [Pi source package](../../vendor/pi/README.md) owns this behavior for both the SDK and bundled CLI/RPC.

## Development

```sh
cd /absolute/path/to/pi-stack
npm ci --ignore-scripts
npm run check
```

The supported Pi peer is `@earendil-works/pi-coding-agent` 0.85.x. Tests run without account credentials or browser sessions.

To check thinking precedence against the deployed SDK and bundled RPC without making provider requests:

```sh
PI_TEST_RUNTIME_ENTRY=file:///srv/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  node --test packages/runtime/session-thinking.test.mjs
```

## License

MIT
