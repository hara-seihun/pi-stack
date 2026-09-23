import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { InlineImage } from "../server/inline-image-contract";
import { installInlineImages, presentInlineImages, type ImagePresentation } from "./src/inline-images";
import { streamingMarkdown } from "./src/streaming-markdown";

const context: Record<string, any> = { atob };
createContext(context);
runInContext(readFileSync(`${import.meta.dir}/public/vendor/markdown-it.min.js`, "utf8"), context);
const markdown = context.markdownit({ html: false, breaks: true });
installInlineImages(markdown);
function render(source: string, presentation: ImagePresentation = { assistant: true }) {
  const prepared = presentInlineImages(source, "thread/one", presentation);
  return markdown.render(presentation.streaming ? streamingMarkdown(prepared.source) : prepared.source, { inlineImages: prepared.inlineImages });
}
function image(changes: Partial<InlineImage> = {}): InlineImage {
  return { id: "scene", prompt: "An ocean", refs: [], state: "queued", createdAt: "", updatedAt: "", waitingFor: [], error: null, conflict: null, path: null, paths: [], model: null, responseId: null, ...changes };
}
const tag = '<pi-remote-image id="scene" prompt="An ocean" />';

describe("inline image presentation", () => {
  test("renders assistant declarations in prose but leaves instructions and code inert", () => {
    expect(render(`Before ${tag} after`)).toContain('aria-busy="true"');
    expect(render(tag, { assistant: false })).not.toContain('class="inline-image"');
    for (const source of [`\`${tag}\``, `\`\`\`xml\n${tag}\n\`\`\``, `~~~\n${tag}\n~~~`, `    ${tag}`, `\\${tag}`]) {
      expect(render(source)).not.toContain('class="inline-image"');
    }
  });

  test("streaming hides every unfinished tag prefix and keeps code examples inert", () => {
    for (let length = 1; length < tag.length; length++) {
      const html = render("Before " + tag.slice(0, length), { assistant: true, streaming: true });
      expect(html).not.toContain("&lt;");
      expect(html).not.toContain('prompt=');
    }
    const partial = '<pi-remote-image id="scene" prompt="An ocean\nwith `backticks` and <pi-remote-image';
    const html = render(partial, { assistant: true, streaming: true, images: new Map([["scene", image({ state: "complete", path: "/existing.png" })]]) });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('<span class="inline-image-label">scene</span>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("backticks");
    for (const prefix of ["`", "```xml\n", "~~~\n", "    ", "\\"]) {
      expect(render(prefix + tag, { assistant: true, streaming: true })).not.toContain('class="inline-image"');
    }
    expect(render(partial, { assistant: false, streaming: true })).not.toContain('class="inline-image"');
  });

  test("replaces queued state with lazy image using selected person and native environment", () => {
    const original = globalThis.window;
    globalThis.window = {
      PiRemotePerson: { href: (path: string) => `${path}&user=hara` },
      KenanRemote: { resolveApiUrl: (path: string) => `http://127.0.0.1:43123${path}` },
    } as any;
    try {
      const queued = render(tag, { assistant: true, images: new Map([["scene", image({ waitingFor: ["seed"] })]]) });
      expect(queued).toContain("Waiting for seed");
      expect(queued).not.toContain("<img");
      expect(queued).toContain('<span class="inline-image-label">scene</span>');
      const complete = image({ state: "complete", path: "/images/ocean & sky.png", conflict: "ID already has a different prompt" });
      const ready = render('<pi-remote-image id="scene" />', { assistant: true, images: new Map([["scene", complete]]) });
      expect(ready).toContain('loading="lazy"');
      expect(ready).toContain('<span class="inline-image-label">scene</span>');
      expect(ready).toContain('src="http://127.0.0.1:43123/v1/sessions/thread%2Fone/files?path=%2Fimages%2Focean+%26+sky.png&amp;user=hara"');
      expect(ready).not.toContain("Generating image");
      expect(ready).toContain("ID already has a different prompt");
      const url = "http://127.0.0.1:43123/v1/sessions/thread%2Fone/files?path=%2Fimages%2Focean+%26+sky.png&user=hara";
      const failed = render(tag, { assistant: true, images: new Map([["scene", complete]]), failedUrls: new Set([url]) });
      expect(failed).toContain('role="alert"');
      expect(failed).toContain('<a href=');
      expect(failed).not.toContain('<img');
    } finally { globalThis.window = original; }
  });

  test("shows escaped generation errors and missing display-only IDs", () => {
    const failed = image({ state: "error", error: { code: "provider_error", message: '<script>failed</script>' } });
    const html = render(tag, { assistant: true, images: new Map([["scene", failed]]) });
    expect(html).toContain('&lt;script&gt;failed&lt;/script&gt;');
    expect(html).toContain('role="alert"');
    expect(html).toContain('<span class="inline-image-label">scene</span>');
    expect(html).not.toContain('<script>');
    expect(render('<pi-remote-image id="absent" />', { assistant: true, images: new Map() })).toContain('role="alert"');
  });
});
