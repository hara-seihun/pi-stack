import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkPreviewCard } from "./src/link-previews";

test("preview cards escape metadata, open the page, and omit missing artwork", () => {
  const preview = { url: "https://example.com/article", title: "<script>Title</script>", description: "A & B", siteName: "Example", imageUrl: null };
  const html = renderToStaticMarkup(<LinkPreviewCard preview={preview} />);
  expect(html).toContain('href="https://example.com/article"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).toContain("&lt;script&gt;Title&lt;/script&gt;");
  expect(html).toContain("A &amp; B");
  expect(html).not.toContain("<img");
  const image = renderToStaticMarkup(<LinkPreviewCard preview={{ ...preview, imageUrl: "/v1/messaging/preview-image/example" }} />);
  expect(image).toContain('class="link-preview-artwork"');
  expect(image).toContain('class="link-preview-image-placeholder"');
  expect(image).not.toContain('<img');
  const bare = renderToStaticMarkup(<LinkPreviewCard preview={{ ...preview, title: "", siteName: null, description: null }} />);
  expect(bare).toContain('link-preview-site">example.com');
  expect(bare).not.toContain("link-preview-description");
});
