import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import events from "../server/fixtures/tool-progress.json";
import type { TranscriptItemHead } from "../server/protocol";

const browser: Record<string, any> = { atob: (value: string) => Buffer.from(value, "base64").toString("binary") };
browser.window = browser;
createContext(browser);
for (const asset of ["markdown-it.min.js", "texmath.js", "pi-markdown-compat.js"]) {
  runInContext(readFileSync(join(import.meta.dir, "public/vendor", asset), "utf8"), browser);
}

test("a running native command and its partial output stay visible outside collapsed details", async () => {
  const previous = globalThis.window;
  globalThis.window = browser as any;
  try {
    const { entriesFromHeads } = await import("./src/features/conversation/transcript-entries");
    const { Transcript } = await import("./src/features/conversation/Transcript");
    const native = events as any[];
    const start = native[1];
    const partialOutput = native[2].partialResult.content[0].text;
    // The supervisor's head for a call still running: arguments, no result,
    // and the bounded output captured so far.
    const heads: TranscriptItemHead[] = [
      { seq: 0, id: "user-0", kind: "user", size: 12, timestamp: start.timestamp - 10, text: "Where are we?" },
      {
        seq: 1, id: "call-1", kind: "toolCall", size: 400, timestamp: start.timestamp,
        callId: start.toolCallId, name: start.toolName, arguments: start.args, argumentsTruncated: false, partialOutput,
      },
    ];
    const entries = entriesFromHeads(heads);
    entries.push({ kind: "assistant", key: "assistant:2", signature: "assistant-2", text: "A later reply" });
    const html = renderToStaticMarkup(createElement(Transcript, { entries, liveThinking: "", sessionId: "stp", home: "/home/kenan", images: null, onEdit() {} }));

    expect(html).toContain("pwd");
    expect(html).toContain("/home");
    expect(html).not.toContain("thinking-step");
    // The running command is previewed under the collapsed work card, expanded.
    expect(html).toContain("work-latest");
    expect(html).toMatch(/<details[^>]*class="conversation-step tool-step running"[^>]*open/);
  } finally { globalThis.window = previous; }
});

test("a thread that is thinking offers the live card before any text arrives, and its text streams in once opened", async () => {
  const previous = globalThis.window;
  globalThis.window = browser as any;
  try {
    const { Transcript } = await import("./src/features/conversation/Transcript");
    const collapsed = renderToStaticMarkup(createElement(Transcript, {
      entries: [{ kind: "user", key: "user:0", signature: "u0", text: "go" }],
      liveThinking: "", thinkingActive: true, sessionId: "stp", home: "/", images: null, onEdit() {},
    }));
    expect(collapsed).toContain("thinking-step");
    expect(collapsed).toContain("Thinking…");

    const streaming = renderToStaticMarkup(createElement(Transcript, {
      entries: [{ kind: "user", key: "user:0", signature: "u0", text: "go" }],
      liveThinking: "Weighing the options", thinkingActive: true, sessionId: "stp", home: "/", images: null, onEdit() {},
    }));
    expect(streaming).toContain("Weighing the options");
  } finally { globalThis.window = previous; }
});

test("Show earlier asks the server once the client holds the oldest item it was sent", async () => {
  const previous = globalThis.window;
  globalThis.window = browser as any;
  try {
    const { Transcript } = await import("./src/features/conversation/Transcript");
    const html = renderToStaticMarkup(createElement(Transcript, {
      entries: [{ kind: "user", key: "user:40", signature: "u40", text: "hello" }],
      sessionId: "stp", home: "/", images: null, earlierAvailable: true, onShowEarlier() {}, onEdit() {},
    }));
    expect(html).toContain("context-earlier");
    expect(html).toContain("Show 60 earlier");
  } finally { globalThis.window = previous; }
});

test("context images inside item text resolve through the person's endpoint", async () => {
  const previous = globalThis.window;
  const person = { href: (path: string) => `${path}${path.includes("?") ? "&" : "?"}session=token`, get: () => "kenan" };
  globalThis.window = Object.assign(browser, { PiRemotePerson: person, KenanRemote: { resolveApiUrl: (path: string) => `https://host/v1/remotes/cloud${path}` } }) as any;
  try {
    const { renderMarkdown } = await import("./src/context");
    const html = renderMarkdown("Look: ![Context image](/v1/sessions/thread/images/abc123)", "thread");
    expect(html).toContain("https://host/v1/remotes/cloud/v1/sessions/thread/images/abc123?session=token");
    expect(renderMarkdown("![outside](https://example.com/cat.png)", "thread")).toContain("https://example.com/cat.png");
  } finally {
    globalThis.window = previous;
    delete (browser as any).PiRemotePerson;
    delete (browser as any).KenanRemote;
  }
});
