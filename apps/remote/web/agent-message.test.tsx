import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatThreadMessage } from "../../../packages/orchestrator/src/threads/message-format";
import { AgentMessage, agentMessageSender } from "./src/features/conversation/agent-message";
import { entriesFromHeads } from "./src/features/conversation/transcript-entries";
import { Transcript } from "./src/features/conversation/Transcript";
import { deriveTranscriptItems } from "../server/transcript-items";
import type { ThreadMessage } from "../../../packages/orchestrator/src/threads/contracts";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;
const sender = "7c925d87-bc2b-4293-933a-f9ffee9b3592";
const recipient = "303efcde-ee6c-43f5-b3ed-522aa9f34ca4";
const message: ThreadMessage = { id: "one", threadId: recipient, senderId: sender, text: "Full existing message **content**", images: [], delivery: "steer", source: "explicit", state: "done", createdAt: 1, insertedAt: 1, landedAt: 1 };
const text = formatThreadMessage(message, message.text);

test("recognizes actual explicit sends and child completion notices, including image tails", () => {
  expect(agentMessageSender({ kind: "user", text })).toBe(sender);
  const notice = { ...message, source: "notification" as const, text: '{"type":"thread_idle","outcome":"completed","finalText":"done"}' };
  expect(agentMessageSender({ kind: "user", text: formatThreadMessage(notice, notice.text) })).toBe(sender);
  expect(agentMessageSender({ kind: "user", text: text + "\n\n![Context image](/v1/sessions/example/image)" })).toBe(sender);
});

test("does not collapse ordinary human messages, user-facing replies, quotations or malformed envelopes", () => {
  for (const human of ["Hello", "Please explain <agent_message>", "```\n" + text + "\n```", "> " + text, text.replace(sender, "not-a-thread"), text.replace('"source":"explicit"', '"source":"unknown"'), text.replace("</agent_message>", ""), text.replace('"senderThreadId"', '"sender"'), text.replace('{"senderThreadId"', '{oops"senderThreadId"')]) {
    expect(agentMessageSender({ kind: "user", text: human })).toBeNull();
  }
  expect(agentMessageSender({ kind: "assistant", text })).toBeNull();
  expect(agentMessageSender({ kind: "thinking", text })).toBeNull();
});

test("agent disclosure is initially closed with a native accessible summary and keeps its children", () => {
  const html = renderToStaticMarkup(<AgentMessage senderThreadId={sender}><p>unchanged full content</p></AgentMessage>);
  expect(html).toContain('<details class="conversation-step text-step agent-message-step">');
  expect(html).toContain("<summary>");
  expect(html).toContain("Agent message");
  expect(html).toContain("From thread 7c925d87");
  expect(html).toContain(`title="${sender}"`);
  expect(html).toContain("unchanged full content");
  expect(html).not.toContain("open=");
});

test("historical and incoming heads use the same rendering without changing sender, content, order or ordinary messages", () => {
  const context = { messages: [
    { role: "user", timestamp: 1, content: "Human message" },
    { role: "user", timestamp: 2, content: text },
    { role: "assistant", timestamp: 3, content: "Kenan user-facing reply" },
  ] };
  const heads = deriveTranscriptItems(context).map(item => item.head);
  const entries = entriesFromHeads(heads);
  const before = JSON.stringify(entries);
  const render = (autoCollapse: boolean) => renderToStaticMarkup(<Transcript entries={entries} sessionId={recipient} home="/" images={null} autoCollapse={autoCollapse} onEdit={() => {}} onReply={() => {}} />);
  for (const autoCollapse of [true, false]) {
    const html = render(autoCollapse);
    expect(html.match(/agent-message-step/g)).toHaveLength(1);
    // Markdown populates its DOM in a layout effect, not during SSR.
    expect(html).toContain('class="message user"');
    expect(html).toContain('class="message assistant"');
    expect(html).toContain(sender);
    expect(html.indexOf('data-transcript-seq="1"')).toBeLessThan(html.indexOf("Agent message"));
    expect(html.indexOf("Agent message")).toBeLessThan(html.indexOf('data-transcript-seq="3"'));
  }
  expect(JSON.stringify(entries)).toBe(before);
  expect(entries.filter(entry => entry.kind === "user")[1]?.text).toBe(text);
});
