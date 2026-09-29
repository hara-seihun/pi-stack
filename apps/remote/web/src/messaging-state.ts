import type { MessagingAttachment, MessagingMessage, MessagingSend } from "../../server/messaging/protocol";
import type { ReplyTarget } from "./message-reply";

export interface HumanDraft {
  text: string;
  attachments: MessagingAttachment[];
  reply?: ReplyTarget;
}
export const emptyHumanDraft = (): HumanDraft => ({ text: "", attachments: [] });

export function beginHumanSend(draft: HumanDraft, conversationId: string, requestId: string, timestamp = Date.now()): { message: MessagingMessage; request: MessagingSend } {
  return {
    message: {
      id: requestId, requestId, conversationId, externalId: null,
      direction: "outgoing", sender: "You", text: draft.text,
      attachments: draft.attachments, timestamp, status: "sending", error: null,
      reply: draft.reply ? { messageId: draft.reply.identity.id, sender: draft.reply.identity.sender, text: draft.reply.text, timestamp: draft.reply.identity.timestamp } : undefined,
    },
    request: { requestId, text: draft.text, attachmentIds: draft.attachments.map(attachment => attachment.id), ...(draft.reply ? { replyTo: draft.reply.identity.id } : {}) },
  };
}

export function requestFromHumanMessage(message: MessagingMessage): MessagingSend | null {
  return message.requestId ? { requestId: message.requestId, text: message.text, attachmentIds: message.attachments.map(attachment => attachment.id), ...(message.reply?.messageId ? { replyTo: message.reply.messageId } : {}) } : null;
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

/** A pause this long, or a new day, earns a time marker. */
export const CHAT_TIME_GAP_MS = 60 * 60_000;

export type ChatRow =
  | { kind: "time"; key: string; timestamp: number }
  | { kind: "message"; key: string; message: MessagingMessage; head: boolean; tail: boolean };

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * The chat as it reads: time markers where the conversation paused, and
 * messages that know whether they open (`head`) or close (`tail`) a run from
 * one sender. A marker always starts a fresh run.
 */
export function chatRows(messages: MessagingMessage[], gap = CHAT_TIME_GAP_MS): ChatRow[] {
  const rows: ChatRow[] = [];
  let previous: MessagingMessage | undefined;
  let run: Extract<ChatRow, { kind: "message" }> | undefined;
  for (const message of messages) {
    const marked = !previous || message.timestamp - previous.timestamp > gap || !sameDay(previous.timestamp, message.timestamp);
    if (marked) rows.push({ kind: "time", key: `time:${message.id}`, timestamp: message.timestamp });
    // Own messages may be recorded as "You" or as the account number; both are one voice.
    const head = marked || previous!.direction !== message.direction || message.direction === "incoming" && previous!.sender !== message.sender;
    if (head && run) run.tail = true;
    run = { kind: "message", key: message.id, message, head, tail: false };
    rows.push(run);
    previous = message;
  }
  if (run) run.tail = true;
  return rows;
}

export function draftFromHumanMessage(message: MessagingMessage): HumanDraft {
  return {
    text: message.text,
    attachments: message.attachments,
    ...(message.reply?.messageId ? { reply: { identity: { id: message.reply.messageId, sender: message.reply.sender, timestamp: message.reply.timestamp ?? message.timestamp }, text: message.reply.text } } : {}),
  };
}
