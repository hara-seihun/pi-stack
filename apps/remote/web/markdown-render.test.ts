import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

setDefaultTimeout(30_000);

function renderer() {
  const context: Record<string, any> = {
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  };
  context.window = context;
  context.globalThis = context;
  createContext(context);
  for (const asset of ["markdown-it.min.js", "katex.min.js", "texmath.js"]) {
    runInContext(readFileSync(join(import.meta.dir, "public", "vendor", asset), "utf8"), context, { filename: asset });
  }
  runInContext(readFileSync(join(import.meta.dir, "public", "vendor", "pi-markdown-compat.js"), "utf8"), context, { filename: "pi-markdown-compat.js" });
  const markdown = context.markdownit({ html: false, breaks: true, linkify: true }).use(context.texmath, {
    engine: context.katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: { throwOnError: false, strict: "ignore", trust: false },
  });
  return { render: (source: string) => markdown.render(context.normalizeLatexDelimiters(source)) };
}

// The renderer is not in the page at startup: `markdown-engine.ts` downloads
// markdown-it, texmath and the delimiter shim when the first Markdown block
// mounts. A test with the vendor scripts already on `window` gets it without a
// download, and anything asynchronous can await `ensureMarkdown()`.
describe("the lazy Markdown engine", () => {
  test("shows escaped source with its line breaks until the renderer exists", async () => {
    const { plainMarkdownHtml } = await import("./src/markdown-engine");
    const html = plainMarkdownHtml("# Result\n<script>alert(1)</script> & more");
    expect(html).toBe('<div class="markdown-plain"># Result\n&lt;script&gt;alert(1)&lt;/script&gt; &amp; more</div>');
    expect(html).not.toContain("<script>");
  });

  test("ensureMarkdown resolves with a renderer and renders Markdown", async () => {
    const previous = globalThis.window;
    const browser: Record<string, any> = { atob: (value: string) => Buffer.from(value, "base64").toString("binary") };
    browser.window = browser;
    createContext(browser);
    for (const asset of ["markdown-it.min.js", "texmath.js", "pi-markdown-compat.js"]) {
      runInContext(readFileSync(join(import.meta.dir, "public", "vendor", asset), "utf8"), browser, { filename: asset });
    }
    globalThis.window = browser as any;
    try {
      const { ensureMarkdown, markdownRenderer } = await import("./src/markdown-engine");
      await ensureMarkdown();
      const markdown = markdownRenderer();
      expect(markdown).not.toBeNull();
      expect(markdown!.render("**bold**")).toContain("<strong>bold</strong>");
    } finally { globalThis.window = previous; }
  });
});

describe("browser message rendering", () => {
  test("renders Markdown with inline and display LaTeX", () => {
    const output = renderer().render([
      "# Result",
      "",
      "- **bold**",
      "- `code`",
      "",
      "Inline $E=mc^2$ and \\(a+b\\).",
      "",
      "$$\\int_0^1 x^2 \\, dx$$",
    ].join("\n"));
    expect(output).toContain("<h1>Result</h1>");
    expect(output).toContain("<strong>bold</strong>");
    expect(output).toContain("<code>code</code>");
    expect(output.match(/class=\"katex\"/g)?.length).toBe(3);
    expect(output).toContain("katex-display");
  });

  test("renders multiline bracket LaTeX inside prose and lists", () => {
    const output = renderer().render([
      "Before",
      "\\[",
      "(K_X^2,c_2(X),\\chi)=(9,3,1).",
      "\\]",
      "After",
      "",
      "1. A list item:",
      "   \\[",
      "   K_Y^2=888",
      "   \\]",
    ].join("\n"));
    expect(output.match(/class=\"katex\"/g)?.length).toBe(2);
    expect(output.match(/katex-display/g)?.length).toBe(2);
    expect(output).not.toContain("<br>\n[<br>");
  });

  test("preserves bracket delimiters in inline and fenced code", () => {
    const output = renderer().render("`\\(inline code\\)`\n\n```tex\n\\[fenced code\\]\n```\n\n\\[math\\]");
    expect(output).toContain("<code>\\(inline code\\)</code>");
    expect(output).toContain("\\[fenced code\\]");
    expect(output.match(/class=\"katex\"/g)?.length).toBe(1);
  });

  test("does not enable raw message HTML", () => {
    const output = renderer().render('<img src=x onerror="alert(1)">');
    expect(output).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(output).not.toContain("<img");
  });
});
