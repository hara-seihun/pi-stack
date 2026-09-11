# Pi runtime packages

Reusable extensions for [Pi](https://pi.dev). The [stack manifest](../../package.json) pins Pi and the browser packages every host runs.

## Packages

- `bash-timeout-guard` requires a bounded bash call, defaults to 30 minutes with a UI and 55 seconds for autonomous sessions, accepts a host-configured ceiling, and forbids detached work.
- [Browser runtime](extensions/browser/README.md) loads the native browser tool with its executable from the same immutable dependency tree.
- [Codex compaction](extensions/codex-compaction/README.md) stores OpenAI's server-side checkpoints in Pi sessions while keeping Pi's tools and account routing. Stored JSONL remains readable through the [shared session reader](../../tools/read-condensed-session/README.md).

The stack also supplies native [Image 2.5 generation](../orchestrator/docs/image-generation.md) through the Orchestrator routing extension, which owns its OpenAI account selection and leases.

## Install

Install the runtime workspace from a Pi stack checkout:

```sh
pi install /absolute/path/to/pi-stack/packages/runtime
```

The root package enables every extension. Use Pi's package filters when only some extensions are wanted. Each extension also has its own package manifest and can be installed from a checkout path.

## Browser dependency

The stack manifest pins `agent-browser` and `pi-agent-browser-native` together. [`config/packages.json`](../../config/packages.json) loads the browser runtime entrypoint instead of installing the native package into each account's mutable npm tree. Deployment derives the expected executable version from the manifest.

On 2026-09-05, a running worker retained a native extension requiring 0.34.0 while a release switched its shared executable to 0.36.0. The entrypoint now resolves both packages and pins the process's executable path when the extension loads. The 0.6.6 native package also includes upstream's stdout-spill ordering repair for large JSON diagnostics.

That version's QA text predicate misses phrases split across React text nodes, including Pi Remote's client revision footer. [`patch-browser-qa.mjs`](patch-browser-qa.mjs) repairs the pinned dependency during [`deploy/runtime`](../../deploy/runtime). It joins visible text across adjacent nodes and inline markup, preserves block boundaries, and excludes hidden text. Its source participates in the immutable dependency key, and an upstream source change that no longer matches fails deployment. [`browser-doctor.mjs`](browser-doctor.mjs) compiles the installed QA predicate and checks a heading split across spans in its disposable browser on every host release.

## Codex transport framing

[`patch-codex-sse.mjs`](patch-codex-sse.mjs) repairs Pi 0.85's LF-only SSE frame splitter in both the SDK and bundled CLI Codex providers. Compaction tests exposed valid CRLF frames being joined into malformed JSON. Deployment applies the patch to the immutable dependency tree and includes its source in that tree's hash. [`codex-sse.test.mjs`](codex-sse.test.mjs) exercises both copies with LF, CRLF and one-byte chunks. The extension observes response bytes without replacing Pi's parser.

[`patch-compaction-cut.mjs`](patch-compaction-cut.mjs) fixes the companion cut-selection defect in Pi's SDK and bundled copies. When the trailing tool results alone exceeded `keepRecentTokens`, Pi found no later valid cut and retained the entire transcript, declining compaction. The patch chooses the preceding assistant call when no later cut exists, keeping that batch together. [`compaction-cut.test.mjs`](compaction-cut.test.mjs) covers that boundary; the extension's lifecycle test runs a complete parallel tool batch, native compaction and continuation inside one Pi run.

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
