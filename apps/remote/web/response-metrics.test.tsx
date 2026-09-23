import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResponseMetrics, TranscriptItemHead } from "../server/protocol";
import { entryFromHead } from "./src/features/conversation/transcript-entries";
import { Transcript } from "./src/features/conversation/Transcript";
import { formatResponseMetrics } from "./src/response-metrics";
import type { ContextEntry } from "./src/types";

// Artwork paths derive from the page address; there is no page here.
globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const metrics = (fields: Partial<ResponseMetrics> = {}): ResponseMetrics => ({
  ttftMs: 1_234,
  generationMs: 2_500,
  outputTokens: 121,
  tokensPerSecond: 48.4,
  ...fields,
});

const assistantHead = (responseMetrics?: ResponseMetrics): TranscriptItemHead => ({
  seq: 1,
  id: "assistant-body",
  kind: "assistant",
  size: 6,
  timestamp: 1_000,
  text: "Answer",
  responseMetrics,
});

function renderEntry(entry: ContextEntry) {
  return renderToStaticMarkup(<Transcript
    entries={[entry]}
    sessionId="thread"
    home="/home/kenan"
    images={null}
    onEdit={() => {}}
  />);
}

function renderAssistant(responseMetrics?: ResponseMetrics) {
  return renderEntry(entryFromHead(assistantHead(responseMetrics)));
}

test("the agent's messages are Kenan's, with the head artwork, whatever label an older head stored", () => {
  expect(entryFromHead(assistantHead()).label).toBe("Kenan");
  expect(entryFromHead({ ...assistantHead(), label: "Assistant" }).label).toBe("Kenan");
  const html = renderAssistant();
  expect(html).toContain('class="message-label">KENAN</span>');
  expect(html).toContain('class="message-avatar" src="/kenan.png"');
});

for (const kind of ["toolCall", "thinking"] as const) {
  for (const running of [false, true]) {
    test(`${kind} keeps response metrics in the summary while ${running ? "running" : "done"}`, () => {
      const head: TranscriptItemHead = kind === "toolCall" ? {
        seq: 1, id: "call", kind, size: 20, callId: "call", name: "read",
        arguments: { path: "/home/kenan/example.txt" }, argumentsTruncated: false,
        ...(!running ? { result: { isError: false, size: 6, preview: "result", imageCount: 0 } } : {}),
      } : {
        seq: 1, id: "thinking", kind, size: 20, preview: "Considering the result",
      };
      const before = entryFromHead(head);
      const after = entryFromHead({ ...head, responseMetrics: metrics() });
      if (kind === "thinking") {
        before.streaming = running;
        after.streaming = running;
      }
      expect(after.signature).not.toBe(before.signature);
      expect(renderEntry(before)).not.toContain('class="step-metrics"');
      const html = renderEntry(after);
      const summary = html.match(/<summary>(.*?)<\/summary>/s)![1];
      expect(summary).toContain('class="step-metrics"');
      expect(summary).toContain("1.2 s to first token · 48 tok/s");
      expect(summary).not.toContain('class="step-icon"');
      if (running) {
        expect(html).toContain('aria-busy="true"');
        expect(summary).not.toContain('class="step-outcome"');
        expect(summary).not.toContain(head.kind === "thinking" ? head.preview : "example.txt");
      } else {
        expect(summary).toContain('data-status="done">Done</span>');
        expect(summary).toContain(head.kind === "thinking" ? head.preview : "example.txt");
      }
    });
  }
}

test("formats response latency and generation rate consistently", () => {
  expect(formatResponseMetrics(metrics({ ttftMs: 800 }))).toBe("0.8 s to first token · 48 tok/s");
  expect(formatResponseMetrics(metrics({ ttftMs: 65_000, tokensPerSecond: 9.94 }))).toBe("65.0 s to first token · 9.9 tok/s");
  expect(formatResponseMetrics(metrics({ tokensPerSecond: 10 }))).toBe("1.2 s to first token · 10.0 tok/s");
  expect(formatResponseMetrics(metrics({ tokensPerSecond: null }))).toBe("1.2 s to first token");
});

test("assistant entries show response metrics only after the metrics arrive", () => {
  const before = entryFromHead(assistantHead());
  const after = entryFromHead(assistantHead(metrics()));

  expect(after.signature).not.toBe(before.signature);
  expect(renderAssistant()).not.toContain("to first token");
  const html = renderAssistant(metrics());
  expect(html).toContain('class="message-metrics"');
  expect(html).toContain("1.2 s to first token · 48 tok/s");
});
