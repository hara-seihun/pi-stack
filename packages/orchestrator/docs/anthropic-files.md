# Anthropic image references

Pi Stack sends images to Anthropic through the [Files API](https://platform.claude.com/docs/en/build-with-claude/files). It uploads an image once and sends `{type: "file", file_id: "..."}` in subsequent Messages requests. Image quality, dimensions and model-context token charges do not change.

The routing extension installs the [provider wrapper](../src/auth/anthropic-files-provider.ts) for Anthropic and its shared account aliases. It covers interactive Pi, Remote's Pi sessions and fleet Pi sessions. Both `stream` and `streamSimple` use the same wrapper. Other model providers and OpenAI image generation are unchanged.

## Request ownership

The wrapper runs after the existing payload hooks and before Anthropic's Messages request. It uses the request's resolved credentials, account alias and endpoint. The [file service](../src/anthropic-files.ts) replaces inline image sources in user messages and nested tool results. It leaves unrelated payload fields and image-block metadata intact.

The original images remain in the session JSONL, Remote's provider-neutral context and their original files. No session migration or artwork recompression is needed. Switching to another provider still supplies that provider with the original image bytes. Existing image-heavy threads gain file references on their next request after their runtime adopts the release.

File lookup and upload errors stop the request before inference. The wrapper does not send the images inline after a Files API failure. Running this at the provider boundary matters because Pi's ordinary extension payload event reports handler exceptions and then continues with the previous payload.

## Stored references and cleanup

The file service owns a content-addressed mapping under `$XDG_CACHE_HOME/pi-stack/anthropic-files`, or `~/.cache/pi-stack/anthropic-files` when `XDG_CACHE_HOME` is unset. It stores file identifiers and lifecycle metadata, not credentials or image copies. Endpoint and account scope keep references separate; a reference from one account is not assumed to work on another.

Mappings survive runtime restarts. The service validates retained IDs through the file metadata endpoint and replaces missing or expired files from the unchanged original image. Uploads expire after 90 days, so Anthropic owns remote content cleanup even if a process stops or its local cache disappears. The service prunes expired local mappings and replaces references with less than five minutes remaining. Metadata checks run at most eight at a time; uploads run at most four at a time.

Deleting the local cache is not a remote deletion operation. It loses upload reuse until the next request creates mappings again. Uploaded files expire at their recorded `expires_at`; deliberate earlier deletion uses `DELETE /v1/files/{file_id}` with that account's credentials. Original artwork and session history are outside this cache's deletion boundary.

## Provider behavior observed on September 13, 2026

The shared `anthropic-2` subscription credential successfully uploaded a PNG with an expiration and referenced it in a Fable 5.1 Messages request. Fable identified the red test image correctly. Direct metadata lookup and deletion also succeeded. The Files API needs no `files-api-2025-04-14` beta header; OAuth requests retain `oauth-2025-04-20`.

The subscription endpoint returned an empty list from both ordinary file listing and `ids[]` filtering while direct metadata lookup returned the uploaded file. The service therefore uses direct metadata lookup rather than treating an absent list entry as a deleted file.

A September 13 image-heavy thread accumulated 22 inline images containing 34,077,580 base64 bytes, exceeding Anthropic's 32 MiB request-body limit. Token-based recovery estimated 48,770 tokens and retained the whole history under the configured 50,000-token retention target, so compaction returned no work. File references remove the repeated bytes without forcing a summary. A read-only reconstruction of that history reduced the serialized payload from 34,212,088 to 134,566 bytes while retaining all 22 image blocks. The second reconstruction reused every upload. The original JSONL hash stayed unchanged, and neither reconstruction submitted a model inference request. Separately, two live Fable requests reused one uploaded test image and both identified its color correctly. Actual context-token and image-count limits still apply.

## Checks

Focused tests exercise durable reuse, account scoping, concurrent uploads, missing references, expiration, cancellation, nested tool images and failure propagation through Anthropic's serializer:

```sh
npm test --workspace=pi-orchestrator -- --run tests/anthropic-files.test.ts tests/anthropic-files-provider.test.ts tests/anthropic-files-runtime.test.ts
```

The live probe makes two requests with a caller-supplied image and prompt, constructs a fresh provider wrapper between requests, checks that only one upload occurred, and deletes its remote file and temporary local cache. It does not touch a saved session. Run it from a built stack checkout:

```sh
node packages/orchestrator/scripts/anthropic-files-probe.mjs \
  --account ACCOUNT_ALIAS --image /absolute/test.png --prompt "$PROBE_PROMPT"
```

A probe failure reports the failing assertion. If remote deletion fails, its file ID and retained cache path identify the unfinished cleanup. Do not delete the retained mapping before resolving that failure.

Deploy through the stack's [publication worker](../../../docs/deployment.md). Active sessions retain their running release until they settle; the next runtime uses the updated provider. No provider account, model selection or thread history change is required.
