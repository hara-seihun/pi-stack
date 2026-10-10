import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "./src/features/conversation/Transcript";
import type { ContextEntry } from "./src/types";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const start = new Date(2026, 9, 10, 12).getTime();
const noAction = () => {};
const human: ContextEntry = { kind: "user", key: "human", signature: "human", inputOrigin: "human", text: "Hello", messageTimestamp: start };
const answer: ContextEntry = { kind: "assistant", key: "answer", signature: "answer", text: "Hello back", messageTimestamp: start + 60_000 };
const render = (entries: ContextEntry[], mono: boolean) => renderToStaticMarkup(<Transcript entries={entries} messenger mono={mono} sessionId="manager" home="/work" images={null} onEdit={noAction} onReply={noAction} onRetryPrompt={noAction} />);

test("manager bubbles keep day separators and human receipts without visible timestamps in mono or classic", () => {
  for (const mono of [true, false]) {
    for (const state of ["sending", "delivered", "read"] as const) {
      const html = render([{ ...human, promptDelivery: { state } }, answer], mono);
      expect(html).toContain('class="chat-day"');
      expect(html).toContain('role="separator"');
      expect(html).not.toContain("<time");
      expect(html).not.toContain("chat-group-time");
      expect(html.match(/class="prompt-delivery"/g)).toHaveLength(1);
      expect(html).toContain(`data-delivery="${state}"`);
      const agent = html.slice(html.indexOf('class="transcript-message-agent"'));
      expect(agent).not.toContain("prompt-delivery");
    }
  }
});

test("missing message timestamps do not manufacture a date or hide the human receipt", () => {
  const html = render([{ ...human, messageTimestamp: undefined, promptDelivery: { state: "read" } }], true);
  expect(html).not.toContain("chat-day");
  expect(html).not.toContain("<time");
  expect(html).toContain('data-delivery="read"');
});

test("uncertain delivery keeps its actual failure and same-request retry outside the bubble", () => {
  const html = render([{ ...human, promptDelivery: { state: "failed", message: "Acknowledgement lost", retryRequestId: "saved-request" } }], true);
  expect(html).toContain('data-delivery="failed"');
  expect(html).toContain("Acknowledgement lost");
  expect(html).toContain("Tap to retry");
  expect(html).not.toContain("<time");
});
