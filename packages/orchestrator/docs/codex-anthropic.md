# Anthropic transport for native Codex

`src/cores/codex-anthropic.ts` owns a session-scoped HTTP adapter from Codex's Responses wire protocol to Anthropic Messages. Codex 0.154.0 supports custom Responses providers, not a native Messages provider. The adapter does not run Pi, assemble a Pi prompt, execute tools or start children. It sends provider-reported usage to the account broker.

## Integration

```ts
const adapter = await startCodexAnthropicAdapter({
  sessionId,
  cwd,
  credentials: ({ refresh, signal }) => account.credentials({ refresh, signal }),
});
```

The callback returns `{ accessToken: string }`. The account broker owns affinity, refresh persistence, and lease lifetime. It must observe `signal` when it performs cancellable work. The adapter requests a credential for each model request, then asks for `refresh: true` once if Anthropic explicitly returns HTTP 401. It never retries a connection failure, streamed provider error, 429, 5xx, or truncated response.

The return value is `{ baseUrl, close(): Promise<void> }`. `baseUrl` is an ephemeral `http://127.0.0.1:PORT` origin. Configure the native custom provider with:

```toml
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
```

Set its `base_url` to `baseUrl`. Disable provider-hosted web search. Native function tools, custom tools, shell execution, MCP, and children still belong to Codex. `cwd` is accepted for the core integration but the transport neither reads nor changes it. `fetch` can be injected for deterministic upstream tests.

Close the native process first, then the adapter and account lease. Adapter close is idempotent. It stops accepting HTTP requests, aborts pending credential/network/stream work, closes connections, and terminates its OAuth encoder worker. Client disconnect also aborts the corresponding upstream call. There are no credential files or adapter transcript files. OAuth tokens appear only in the outgoing Anthropic authorization header and request-local memory, never in native Codex auth state.

## Subscription request encoding

The exact dependency `@pi-plugins/claude-oauth@0.3.5` owns subscription headers, identity metadata, billing-header fingerprints, and the serialized-body checksum. The adapter runs that package's extension in a worker with a request hook host and a fetch encoder. The worker performs no network requests and receives no credentials. Its global fetch replacement cannot affect the orchestrator's other providers.

The package adds the required subscription identity and billing blocks. Codex's instruction blocks bypass the package's Pi prompt sanitization, then enter the final body before the package computes its fingerprint. The adapter overrides only the generated metadata session ID with the owning Codex session ID. Fingerprint algorithms and Claude client version constants are not copied here.

## Request and history translation

- `instructions` remains the top-level instruction text. Leading system/developer messages become additional Anthropic instruction blocks. Later instruction updates use the supported mid-conversation `system` role at their original position. Anthropic has one instruction role, so Responses system and developer roles both map to it. User and assistant roles remain separate. Consecutive same-role blocks merge in order, including assistant thinking/tool calls and user tool results.
- Text and image content retains its order. Images support HTTP URLs and base64 PNG, JPEG, GIF, or WebP data URLs, including images in tool results. Responses image-detail hints have no Anthropic equivalent; the original image bytes or URL are sent unchanged.
- Function tools keep their JSON Schema. Namespace and otherwise invalid Anthropic tool names use stable hashed wire names with a per-request reverse map. Names and namespaces are restored on Responses tool calls. Tool-call IDs remain correlated with results.
- Custom tools use an object schema with one required `input` string. The adapter unwraps that string into native `custom_tool_call` output. Lark/regex grammar definitions travel verbatim in the tool description. Anthropic does not implement Responses grammar-constrained sampling, so Codex's tool validator remains responsible for rejecting invalid generated input. The adapter rejects malformed custom-tool JSON before emitting a completed tool call.
- Thinking and redacted-thinking blocks retain their original Anthropic signatures/data. Responses `reasoning.encrypted_content` contains a versioned `anthropic-thinking-v1:` envelope. It is an opaque protocol field, not adapter-side encryption. Codex persists it in its own transcript and returns it with subsequent full-history requests. The adapter rejects foreign OpenAI encrypted reasoning and unsigned reasoning rather than dropping it.
- Model IDs, output limits, adaptive-thinking support, strict-tool support, and effort mappings come from `codex-models.ts`'s `anthropicModels()`. Fable supports minimal through max; minimal maps to Anthropic low, while xhigh and max retain their catalog mappings. Unsupported thinking-off requests fail. Older budget-thinking models use explicit token budgets bounded by the requested output cap.

Codex's string-valued `client_metadata` is accepted as tracing metadata. It is not prompt content and is not forwarded to Anthropic's separate identity metadata field.

The adapter emits Responses item/content/delta/done events for text, reasoning summaries, function arguments, and custom-tool input, followed by one terminal response event. Custom-tool input must first finish as valid Anthropic JSON before it can be emitted as a raw string. A provider error or premature stream end emits an error rather than a synthetic successful completion.

## Usage

Anthropic `message_start` and `message_delta` usage updates feed the account broker, keyed by the provider's response ID. The broker records only new counter deltas. Native Codex usage notifications do not also charge Anthropic accounts. This retains observed spend after a stream failure or output-limit exhaustion, and keeps cache-write attribution intact. The Responses terminal event carries the same usage for Codex's own counters:

- `input_tokens` is uncached input plus cache reads plus cache creation.
- `input_tokens_details.cached_tokens` is Anthropic cache-read input.
- `output_tokens` includes thinking. `output_tokens_details.reasoning_tokens` comes from Anthropic `output_tokens_details.thinking_tokens` when supplied; absent detail becomes zero, without adding those tokens again.
- `total_tokens` is total input plus output.

The Responses object also includes `input_tokens_details.cache_creation_tokens`. Codex 0.154.0 discards that breakdown and omits usage from incomplete responses. PiStack's broker retains the provider's exact cache-write counts and observed incomplete-response usage independently. An incomplete response stays a native failure, never a synthetic success. A streamed error emits `response.failed` with Anthropic's message, rather than the generic `error` event that this Codex version ignores.

## Unsupported requests

The transport returns explicit errors for foreign encrypted reasoning, file/audio/video content, provider-hosted tools, deferred tool loading, previous-response references, stored/background Responses, server-side truncation, unsupported service tiers, unsupported cache-retention requests, Responses verbosity controls, unknown model IDs, and unrecognized request/content/tool shapes. It accepts full-history streaming `POST /responses` only. It does not replace unsupported content with textual summaries or quietly start another model call.

Native provider configuration must keep automatic request and stream retries disabled. The adapter cannot prevent a separately configured native client from retrying its HTTP endpoint.

## Focused checks

```sh
npx vitest run packages/orchestrator/tests/codex-anthropic.test.ts packages/orchestrator/tests/codex-anthropic-native.test.ts --maxWorkers=1
```

The fake-upstream tests use the real installed OAuth encoder. They cover instruction preservation, fragmented SSE/UTF-8, signed thinking and function/custom-tool round trips, images and role updates, usage, refresh boundaries, explicit unsupported requests, stream failure, disconnect, and shutdown while credentials or upstream responses are pending.
