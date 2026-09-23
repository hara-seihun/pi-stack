import type { MessagingAttachment, MessagingMessage, MessagingSend } from "../../server/messaging/protocol";

export interface HumanDraft {
  text: string;
  attachments: MessagingAttachment[];
}
export const emptyHumanDraft = (): HumanDraft => ({ text: "", attachments: [] });

export function beginHumanSend(draft: HumanDraft, conversationId: string, requestId: string, timestamp = Date.now()): { message: MessagingMessage; request: MessagingSend } {
  return {
    message: {
      id: requestId, requestId, conversationId, externalId: null,
      direction: "outgoing", sender: "You", text: draft.text,
      attachments: draft.attachments, timestamp, status: "sending", error: null,
    },
    request: { requestId, text: draft.text, attachmentIds: draft.attachments.map(attachment => attachment.id) },
  };
}

export function requestFromHumanMessage(message: MessagingMessage): MessagingSend | null {
  return message.requestId ? { requestId: message.requestId, text: message.text, attachmentIds: message.attachments.map(attachment => attachment.id) } : null;
}

export function unconfirmedHumanSend(messages: MessagingMessage[], attempted: MessagingMessage, error: string): MessagingMessage[] {
  // A history receipt may already have confirmed the message while HTTP failed.
  return messages.map(message => message === attempted ? { ...message, status: "unknown", error } : message);
}

export function mergeHumanMessages(current: MessagingMessage[], incoming: MessagingMessage[]): MessagingMessage[] {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = messages.get(message.id);
    if (previous && ["sent", "failed"].includes(previous.status) && ["sending", "unknown"].includes(message.status)) continue;
    messages.set(message.id, message);
  }
  return [...messages.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

/** A run of messages from one sender stays one block until this much quiet time passes. */
export const HUMAN_MESSAGE_GROUP_GAP_MS = 15 * 60_000;

/**
 * Contiguous messages from the same sender in the same direction read as one
 * block. A block ends when the sender changes or the gap since the previous
 * message exceeds `gap`, so a reply hours later still gets its own header.
 */
export function groupHumanMessages(messages: MessagingMessage[], gap = HUMAN_MESSAGE_GROUP_GAP_MS): MessagingMessage[][] {
  const groups: MessagingMessage[][] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group && previous && previous.direction === message.direction && previous.sender === message.sender && message.timestamp - previous.timestamp <= gap) group.push(message);
    else groups.push([message]);
  }
  return groups;
}

export function draftFromHumanMessage(message: MessagingMessage): HumanDraft {
  return {
    text: message.text,
    attachments: message.attachments,
  };
}
