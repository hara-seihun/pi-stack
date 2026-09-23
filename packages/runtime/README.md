# Pi runtime packages

Reusable extensions for [Pi](https://pi.dev). The [stack manifest](../../package.json) pins Pi and the browser packages every host runs.

## Packages

- `bash-timeout-guard` requires a bounded bash call, defaults to 30 minutes with a UI and 55 seconds for autonomous sessions, accepts a host-configured ceiling, and forbids detached work.
- [Claude OAuth runtime](extensions/claude-oauth/README.md) loads the upstream subscription adapter with the client version required by Opus 5.5, from the same immutable dependency tree as Pi.
- [Browser runtime](extensions/browser/README.md) loads the native browser tool with its executable from the same immutable dependency tree.
- [Codex compaction](extensions/codex-compaction/README.md) stores OpenAI's server-side checkpoints in Pi sessions while keeping Pi's tools and account routing. Stored JSONL remains readable through the [shared session reader](../../tools/read-condensed-session/README.md).
- [Web search](extensions/web-search/README.md) registers a native `web_search` tool over a host-selected search backend, so every session has web search in its tool list instead of reaching for a skill or a browser. The shipped Exa backend sends requests through the host's governed `exa-api` transport.
- [Local models](extensions/local-models/README.md) registers the OpenAI-compatible inference engines a host lists in `~/.pi/agent/local-models.json`, starting one that is not running as a transient user unit, and mirrors them into Pi's model catalog.

PiStack's [unified thread service](../../docs/threads.md) hosts Remote and fleet sessions through Pi. Pi retains these native extensions and its native JSONL history. Codex is a model provider, not a separate session engine.

The stack also supplies native [Image 2.5 generation](../orchestrator/docs/image-generation.md) through the Orchestrator routing extension, which owns its OpenAI account selection and leases.

## Install

Install the runtime workspace from a Pi stack checkout:

```sh
pi install /absolute/path/to/pi-stack/packages/runtime
```

The root package enables every extension. Use Pi's package filters when only some extensions are wanted. Each extension also has its own package manifest and can be installed from a checkout path.

## Browser dependency

The stack manifest pins `agent-browser` and `pi-agent-browser-native` together. [`config/packages.json`](../../config/packages.json) loads the browser runtime entrypoint instead of installing the native package into each account's mutable npm tree. Deployment derives the executable version from the locked package metadata, so an immutable package URL cannot be mistaken for a version string.

The current `agent-browser` package comes from Hara's immutable [browser repair build](https://github.com/hara-seihun/agent-browser/releases/tag/browser-repairs-20260922-glibc235). It contains two upstream-derived fixes. First, upstream 0.36.0 and 0.37.1 sent `Browser.setDownloadBehavior` through the active target session. Chrome wrote a UUID-named file, but the browser-level completion event did not reach the command subscriber, so direct downloads timed out and never moved the file to the requested path. The repaired build sends that Browser-domain command without a target session; [upstream pull request 1858](https://github.com/vercel-labs/agent-browser/pull/1858) owns that correction. Second, a remote Chrome target could remain compositor-occluded while DOM and evaluation commands worked, causing `Page.captureScreenshot` to hang. Screenshot capture now enables focus emulation, brings the target to the front and forces a layout read before capture. That repair is derived from [upstream pull request 1189](https://github.com/vercel-labs/agent-browser/pull/1189), commit `23f9721`, and is narrowed to target preparation. The Linux executable is built on Ubuntu 22.04 and requires at most glibc 2.34, which supports both fleet hosts. Replace the package URL with the first upstream release that contains both changes.

On 2026-09-05, a running worker retained a native extension requiring 0.34.0 while a release switched its shared executable to 0.36.0. The entrypoint now resolves both packages and pins the process's executable path when the extension loads. The 0.6.6 native package also includes upstream's stdout-spill ordering repair for large JSON diagnostics.

That version's QA text predicate misses phrases split across React text nodes, including Pi Remote's client revision footer. [`patch-browser-qa.mjs`](patch-browser-qa.mjs) repairs the pinned dependency during [`deploy/runtime`](../../deploy/runtime). It joins visible text across adjacent nodes and inline markup, preserves block boundaries, and excludes hidden text. Its source participates in the immutable dependency key, and an upstream source change that no longer matches fails deployment. [`browser-doctor.mjs`](browser-doctor.mjs) compiles the installed QA predicate on every host release. Its disposable browser checks a heading split across spans, verifies a PNG screenshot and downloads a loopback attachment through a current `@ref`, requiring verified artifact metadata and exact file bytes before the release can activate.

## Codex transport framing

[`patch-codex-sse.mjs`](patch-codex-sse.mjs) repairs Pi 0.87.1's LF-only SSE frame splitter in both the SDK and bundled CLI Codex providers. Compaction tests exposed valid CRLF frames being joined into malformed JSON. Deployment applies the patch to the immutable dependency tree and includes its source in that tree's hash. [`codex-sse.test.mjs`](codex-sse.test.mjs) exercises both copies with LF, CRLF and one-byte chunks. The extension observes response bytes without replacing Pi's parser.

[`patch-codex-service-recovery.mjs`](patch-codex-service-recovery.mjs) installs [bounded service recovery](codex-service-recovery.js) in both Codex provider copies. An exact `no_biscuit_no_service` failure before output gets one retry with the same account, headers and full request, including any encrypted checkpoint. The exact message `The access_programs parameter is not enabled for this organization.` also gets that retry when the outgoing request has no `access_programs` field and the error has no code or has `server_error` or `invalid_request_error`. A client-authored `access_programs` field or an authentication error code leaves the failure visible without this retry. The retry does not resolve credentials again, refresh OAuth or select another account. The provider retains the first failure's response ID and code in a `provider_service_retry` diagnostic on the final assistant message. A second failure stays visible. Cancellation, generated text, tool calls, native compaction output and other provider errors are not retried by this rule. [`codex-service-recovery.test.mjs`](codex-service-recovery.test.mjs) exercises the actual SDK and bundled providers through SSE and WebSockets in under a second. Deployment hashes both repair files into its immutable dependency identity. Reapplying the patch replaces the embedded helper with the current source in both provider copies.

On September 15, 2026, thread `fbd03453-7fd1-486d-ab6e-86051acd9124` received this failure on account 11 after successful checkpoint continuation. Later requests returned `Not Found`, including after OAuth refresh. The same thread, model and checkpoint then succeeded on account 8. Account 11 was disabled through the account owner. The retry handles a transient first failure without hiding a persistently unhealthy account. It does not alter the separately owned corroborated 404 authentication recovery. [OpenAI's earlier incident](https://github.com/openai/codex/issues/34177) also associates this marker with service admission failure. Neither case calls for replacing encrypted history or replaying a previous turn's routing token. [Codex's turn-state contract](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs) limits that token to one user turn.

On September 18, 2026, native sessions `d916c1a9-0dad-4198-83d5-1142b8bf12a8` and `73d1735e-aa4c-4794-9491-6b5c060856d1` received the `access_programs` rejection on Astra accounts 8 and 11 at 02:42:30 and 02:59:19 UTC. Neither failure contained output, usage or a response ID. The installed provider builders, request hooks and configuration contain no `access_programs` option. Both sessions subsequently succeeded on the same account and model at 02:42:55 and 02:59:40 without a configuration change. There is no local parameter to remove. The recovery handles that provider rejection without changing `service_tier`, refreshing credentials or rerouting accounts. Tests cover both transports, preserved priority, cancellation, partial output, repeated rejection and real authentication failures. The incident sessions remain unchanged; repair tests use synthetic requests only.

[`patch-compaction-errors.mjs`](patch-compaction-errors.mjs) lets native compaction return a concrete failure through both Pi runtime copies. Failed between-turn compaction reaches the agent failure handler without aborting it. The context hook can return `{ error: string }` to reject a later request at its durable failure fence. Pi rejects that result outside extension exception logging, preserves the cause on the assistant and excludes both failures from ordinary chat retries. Actual cancellation retains its abort signal. The extension's [operation scope and durable attempt records](extensions/codex-compaction/operation.mjs) own progress deadlines and explicit recovery. The [incident and recovery contract](extensions/codex-compaction/README.md#september-12-timeout-incident) records the large-context replay.

Pi 0.87.1 owns the companion cut-selection repair. When trailing tool results alone exceed `keepRecentTokens`, Pi keeps their preceding assistant call instead of retaining the entire transcript and declining compaction. [`compaction-cut.test.mjs`](compaction-cut.test.mjs) guards that upstream contract; the extension's lifecycle test runs a complete parallel tool batch, native compaction and continuation inside one Pi run.

## Session crash durability

Pi 0.87.1 closes JSONL files after writes without syncing them. A hard host reset can therefore persist a new gocryptfs file length without the complete authenticated final block, making every later read that reaches that block fail with `EIO`. [`patch-session-durability.mjs`](patch-session-durability.mjs) repairs both the SDK and bundled CLI copies. Appends are synced before returning, initial and fork writes are completed and synced as one file, and rewrites use a synced temporary file followed by an atomic rename and parent-directory sync. [`session-durability.test.mjs`](session-durability.test.mjs) checks both deployed source forms and their syntax.

## Root worker filesystem custody

Root-repair workers keep UID 0, the daemon owner's HOME and normal Pi configuration. They inherit `PI_ORCHESTRATOR_OWNER_UID` and `PI_ORCHESTRATOR_OWNER_GID` from their recorded worker environment. [`shared-custody.ts`](../orchestrator/src/shared-custody.ts) transfers file and directory ownership at the writers, without changing process credentials or adding a chown timer. Atomic replacements transfer ownership before rename, so mode `0600` still permits daemon-owner access. The same helper owns orchestrator state, journal, OAuth credential and lock writes.

[`patch-shared-custody.mjs`](patch-shared-custody.mjs) embeds that helper into both Pi runtime copies. It patches SessionManager, settings, native auth and the model cache that uses native auth storage. Settings replacements are atomic in both the SDK and bundled CLI. Native auth and settings supply proper-lockfile with an ownership-aware filesystem implementation, transferring lock directories before acquisition returns. Pi tools retain root privileges and the shared environment. SQLite's Unix VFS transfers its WAL and shared-memory files to the database owner; the root fixture checks this through a root writer and an ordinary-user reopen.

Deploy with the existing [`deploy/runtime`](../../deploy/runtime) path before `deploy/orchestrator`. Its immutable dependency hash includes the helper and patch, and it applies session durability before shared custody. Rebuilding only orchestrator is insufficient. For a focused root proof against a development dependency tree:

```sh
node packages/runtime/patch-session-durability.mjs node_modules
node packages/runtime/patch-shared-custody.mjs node_modules
node --test packages/runtime/shared-custody.test.mjs packages/runtime/session-durability.test.mjs
cd packages/orchestrator
PI_TEST_ROOT_CUSTODY=1 npx vitest run tests/worker-custody.test.ts --maxWorkers=1
```

The root fixture uses passwordless sudo and a temporary tree, not real credentials. Without `PI_TEST_ROOT_CUSTODY=1`, ordinary test runs still check execution and custody validation but skip privileged subprocesses.

## Configuration

The packages contain no host identities, credential values, deployment paths, or service policy. Configuration stays on the machine running Pi. Each component README lists its environment variables and local files.

Thinking defaults initialize sessions without a saved or explicit thinking level. Once set, the session's level survives model changes, account routing, and resume. Global and per-model startup defaults do not overwrite it. Explicit thinking selections and scoped-model levels still apply, and Pi clamps unsupported levels to the selected model's capabilities. The [Pi source package](../../vendor/pi/README.md) owns this behavior for both the SDK and bundled CLI/RPC.

## Development

```sh
cd /absolute/path/to/pi-stack
npm ci --ignore-scripts
npm run check
```

The supported Pi peer is `@earendil-works/pi-coding-agent` 0.87.x. Tests run without account credentials or browser sessions.

Codex service-recovery tests patch disposable package copies under the system temporary directory and link their dependencies to the installed tree. They leave installed source and directory entries unchanged. Writing temporary providers into installed bundle chunks caused publication PUB-cd9008bcaeaf81804e960873 to fail when a concurrent custody test listed a fixture that disappeared before it could read it. Fixture cleanup is registered before copying or importing, so setup failures also remove the temporary tree.

The Orchestrator pretest and Remote test setup run `patch-shared-rpc.mjs` to generate the shared RPC module from the installed Pi package. Generation uses atomic replacement and leaves unchanged output alone, so concurrent test processes cannot read a partially written module.

To check thinking precedence against the deployed SDK and bundled RPC without making provider requests:

```sh
PI_TEST_RUNTIME_ENTRY=file:///srv/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  node --test packages/runtime/session-thinking.test.mjs
```

## License

MIT
