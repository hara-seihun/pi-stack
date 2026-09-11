# Codex server-side compaction

This Pi Stack extension stores OpenAI's encrypted V2 checkpoint in a real Pi `CompactionEntry`. Pi still owns tools, request serialization, provider transport, session branching and compaction timing. It makes one native compaction request, not a prose-summary request.

## Lifecycle

The extension handles `session_before_compact` for models whose API is `openai-codex-responses`, including Orchestrator's numbered OAuth aliases. Pi 0.85 runs automatic compaction after a complete tool batch and before the next assistant response. Manual compaction and overflow recovery use the same handler. There is no additional scheduler, tool interruption or synthetic continuation message.

Pi's ordinary settings apply:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

The threshold is `contextWindow - reserveTokens`. This extension does not install a separate 90% threshold.

## Requests and account custody

`modelRegistry.complete()` builds and sends the compaction request. Its ordinary Codex serializer handles messages, images and active tool schemas. The payload hook appends `compaction_trigger`; the request advertises `remote_compaction_v2`.

Only compaction selects Pi's SSE transport, because Pi has no raw WebSocket-event observer. A byte-stream observer captures the encrypted item while Pi's parser handles the same response and computes usage. Pi owns headers, account IDs, request compression, endpoint resolution and errors. Normal chat keeps its configured transport, including WebSockets. Compaction uses the same session/cache identity and short cache retention as the conversation, rather than sending a cold request under a new routing ID.

The [Orchestrator operation broker](../../../orchestrator/src/extension/provider-operation.ts) resolves shared OAuth under its existing lock. It refreshes a refused token once. Interactive rate limits can try another eligible alias, bounded to three accounts. Assigned fleet operations stay on the scheduler's account. The broker reuses an existing parent lease or holds a temporary heartbeat-backed lease, records usage against the actual account, and cancels outstanding work before shutdown closes its store. The operation has a three-minute deadline. Without Orchestrator, Pi's registry resolves the configured provider directly.

Successful request usage also lives on `CompactionEntry.usage` for Pi totals. The usage logger does not count that entry again. Failed requests that returned usage are charged by the broker even when no checkpoint can be committed.

## Saved context and model changes

`details.kind` is `openai-codex-native-compaction`; the Stack schema version is `2`. `details.modelKey` contains API and model ID, never the OAuth account alias. `replacementHistory` contains recent user messages within the upstream 64,000 approximate text-token budget and exactly one final encrypted `compaction` item. Images remain attached to retained user messages; that budget measures text, not image tokens.

The normal `summary` field is a factual checkpoint notice with JSONL metadata tagged `pi-stored-jsonl-history`. Pi's ordinary retained tail remains in its branch. For the checkpoint's model, the context hook substitutes a marker for the saved summary and retained span. The payload hook replaces just that marker with native history, leaving the provider's serialized live tail and other request fields intact.

A different model receives the factual `native-checkpoint-unavailable` notice, the retained tail and the original session's JSONL path. It does not receive the encrypted history. The [shared `read-thread` command](../../../../tools/read-condensed-session/README.md) reads and searches that JSONL. Returning to the checkpoint's model reuses it until a later compaction supersedes it. An in-memory session explicitly reports that it has no JSONL history. No textual summarizer runs during a model switch.

Resume, forks, tree navigation and repeated compaction locate the latest compaction on the active branch. A first native compaction starts from Pi's effective context, including any existing summary and kept messages, rather than replaying an oversized raw transcript. Session JSONL remains the source of full historical text; there is no separate recall cache.

Compaction failures cancel Pi's operation and leave the previous context intact. A malformed checkpoint or a missing/duplicated request marker aborts the request. Other extensions may add live context, but changing the checkpoint's retained boundary is rejected rather than silently deleting their messages. Nested compaction uses the current system prompt, tools and model options; it does not replay unrelated extensions' chat-only payload rewrites.

## Checks

From the stack root:

```sh
node --test packages/runtime/extensions/codex-compaction/*.test.mjs packages/runtime/codex-sse.test.mjs packages/runtime/compaction-cut.test.mjs
npx vitest run packages/orchestrator/tests/provider-operation.test.ts
```

These tests use mocked HTTP and credentials. They exercise Pi's actual Codex serializer and parser, tool batches, checkpoint persistence, repeated compaction, aliases, model switches, malformed streams, aborts, refresh, account attribution and leases.

The lifecycle test runs a real Pi session against a local mock Responses server, checking that both parallel tools finish, native compaction runs, and the next assistant request stays in the same agent run. The companion [`patch-compaction-cut.mjs`](../../patch-compaction-cut.mjs) fixes Pi's refusal to compact when a trailing tool batch alone exceeds the kept-token budget.

The tests also exposed Pi's LF-only SSE frame splitter. [`patch-codex-sse.mjs`](../../patch-codex-sse.mjs) repairs CRLF framing in both the SDK provider and the bundled CLI provider at dependency installation. Its source participates in the deployment dependency hash. The framing tests run both parser copies with whole and byte-split LF/CRLF streams.

For a live smoke check, provide two files containing user-written history and a continuation request. The script makes one native compaction and one ordinary Luna request, checks saved/forked checkpoint recovery, and cleans its temporary session. It loads the actual routing and compaction extensions, records real shared-account usage, and has a 50-second deadline:

```sh
node /srv/pi/runtime/extensions/codex-compaction/smoke.mjs \
  --routing-entry /srv/pi/pi-orchestrator/dist/extension/routing.js \
  --history-file /absolute/path/to/history.txt \
  --continuation-file /absolute/path/to/continuation.txt
```

Add `--switch-account` to move Luna to another eligible shared alias after compaction and before continuation. The receipt names both producer and consumer aliases. The caller supplies all model-facing test text. The script prints account/model, checkpoint count, token usage and the continuation's text. It does not print credentials or encrypted checkpoint contents.

## Provenance

Adapted from [Can Celik's `pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions/tree/9f2cae165dabf66a62f1579c3422bce21133bb9d/packages/pi-codex-compaction), package version `0.1.5`, commit `9f2cae165dabf66a62f1579c3422bce21133bb9d`. The repository was cloned at the user's request. [LICENSE](LICENSE) retains the upstream MIT attribution.

The V2 trigger/feature, encrypted checkpoint validation, retained-user budget and middle truncation derive from upstream. Stack replaces its copied message serializer and HTTP implementation with Pi's provider operation, removes support for pre-0.84.4 Pi, separates account identity from model identity, preserves the live context-hook tail, and adds shared account custody and explicit cross-model history metadata.
