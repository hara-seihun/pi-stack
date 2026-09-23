import { Database } from "bun:sqlite";
import { open } from "node:fs/promises";
import { isReactionEmoji, messageReference, parseMessageReference, type MessageIdentity, type MessageReaction, type MessageSender, type MessageTarget, type ReactionRequest } from "./message-protocol";
import type { MessagingResult } from "./messaging/protocol";

type PiTarget = Extract<MessageTarget, { transport: "pi" }>;
type SlackTarget = Extract<MessageTarget, { transport: "slack" }>;
interface ReactionRow { message_ref: string; emoji: string; sender_id: string; sender_name: string | null; timestamp: number }
const failure = (code: string, message: string): MessagingResult<never> => ({ ok: false, error: { code, message } });

export async function nativeMessageExists(path: string, entryId: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    for await (const line of file.readLines()) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.id === entryId) return (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"))
        || (entry.type === "custom_message" && Boolean(entry.details?.sender?.id || entry.details?.identity?.sender?.id));
    }
    return false;
  } finally { await file.close(); }
}

export class PiReactions {
  constructor(private readonly db: Database, private readonly owner: MessageSender) {
    db.exec(`CREATE TABLE IF NOT EXISTS message_reactions (
      session_id TEXT NOT NULL, message_ref TEXT NOT NULL, emoji TEXT NOT NULL,
      sender_id TEXT NOT NULL, sender_name TEXT, timestamp INTEGER NOT NULL,
      PRIMARY KEY(message_ref, emoji, sender_id));
      CREATE INDEX IF NOT EXISTS reactions_session ON message_reactions(session_id);`);
  }
  private reaction(row: ReactionRow): MessageReaction {
    return { emoji: row.emoji, sender: { id: row.sender_id, ...(row.sender_name ? { name: row.sender_name } : {}) }, timestamp: row.timestamp, own: row.sender_id === this.owner.id };
  }
  list(messageId: string): MessageReaction[] {
    return (this.db.query("SELECT * FROM message_reactions WHERE message_ref=? ORDER BY timestamp,sender_id,emoji").all(messageId) as ReactionRow[]).map(row => this.reaction(row));
  }
  session(sessionId: string): Map<string, MessageReaction[]> {
    const grouped = new Map<string, MessageReaction[]>();
    for (const row of this.db.query("SELECT * FROM message_reactions WHERE session_id=? ORDER BY timestamp,sender_id,emoji").all(sessionId) as ReactionRow[]) {
      const items = grouped.get(row.message_ref) ?? [];
      items.push(this.reaction(row));
      grouped.set(row.message_ref, items);
    }
    return grouped;
  }
  set(target: PiTarget, emoji: string, sender: MessageSender, remove: boolean): MessageReaction[] {
    const id = messageReference(target);
    if (remove) this.db.query("DELETE FROM message_reactions WHERE message_ref=? AND emoji=? AND sender_id=?").run(id, emoji, sender.id);
    else this.db.query("INSERT OR IGNORE INTO message_reactions(session_id,message_ref,emoji,sender_id,sender_name,timestamp) VALUES(?,?,?,?,?,?)")
      .run(target.sessionId, id, emoji, sender.id, sender.name ?? null, Date.now());
    return this.list(id);
  }
  project(sessionId: string, document: string): string {
    const context = JSON.parse(document);
    const reactions = this.session(sessionId);
    context.messages = (context.messages ?? []).map((message: { identity?: MessageIdentity }) => message.identity
      ? { ...message, reactions: reactions.get(message.identity.id) ?? [] } : message);
    return JSON.stringify(context);
  }
}

export interface ReactionTransports {
  pi(target: PiTarget, emoji: string, remove: boolean, sender: MessageSender): Promise<MessagingResult<MessageReaction[]>>;
  messaging(messageId: string, emoji: string, remove: boolean): Promise<MessagingResult<MessageReaction[]>>;
  slack(target: SlackTarget, emoji: string, remove: boolean): Promise<MessagingResult<MessageReaction[]>>;
}

export async function reactToMessage(input: unknown, sender: MessageSender, transports: ReactionTransports): Promise<MessagingResult<MessageReaction[]>> {
  if (!input || typeof input !== "object") return failure("invalid_request", "A message reference and emoji are required");
  const request = input as ReactionRequest;
  if (typeof request.messageId !== "string" || request.messageId.length > 1000 || typeof request.emoji !== "string"
    || (request.remove !== undefined && typeof request.remove !== "boolean")
    || (request.threadTs !== undefined && (typeof request.threadTs !== "string" || !/^\d+\.\d{1,6}$/.test(request.threadTs)))) {
    return failure("invalid_request", "Invalid reaction request");
  }
  const target = parseMessageReference(request.messageId);
  if (!target) return failure("invalid_reference", "Use the complete message ID supplied with the message");
  const emoji = request.emoji.normalize("NFC");
  const slackName = target.transport === "slack" && /^:?[a-z0-9_+\-]{1,100}:?$/.test(emoji);
  if (!isReactionEmoji(emoji) && !slackName) return failure("invalid_emoji", "Choose one emoji, or a Slack emoji name for a Slack message");
  try {
    if (target.transport === "pi") return await transports.pi(target, emoji, request.remove === true, sender);
    if (target.transport === "messaging") return await transports.messaging(target.messageId, emoji, request.remove === true);
    return await transports.slack({ ...target, ...(request.threadTs ? { threadTs: request.threadTs } : {}) }, emoji, request.remove === true);
  } catch (cause) {
    return failure("reaction_failed", cause instanceof Error ? cause.message : String(cause));
  }
}
