# Inline images and files

One image tag shows an existing image or generates one. Browser and Android render the same immutable image registry. Other artifacts use the file tag.

## Existing images

```xml
<pi-remote-image id="picture" path="/absolute/path/picture.png" />
```

`path` and `prompt` are mutually exclusive. Path definitions copy the image into the same retained artifact custody as generated images; they never call a provider. Later edits to the original file cannot change the accepted image. Supported path formats are PNG, JPEG, GIF, WebP, AVIF, SVG and BMP, with a 32 MiB limit. References are accepted only with a prompt.

## Other files

A message can deliver another artifact with:

```xml
<pi-remote-file src="/absolute/path/report.pdf" />
```

The file's extension chooses the presentation, and every presentation keeps the file name as a download link beneath it:

- M4A, MP3, AAC, WAV, Ogg, Opus, FLAC and WebA files get an audio player; MP4, M4V, MOV, WebM, Ogg video and MKV files get a video player. Both load only metadata until played and seek with range requests. A codec the browser lacks leaves the player inert, with the link still there.
- PDFs are embedded where the browser has a PDF viewer (`navigator.pdfViewerEnabled`). Android WebView and mobile browsers have none, so they show the link.
- Text, code, Markdown, JSON and CSV files show their first 64 KiB in a scrollable, expandable block. A complete JSON document is pretty-printed.
- Anything else is a download link.

The file stays on the thread's host. The session file endpoint serves it with range support; `inline=1` displays PDFs, audio, video and raster images in place, while scriptable types such as HTML and SVG are always sent as attachments. [`web/src/inline-files.ts`](../web/src/inline-files.ts) owns the presentation.

## Background generation

An assistant can put image declarations between paragraphs of its reply:

```xml
<pi-remote-image id="garden" prompt="A watercolor garden beside a stone cottage at sunrise." />

<pi-remote-image id="gate" prompt="A close view of the garden gate, keeping the same cottage and watercolor style." refs="garden" />
```

Core owns generation after accepting the declaration. The agent can finish its reply without calling `image_generation` or waiting for the provider. The client shows "Generating image" until it has the PNG, then displays the image linked to its original. Dependent images wait for their inputs; independent images can run concurrently. Closing the client does not cancel the work.

Complete declarations submit work when their assistant message finalizes. User messages, system instructions, tool results and code examples do not submit image requests. Streaming placeholders do not start requests from the browser.

### IDs and references

IDs belong to a Remote thread, not a single message. They start with a letter and contain up to 64 letters, digits, underscores or hyphens. Repeating the same definition reuses the job. A different definition under the same ID reports a conflict rather than overwriting the first image. Use a new ID for a revision.

Display an image again without defining another job:

```xml
<pi-remote-image id="garden" />
```

References can name earlier IDs, definitions in the same finalized message, or absolute paths to existing PNG, JPEG or WebP files, including uploaded attachments. An ID defined only in a later message is a missing reference:

```xml
<pi-remote-image id="poster" prompt="Make a travel poster using the garden composition and the supplied logo." refs="garden,/home/alex/reference-logo.png" />
```

Use a JSON array when a path contains commas:

```xml
<pi-remote-image id="poster-detail" prompt="A closer crop of the poster, using this reference." refs='["poster","/home/alex/reference, detail.png"]' />
```

Attribute values use XML escaping. For example, `&quot;` represents a double quote inside a double-quoted prompt and `&amp;` represents an ampersand. Prompts can contain up to 32,000 characters. A job accepts up to 16 references with at most 32 MiB of input image data.

## Provider and failures

Background jobs use the [Orchestrator image-generation implementation](../../../packages/orchestrator/docs/image-generation.md) and its shared Codex account pool. The native tool additionally supports personal Pi credentials. The default model is Image 2.5 Flare. The provider receives only the image prompt and reference images, not the surrounding conversation.

The UI shows missing references, dependency cycles, failed dependencies, invalid inputs and provider failures as errors. Failed or interrupted provider requests are not automatically repeated, because the request may already have consumed allowance. A deliberate new ID requests another generation.

Queued jobs survive core and Remote restarts. A running request with no saved result becomes an explicit interruption error. Saved output can be recovered without generating it again. Generated IDs and output paths remain available to later agent turns through thread instructions.

## State and operations

`packages/orchestrator/src/core/images.ts` owns the controller and adopts the existing registry in place. `image-registry.ts` retains definitions, status, message deduplication and version counters together in the person's existing database. Files live under `PI_REMOTE_DATA/inline-images/<thread-hash>/<image-id>/`: copied reference inputs, image bytes and durable publication receipts. Generated attempts additionally retain the provider receipt; path definitions have no provider identity. These are retained thread artifacts, not a disposable cache. Keep this directory with the supervisor database when backing up or restoring a person. Removing a source reference after the worker has copied it does not remove the job's input.

`GET /v1/sessions/:sessionId/images` returns the thread's image registry without submitting work. Changed image state reaches clients as an `images` event on their stream. The session file endpoint serves completed image artifacts using the selected person and environment. Neither endpoint calls the provider.

Core runs at most two image requests concurrently per registry. Each request has a five-minute deadline. Restarting core recovers queued jobs and saved receipts; it does not retry uncertain provider calls. Image artifacts remain with the person's Remote data until that data is explicitly removed.

Core configuration explicitly declares each scope's existing database, artifact directory, adoption receipt, allowed file roots and data resource. Native ingress and provider/path access require execute/use grants; registry reads require read grants. The receipt claims the seven image tables through the shared physical database custody lock. Adoption transactionally retargets existing image-table foreign keys to `core_image_threads`, preserving identity pointers, rows, versions and attempt directories without tying them to Remote presentation rows. Adoption must preserve the old owner's finalized native source watermarks as `nativeImageSources` entries (`threadId`, `path`, `revision`, `lastOffset`, `lastDigest`). Core subscribes to native finalized assistant messages and scans only outputs after a trustworthy boundary. An unknown historical gap becomes an explicit ingress error, never authority to regenerate old images.

Remote is a projection client. Its `core_image_outbox` stores exact finalized messages until core accepts them through `POST /v1/scopes/:scopeId/images/accept`; ambiguous transport outcomes retain the same message identity. `POST /images/sync` returns changed snapshots and explicit ingress errors. Remote restarts never own or cancel provider work, and no new local registry is created. Native ingestion continues with Remote offline.
