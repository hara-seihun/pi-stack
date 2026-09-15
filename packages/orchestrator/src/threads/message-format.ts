import type { ThreadMessage } from "./contracts.js";

export function formatThreadMessage(message: ThreadMessage, text: string): string {
  if (!message.senderId && message.source !== "notification") return text;
  const metadata = {
    senderThreadId: message.senderId,
    recipientThreadId: message.threadId,
    messageId: message.id,
    source: message.source,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  return `<agent_message>\nThis is an agent-to-agent message, not a user message.\n${JSON.stringify(metadata)}\n\n${text}\n</agent_message>`;
}
