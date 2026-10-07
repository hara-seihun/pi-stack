import { expect, it } from "vitest";
import { agentMessagePresentation, formatThreadMessage } from "../src/threads/message-format.js";
import type { ThreadMessage } from "../src/threads/contracts.js";

const senderId = "7c925d87-bc2b-4293-933a-f9ffee9b3592";
const message: ThreadMessage = {
  id: "parent:assignment", threadId: "303efcde-ee6c-43f5-b3ed-522aa9f34ca4", senderId,
  senderName: "Kelana", text: "Do the work.", delivery: "steer", source: "explicit", createdAt: 1, state: "queued",
};

it("owner-stamped names travel in the native authenticated boundary, separate from the message words", () => {
  const text = formatThreadMessage(message, message.text);
  expect(text).toContain("This is an agent-to-agent message, not a user message.");
  expect(JSON.parse(text.split("\n")[2])).toEqual({ senderThreadId: senderId, senderName: "Kelana", recipientThreadId: message.threadId, messageId: message.id, source: "explicit" });
  expect(agentMessagePresentation(text)).toEqual({ sender: { threadId: senderId, name: "Kelana" }, text: message.text });
  expect(message.text).toBe("Do the work.");
  const human = { ...message, senderId: null, senderName: undefined };
  expect(formatThreadMessage(human, human.text)).toBe(human.text);
});

it("completion transport includes the name while human projection retains the final text and appended context", () => {
  const notice = { ...message, source: "notification" as const, text: JSON.stringify({ type: "thread_idle", outcome: "complete", finalMessage: { content: [{ type: "text", text: "Result." }] } }) };
  const native = formatThreadMessage(notice, notice.text + "\nMeeting context");
  expect(native).toContain('"senderName":"Kelana"');
  expect(native).toContain('"type":"thread_idle"');
  expect(agentMessagePresentation(native)).toEqual({ sender: { threadId: senderId, name: "Kelana" }, text: "Result.\nMeeting context" });
  const empty = { ...notice, text: '{"type":"thread_idle","outcome":"cancelled","finalText":null}' };
  expect(agentMessagePresentation(formatThreadMessage(empty, empty.text))?.text).toBe("Work cancelled.");
});

it("recognizes historical completion envelopes without inventing a name", () => {
  const historical = { ...message, source: "notification" as const, senderName: undefined, text: '{"type":"thread_idle","outcome":"complete","finalText":"Done."}' };
  expect(agentMessagePresentation(formatThreadMessage(historical, historical.text))).toEqual({ sender: { threadId: senderId }, text: "Done." });
});
