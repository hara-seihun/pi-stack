# Native image generation

Pi Stack's routing extension provides `image_generation` to models in interactive Pi, Pi Remote and normal fleet sessions. It is independent of the chat model, so an Anthropic session can generate images through a connected OpenAI account.

## Accounts and availability

The tool registers only when an eligible OpenAI account is present. Availability is reconciled at session startup and before each user turn, and execution checks the account again. Pi's tool allowlists and exclusions still apply. Isolated application sessions do not gain tools they did not request.

Account selection prefers the shared Codex pool, then personal `openai-codex` authentication, then personal `openai` API authentication. The pool uses the same selection function as interactive chat routing. Disabled, cooling-down and voice-reserved accounts are excluded. Generation holds a heartbeat-backed interactive lease, refreshes credentials through the shared OAuth lock, and releases the lease on success, failure or cancellation. HTTP 429 cools the selected account.

Personal authentication comes from Pi's model registry, including stored credentials and `OPENAI_API_KEY`. A configured credential enables the tool; the provider still decides whether that account has image access. API accounts may require organization verification and have separate billing from ChatGPT subscriptions. Credentials never enter tool arguments or results.

## Models and requests

- Default: `gpt-image-2.5-flare`, for general image generation.
- Optional: `gpt-image-2.5-sunburst`, for precise editing.

The [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation), checked September 8, 2026, documents both IDs and the Responses API tool's `model` field. Pi explicitly sets that field. The top-level `gpt-6-luna` model routes the request; it is not the image model. There is no fallback to Image 2.

Codex subscriptions use `https://chatgpt.com/backend-api/codex/responses`. API accounts use `https://api.openai.com/v1/responses`. Both send a streamed Responses request with a forced image-generation tool call. Neither route includes the surrounding Pi conversation. Only the supplied prompt and optional input images leave the machine.

The tool accepts:

- `prompt`: image description or editing instructions.
- `outputPath`: a new `.png` file for the final completed image, relative to the session's working directory or absolute. If the router makes multiple image calls, earlier images go to `NAME.image-1.png`, `NAME.image-2.png`, and so on beside it.
- `model`: either Image 2.5 ID above.
- `quality`: `auto`, `low`, `medium`, `high`, `xhigh` or `max`.
- `size`: `auto`, `1024x1024`, `1536x1024` or `1024x1536`.
- `inputPaths`: up to 16 local PNG, JPEG or WebP files to edit, totaling at most 32 MiB.

Quality and size default to `auto`. With input files the request selects editing; otherwise it selects generation. Pi saves every completed image, deduplicated by provider call ID. It returns the final image preview, primary absolute output path, all image paths and call IDs, requested image model, response ID and provider-reported usage. Raw provider usage remains in tool-result details rather than being assigned an invented image price.

## Files and failures

The caller owns the PNG and chooses its location and retention. Pi does not keep a separate image cache or credential store. The existing session transcript owns the preview and tool receipt. Pi Remote's existing image renderer displays the preview, and its normal file-delivery mechanism can deliver the PNG. Remote also supports [background inline image declarations](../../../apps/remote/docs/inline-images.md) for replies that should finish before generation does.

Writes share Pi's per-file mutation queue. An existing primary output is refused before any generation request. Pi reserves a staging directory first, saves all completed PNGs and a receipt there, then publishes them with exclusive hard links. It never overwrites a concurrent writer, including at numbered image paths. If publication fails, the error identifies the retained directory and response ID. Its `receipt.json` maps staged PNGs to their intended paths so the caller can finish publication without another paid request. Provider failures remove empty staging storage.

The router can make sequential image calls even with `parallel_tool_calls: false`. Multiple completed calls are valid output, not a reason to repeat generation. Requests use `store: false`; a response ID alone cannot recover bytes discarded by an earlier tool version.

A request has a five-minute deadline and follows Pi cancellation. Provider refusal, a truncated stream, invalid image data or an explicitly reported wrong model is an error. Generation is never automatically retried or moved to another account after failure, because an interrupted request may already have consumed allowance.

## Checks

From the stack checkout:

```sh
npm test --workspace=pi-orchestrator -- --run tests/image-generation.test.ts tests/routing-runtime.test.ts
PI_OFFLINE=1 node packages/orchestrator/scripts/image-generation-probe.mjs \
  --routing /srv/pi/pi-orchestrator/src/extension/routing.ts
```

The probe creates an in-memory Pi session, loads the actual routing extension and checks native tool registration. It makes no generation request by default. `--expect disabled` checks an installation without OpenAI credentials. Adding `--output /absolute/path/probe.png` performs one real low-quality generation, subject to account allowance or API charges. `--model gpt-image-2.5-sunburst` selects Sunburst for that probe.

Deployment uses the ordinary stack release. Idle Pi Remote runtimes pick up the extension; active turns keep their runtime until they settle. Interactive terminal sessions use `/reload`. Existing fleet workers retain their release until they finish.
