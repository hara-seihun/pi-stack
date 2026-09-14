import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import events from "../server/fixtures/tool-progress.json";
import { displayContextDocument } from "../server/context-display";

const browser: Record<string, any> = { atob: (value: string) => Buffer.from(value, "base64").toString("binary") };
browser.window = browser;
createContext(browser);
for (const asset of ["markdown-it.min.js", "katex.min.js", "texmath.js", "pi-markdown-compat.js"]) {
  runInContext(readFileSync(join(import.meta.dir, "public/vendor", asset), "utf8"), browser);
}

test("active native commands and their output stay visible outside collapsed details", async () => {
  const previous = globalThis.window;
  globalThis.window = browser as any;
  try {
    const { ContextTranscript, modelContextEntries } = await import("./src/context");
    const native = events as any[];
    const start = native[1];
    const context = JSON.parse(displayContextDocument(JSON.stringify({ systemPrompt: "", tools: [], messages: [native[0].message] }), new Map(), undefined, [{
      id: start.toolCallId, name: start.toolName, args: start.args, startedAt: start.timestamp,
      output: native[2].partialResult.content[0].text,
    }]));
    const entries = modelContextEntries(context);
    expect(entries.filter(entry => entry.kind === "thinking")).toHaveLength(0);
    entries.push({ kind: "assistant", key: "reply", signature: "reply", text: "A later reply" });
    const html = renderToStaticMarkup(createElement(ContextTranscript, { entries, liveThinking: "", sessionId: "stp", home: "/home/kenan", onEdit() {} }));
    expect(html).toContain("pwd");
    expect(html).toContain("/home");
    expect(html).not.toContain('message thinking');
    expect(html).toContain('detail-group-latest');
  } finally { globalThis.window = previous; }
});
