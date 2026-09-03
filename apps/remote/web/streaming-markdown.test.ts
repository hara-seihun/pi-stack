import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { streamingMarkdown } from "./src/streaming-markdown";

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
  const normalize = (source: string) => context.normalizeLatexDelimiters(source);
  return {
    live: (source: string) => markdown.render(streamingMarkdown(normalize(source))),
    settled: (source: string) => markdown.render(normalize(source)),
  };
}

const render = renderer();

/** Every prefix of `source`, rendered the way a reader would see it arrive. */
function frames(source: string) {
  return Array.from({ length: source.length + 1 }, (_, length) => render.live(source.slice(0, length)));
}

function text(html: string) {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

describe("streaming Markdown completion", () => {
  test("closes an open fence so code renders while it streams", () => {
    expect(streamingMarkdown("```js\nconst x = 1;")).toBe("```js\nconst x = 1;\n```\n");
    expect(render.live("```js\nconst x = 1;")).toContain("<pre>");
    expect(text(render.live("```js\nconst x = 1;"))).toBe("const x = 1;");
  });

  test("closes a fence nested in a list item", () => {
    expect(streamingMarkdown("1. Run:\n\n   ```sh\n   ls")).toBe("1. Run:\n\n   ```sh\n   ls\n   ```\n");
  });

  test("closes an open code span and emphasis run", () => {
    expect(streamingMarkdown("Call `open")).toBe("Call `open`");
    expect(streamingMarkdown("This is **bold te")).toBe("This is **bold te**");
    expect(streamingMarkdown("This is **bold `co")).toBe("This is **bold `co`**");
    expect(render.live("This is **bold te")).toContain("<strong>bold te</strong>");
  });

  test("leaves prose punctuation alone", () => {
    expect(streamingMarkdown("snake_case_name and 3 * 4 * 5")).toBe("snake_case_name and 3 * 4 * 5");
    expect(streamingMarkdown("It costs $5 today")).toBe("It costs $5 today");
    expect(streamingMarkdown("A star * at the end")).toBe("A star * at the end");
  });

  test("hides a half-written link, image, and download tag", () => {
    expect(streamingMarkdown("See [the doc")).toBe("See ");
    expect(streamingMarkdown("See [the doc](https://exa")).toBe("See ");
    expect(streamingMarkdown("See [the doc](https://example.com) now")).toBe("See [the doc](https://example.com) now");
    expect(streamingMarkdown("Look ![alt](htt")).toBe("Look ");
    expect(streamingMarkdown("Here it is <pi-remote-fi")).toBe("Here it is ");
  });

  test("hides formulas until they can compile", () => {
    expect(streamingMarkdown("The value $\\frac{a}{b")).toBe("The value ");
    expect(streamingMarkdown("Display:\n\n$$\\int_0^1 x")).toBe("Display:\n\n");
    expect(streamingMarkdown("Display:\n\n$$\\int_0^1 x$$")).toBe("Display:\n\n$$\\int_0^1 x$$");
    expect(streamingMarkdown("$$\\begin{aligned}\na &= b")).toBe("");
    expect(render.live("The value $\\frac{a}{b")).not.toContain("ParseError");
  });

  test("holds a table back until its delimiter row lands", () => {
    expect(streamingMarkdown("| Name | Size |\n")).toBe("");
    expect(streamingMarkdown("| Name | Size |\n| --- |")).toBe("");
    expect(streamingMarkdown("| Name | Size |\n| --- | --- |\n| a | 1 |\n| b")).toBe("| Name | Size |\n| --- | --- |\n| a | 1 |\n");
    expect(render.live("| Name | Size |\n| --- | --- |\n| a | 1 |\n| b")).toContain("<table>");
  });

  test("holds back a marker that has not become a block yet", () => {
    expect(streamingMarkdown("Intro\n\n#")).toBe("Intro\n\n");
    expect(streamingMarkdown("Intro\n-")).toBe("Intro\n");
    expect(streamingMarkdown("Intro\n\n- item\n-")).toBe("Intro\n\n- item\n");
    expect(streamingMarkdown("Intro\n\n## Ne")).toBe("Intro\n\n## Ne");
    expect(render.live("Intro\n\n## Ne")).toContain("<h2>Ne</h2>");
  });

  test("keeps a settled document untouched", () => {
    const document = [
      "# Title",
      "",
      "Prose with **bold**, `code`, [a link](https://example.com) and $E=mc^2$.",
      "",
      "- one",
      "- two",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```sh",
      "ls -la",
      "```",
      "",
      "$$\\int_0^1 x^2 \\, dx$$",
      "",
    ].join("\n");
    expect(streamingMarkdown(document)).toBe(document);
    expect(render.live(document)).toBe(render.settled(document));
  });

  test("every prefix renders as Markdown rather than as its source", () => {
    const source = [
      "# Report",
      "",
      "The **first** result is `ready`, see [details](https://example.com).",
      "",
      "1. Run:",
      "",
      "   ```sh",
      "   ls -la",
      "   ```",
      "",
      "| Name | Size |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "Then $E=mc^2$ follows.",
    ].join("\n");
    for (const html of frames(source)) {
      expect(html).not.toContain("**");
      expect(html).not.toContain("](");
      expect(html).not.toContain("| ---");
      expect(html).not.toMatch(/<p>[^<]*```/);
      expect(html).not.toMatch(/\$\$|\$E/);
    }
  });

  test("rendered text only grows while a message streams", () => {
    const source = [
      "Working on **the plan**, which needs `care`.",
      "",
      "- [reference](https://example.com/a)",
      "- inline math $x^2 + y^2$ and a table:",
      "",
      "| Step | State |",
      "| --- | --- |",
      "| one | done |",
      "| two | next |",
      "",
      "```py",
      "print('hello')",
      "```",
      "",
      "Done.",
    ].join("\n");
    let longest = "";
    for (const [length, html] of frames(source).entries()) {
      const visible = text(html);
      // Text is allowed to appear and to grow; it must never be replaced by a
      // shorter rendering of what the reader already saw settle.
      const settled = longest.slice(0, Math.max(0, longest.length - 24));
      expect({ length, visible }).toMatchObject({ length, visible: expect.stringContaining(settled) });
      if (visible.length > longest.length) longest = visible;
    }
    expect(text(render.live(source))).toBe(text(render.settled(source)));
  });
});
