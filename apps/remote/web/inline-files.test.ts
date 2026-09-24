import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { installInlineImages } from "./src/inline-images";
import { installInlineFiles, textPreview } from "./src/inline-files";

const context: Record<string, any> = { atob };
createContext(context);
runInContext(readFileSync(`${import.meta.dir}/public/vendor/markdown-it.min.js`, "utf8"), context);
const markdown = context.markdownit({ html: false, breaks: true });
installInlineImages(markdown);
installInlineFiles(markdown);
function render(source: string) {
  return markdown.render(source, { inlineImages: new Map(), sessionId: "thread/one" });
}
const tag = (path: string) => `<pi-remote-file src="${path}" />`;

describe("inline file presentation", () => {
  test("plays audio and video in place with the file name as a download link", () => {
    const audio = render(`Here it is:\n${tag("/home/hara/voice memo.m4a")}`);
    expect(audio).toContain('<audio controls preload="metadata" src="/v1/sessions/thread%2Fone/files?path=%2Fhome%2Fhara%2Fvoice+memo.m4a"');
    expect(audio).toContain('download="voice memo.m4a"');
    expect(audio).not.toContain("&lt;");
    const video = render(tag("/work/clip.MP4"));
    expect(video).toContain("<video controls");
    expect(video).toContain("playsinline");
    for (const name of ["a.mp3", "a.wav", "a.ogg", "a.opus", "a.flac", "a.aac"]) expect(render(tag(`/x/${name}`))).toContain("<audio");
    for (const name of ["a.mov", "a.webm", "a.mkv", "a.m4v"]) expect(render(tag(`/x/${name}`))).toContain("<video");
  });

  test("embeds PDFs through the inline endpoint and previews text", () => {
    expect(render(tag("/x/report.pdf"))).toContain('<pi-inline-pdf src="/v1/sessions/thread%2Fone/files?path=%2Fx%2Freport.pdf&amp;inline=1"');
    for (const name of ["notes.md", "data.csv", "result.json", "main.py", "Makefile"]) expect(render(tag(`/x/${name}`))).toContain("<pi-inline-text");
  });

  test("keeps pictures as Markdown images and other files as links", () => {
    const photo = render(tag("/x/photo.png"));
    expect(photo).toContain('<img src="/v1/sessions/thread%2Fone/files?path=%2Fx%2Fphoto.png" alt="photo.png">');
    const heic = render(tag("/x/photo.heic"));
    expect(heic).toContain("<a href=");
    expect(heic).not.toContain("<img");
    expect(render(tag("/x/release.tar.gz"))).toContain('<a href="/v1/sessions/thread%2Fone/files?path=%2Fx%2Frelease.tar.gz">release.tar.gz</a>');
  });

  test("escapes names and leaves code examples inert", () => {
    const html = render(tag(`/x/"<b>".mp3`));
    expect(html).not.toContain("<b>");
    for (const source of [`\`${tag("/x/a.mp3")}\``, `\`\`\`\n${tag("/x/a.mp3")}\n\`\`\``, `    ${tag("/x/a.mp3")}`, `\\${tag("/x/a.mp3")}`]) {
      expect(render(source)).not.toContain("<audio");
    }
  });

  test("pretty-prints only a complete JSON document", () => {
    const bytes = new TextEncoder().encode('{"a":[1,2]}');
    expect(textPreview(bytes, "r.json", true)).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(textPreview(bytes, "r.json", false)).toBe('{"a":[1,2]}');
    expect(textPreview(bytes, "r.txt", true)).toBe('{"a":[1,2]}');
  });
});
