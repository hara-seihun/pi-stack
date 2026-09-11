# Inline images

Pi Remote tells agents how to deliver existing images and how to declare images for background generation. Browser and Android use the same renderer.

## Existing files

An assistant reply can show an existing image with:

```xml
<pi-remote-file src="/absolute/path/picture.png" />
```

PNG, JPEG, GIF, WebP, AVIF and SVG files appear inline, linked to their originals. Other files become download links. The file stays on the thread's host.

## Background generation

An assistant can put image declarations between paragraphs of its reply:

```xml
<pi-remote-image id="garden" prompt="A watercolor garden beside a stone cottage at sunrise." />

<pi-remote-image id="gate" prompt="A close view of the garden gate, keeping the same cottage and watercolor style." refs="garden" />
```

Pi Remote owns generation after accepting the declaration. The agent can finish its reply without calling `image_generation` or waiting for the provider. The client shows "Generating image" until it has the PNG, then displays the image linked to its original. Dependent images wait for their inputs; independent images can run concurrently. Closing the client does not cancel the work.

Only complete declarations in assistant text submit work. User messages, system instructions, tool results and code examples do not submit image requests. Streaming placeholders do not start requests from the browser.

### IDs and references

IDs belong to a Remote thread, not a single message. They start with a letter and contain up to 64 letters, digits, underscores or hyphens. Repeating the same definition reuses the job. A different definition under the same ID reports a conflict rather than overwriting the first image. Use a new ID for a revision.

Display an image again without defining another job:

```xml
<pi-remote-image id="garden" />
```

References can name generated IDs or absolute paths to existing PNG, JPEG or WebP files, including uploaded attachments:

```xml
<pi-remote-image id="poster" prompt="Make a travel poster using the garden composition and the supplied logo." refs="garden,/home/kenan/reference-logo.png" />
```

Use a JSON array when a path contains commas:

```xml
<pi-remote-image id="poster-detail" prompt="A closer crop of the poster, using this reference." refs='["poster","/home/kenan/reference, detail.png"]' />
```

Attribute values use XML escaping. For example, `&quot;` represents a double quote inside a double-quoted prompt and `&amp;` represents an ampersand. Prompts can contain up to 32,000 characters. A job accepts up to 16 references with at most 32 MiB of input image data.

## Provider and failures

Background jobs use the same [Orchestrator image-generation implementation](../../../packages/orchestrator/docs/image-generation.md) and connected OpenAI accounts as the native tool. The default model is Image 2.5 Flare. The provider receives only the image prompt and reference images, not the surrounding conversation.

The UI shows missing references, dependency cycles, failed dependencies, invalid inputs and provider failures as errors. Failed or interrupted provider requests are not automatically repeated, because the request may already have consumed allowance. A deliberate new ID requests another generation.

Queued jobs survive supervisor restarts. A running request with no saved result becomes an explicit interruption error. Saved output can be recovered without generating it again. Generated IDs and output paths remain available to later agent turns through thread instructions.
