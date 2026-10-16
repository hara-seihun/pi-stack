import { expect, it } from "vitest";
import { agentMessagePresentation, agentSenderLabel, finalText, formatThreadMessage, serializeThreadNotification } from "../src/threads/message-format.js";
import type { ThreadMessage } from "../src/threads/contracts.js";

const senderId = "7c925d87-bc2b-4293-933a-f9ffee9b3592";
const message: ThreadMessage = {
  id: "parent:assignment", threadId: "303efcde-ee6c-43f5-b3ed-522aa9f34ca4", senderId,
  priority: "normal", senderName: "Kelana", text: "Do the work.", delivery: "steer", source: "explicit", createdAt: 1, state: "queued",
};

it("completion notifications retain only signed narration, never genuine thinking or signatures", () => {
  const field = (number: number, bytes: Buffer): Buffer => Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
  const signature = (channel: string) => field(2, field(1, field(8, Buffer.from(channel)))).toString("base64");
  const finalMessage = { role: "assistant", api: "anthropic-messages", content: [
    { type: "thinking", thinking: "Public result", thinkingSignature: signature("narration") },
    { type: "thinking", thinking: "Private reasoning", thinkingSignature: signature("thinking") },
  ] };
  const before = structuredClone(finalMessage);
  expect(finalText(finalMessage)).toBe("Public result");
  const notice = serializeThreadNotification({ outcome: "complete", finalMessage });
  expect(JSON.parse(notice)).toEqual({ type: "thread_idle", outcome: "complete", finalText: "Public result" });
  expect(notice).not.toMatch(/Private reasoning|Signature/);
  expect(finalMessage).toEqual(before);
});

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
  expect(JSON.parse(native.split("\n")[2]!)).toEqual({ senderThreadId: senderId, senderName: "Kelana",
    recipientThreadId: message.threadId, messageId: message.id, source: "notification" });
  expect(agentMessagePresentation(native)).toEqual({ sender: { threadId: senderId, name: "Kelana" }, text: "Result.\nMeeting context" });
  const empty = { ...notice, text: '{"type":"thread_idle","outcome":"cancelled","finalText":null}' };
  expect(agentMessagePresentation(formatThreadMessage(empty, empty.text))?.text).toBe("Work cancelled.");
});

it.each([
  ["schedule:digest:100000", "schedule:followup:100001"],
  ["root:notification", "home"],
])("native identifiers %s and %s retain named sends and completion presentation", (senderId, threadId) => {
  const scheduled = { ...message, senderId, threadId };
  const native = formatThreadMessage(scheduled, scheduled.text);
  expect(agentMessagePresentation(native)).toEqual({ sender: { threadId: senderId, name: "Kelana" }, text: scheduled.text });
  const notice = { ...scheduled, source: "notification" as const, text: '{"type":"thread_idle","outcome":"complete","finalText":"Done."}' };
  expect(agentMessagePresentation(formatThreadMessage(notice, notice.text))).toEqual({ sender: { threadId: senderId, name: "Kelana" }, text: "Done." });
  for (const invalid of [native.replace(`"senderThreadId":"${senderId}"`, '"senderThreadId":" "'), native.replace(`"recipientThreadId":"${threadId}"`, '"recipientThreadId":""'), native.replace('"source":"explicit"', '"source":"unknown"')]) {
    expect(agentMessagePresentation(invalid)).toBeNull();
  }
});

it("recognizes historical completion envelopes without inventing a name", () => {
  const historical = `<agent_message>\nThis is an agent-to-agent message, not a user message.\n${JSON.stringify({ senderThreadId: senderId })}\n\n{"type":"thread_idle","outcome":"complete","finalText":"Done."}\n</agent_message>`;
  expect(agentMessagePresentation(historical)).toEqual({ sender: { threadId: senderId }, text: "Done." });
});

it("retains scheduled wake identity in native notifications without rewriting their words", () => {
  const wake = { ...message, id: "thread-wake:generation:1000", source: "notification" as const,
    text: "Scheduled wake check for this existing thread: keep watch." };
  const native = formatThreadMessage(wake, wake.text);
  expect(JSON.parse(native.split("\n")[2]!)).toMatchObject({ messageId: wake.id, source: "notification" });
  expect(agentMessagePresentation(native)).toEqual({ sender: { threadId: senderId, name: "Kelana" }, text: wake.text });
});

it("labels senders by first name, including threads named before single names", () => {
  expect(agentSenderLabel({ threadId: senderId, name: "Tainetaimu Sizhukein" })).toBe("Tainetaimu");
  expect(agentSenderLabel({ threadId: senderId, name: "Kelana" })).toBe("Kelana");
  expect(agentSenderLabel({ threadId: senderId })).toBe("Agent · 7c925d87");
});
