# Model image payloads

PiStack owns this repair in [model-payload.mjs](model-payload.mjs). [patch-image-payload.mjs](patch-image-payload.mjs) installs it in the pinned Pi dependency tree. The same helper serves the Orchestrator [image-generation preview](../orchestrator/src/extension/image-preview.ts).

## September 12 incident

Thread `9119452f-9273-4c2c-96d8-97d2beba5cbb`, Nebulani Body Modeling, saved `/home/kenan/projects/nebulani-show/renders/gen/woman-v4.png` at 20:13:21.457 UTC. Generation succeeded. The next Anthropic request failed at 20:13:22.883 with HTTP 413 `request_too_large`, then failed again at 20:15:27.274.

The native session is `/home/kenan/hara/.pi-remote/sessions/2026-09-12T05-30-29-041Z_01a09418-8131-7023-b845-e311eb2c4c01.jsonl`. Its active context contained 18 PNG blocks. Their base64 alone occupied 34,196,804 bytes. The Remote checkpoint occupied 34,558,221 UTF-8 bytes, including its system prompt, tools and 104 messages.

Pi's per-image resizing allowed several megabytes per image. Image generation also returned the complete PNG as its preview. Token-based compaction did not constrain the resulting HTTP body. Compaction retained the images, and another compaction attempt encountered a policy refusal. The images, not generation failure or a local server body limit, caused the request failure.

### Offline measurement

The fixture copied the checkpoint through a read-only SQLite connection, then used Pi's real Anthropic serializers with an in-memory fetch transport. It supplied a synthetic credential solely to exercise the existing OAuth serialization branch. No request left the process. The checkpoint, native JSONL and image originals were unchanged.

| Representation | HTTP body bytes | Images | Image base64 bytes |
| --- | ---: | ---: | ---: |
| Original Pi SDK | 34,531,753 | 18 | 34,196,804 |
| Repaired SDK | 3,258,607 | 18 | 2,918,868 |
| Repaired bundled CLI | 3,258,607 | 18 | 2,918,868 |

These are captured UTF-8 request body sizes after Anthropic SDK serialization, not token estimates or checkpoint sizes. The copied checkpoint SHA-256 was `28ec483ab9d82bdf301edce9b09006118237de221de137d51edac76ea0040035`.

The final `woman-v4.png` original is 1,640,991 bytes at 1024×1536. Its model representation is a 1024×1536 JPEG with 171,636 base64 bytes. One cold conversion took 244 ms; the memoized conversion took 1.5 ms on gmktec.

## Ownership and behavior

The provider boundary handles existing history and new read, browser, user, and tool images. It runs after extension payload hooks, so an extension that injects a Codex checkpoint's images cannot bypass conversion. It recognizes native Pi, Anthropic, OpenAI Responses, Chat Completions, Mistral, Google, and Bedrock inline image forms. Tool arguments, tool schemas and opaque encrypted checkpoints are not rewritten.

Supported PNG, JPEG, WebP and GIF inputs retain their complete source bytes at Pi ingress instead of being resized before session persistence. The provider works on a separate representation. Already-resized historical inputs cannot be reconstructed. Unsupported ingress formats still use Pi's existing format conversion, while the original files remain on disk.

Every inline image remains present. Its adjacent representation note identifies source SHA-256, original dimensions and bytes, output dimensions, MIME type and base64 bytes. Google multimodal function responses keep that metadata inside the response object because their image parts do not accept text. JPEG conversion composites transparency onto white and marks that change. Converted GIFs explicitly identify their first-frame representation.

The helper uses Pi's existing Photon WASM dependency, applies EXIF orientation, preserves aspect ratio and tries PNG before JPEG. JPEG quality descends from 85 to 70 to 55 before dimensions decrease. Conversion is memoized by source hash, MIME type and byte budget, including concurrent requests for the same input. The cache retains at most 128 results and 32 MiB of base64, not the original buffers. It has no disk state.

The image-generation tool publishes full originals before creating its bounded preview. Its result includes the original path and representation metadata. A preview failure reports the saved paths and explicit error without repeating generation or deleting the originals.

## Budgets and diagnostics

- Each image gets at most 384 KiB of base64 and a longest edge of 1568 pixels.
- The aggregate image allocation is 12 MiB of base64. Larger image sets share it equally.
- Conversion stops with an explicit error rather than allocating less than 64 KiB per image or shrinking the longest edge below 256 pixels. Smaller source images are not enlarged.
- The request JSON budget is 20 MiB. Text, tool definitions and representation notes count too. A remaining oversized request fails locally without dropping history.
- Non-vision models fail explicitly when the selected context contains images, before Pi can filter those images out.

Successful assistant messages carry `pi_model_payload` diagnostics. `provider-payload-json` records the serialized adapter parameters and image metadata. `http-body` records the exact UTF-8 body supplied to fetch. Codex also records and checks `websocket-frame`, including the response-create envelope and any cached-context delta. Those byte measurements are separate from model usage and context-token accounting.

Anthropic, Azure, OpenAI Responses, Chat Completions, Codex HTTP, Mistral and Pi Messages have both parameter and final HTTP-body checks. Google and Bedrock expose no equivalent custom-fetch boundary in this pinned Pi adapter. They get the bounded images and parameter-JSON check, with binary Bedrock images counted as base64, but no claim of exact final SDK wire bytes. Anthropic clients supplied directly through `options.client` likewise bypass Pi's fetch boundary and retain the parameter check.

HTTP 413 and `request_too_large` are no longer classified as token overflow. A byte failure does not start automatic token compaction. Actual token-overflow behavior is unchanged. Conversion and byte errors use explicit `PI_MODEL_PAYLOAD_*` errors and do not alter provider authentication or stored prompts.

Provider token windows, image-count limits, lower gateway limits and content policies still apply. Remote image URLs and provider file IDs are references, not inline bytes to transcode. A wholly custom streaming API needs to adopt this boundary itself. Historical or UI storage can still be large because it retains originals. Agents needing fine detail can read or crop the original source rather than treating the bounded preview as the original.

## Build and deploy

The patch covers all ten text-provider implementations in both Pi AI SDK modules and the coding-agent CLI bundle. It also covers both image-ingress implementations and both overflow classifiers. It refuses changed upstream boundaries rather than silently patching only one consumer.

The deployment owner must include `packages/runtime/model-payload.mjs` and `packages/runtime/patch-image-payload.mjs` in the immutable dependency hash, then run:

```sh
node packages/runtime/patch-image-payload.mjs /absolute/stage/node_modules
```

The helper is installed at `@earendil-works/pi-ai/dist/model-payload.mjs`. Provider imports are relative to that immutable tree. The Orchestrator preview resolves that same installed helper. Runtime deployment must precede the Orchestrator release. No new package or lockfile change is needed. Removing a release removes its helper; there is no separate cache directory to recover or clean.

Focused offline checks:

```sh
node --test packages/runtime/image-payload.test.mjs
npx vitest run packages/orchestrator/tests/image-generation.test.ts packages/orchestrator/tests/image-preview.test.ts --maxWorkers=1
```

To reproduce the incident measurement from a disposable copy of the checkpoint, use a checkout with freshly installed, unpatched pinned dependencies:

```sh
node packages/runtime/image-payload-fixture.mjs /absolute/path/to/copied-context.json
```

The fixture builds disposable patched SDK and bundled provider modules, asserts identical results, captures actual serialized bodies, verifies the image count and byte limits, and checks that the input context was not mutated. It prints counts and a source hash, never image data or prompt text. Delete the private checkpoint copy after the run. Do not send or replay the canonical thread to verify this repair.
