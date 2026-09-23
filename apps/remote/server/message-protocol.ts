export interface MessageSender { id: string; name?: string }

export interface MessageIdentity {
  id: string;
  timestamp: number;
  sender: MessageSender;
}

/** A quote travels with a reply even when its original is not stored here. */
export interface MessageReply {
  messageId: string | null;
  sender: MessageSender;
  text: string;
  timestamp?: number;
}

export interface MessageReaction {
  emoji: string;
  sender: MessageSender;
  timestamp: number;
  own?: boolean;
}

export interface ReactionRequest {
  messageId: string;
  emoji: string;
  remove?: boolean;
  threadTs?: string;
}

export type MessageTarget =
  | { transport: "pi"; sessionId: string; messageId: string }
  | { transport: "messaging"; messageId: string }
  | { transport: "slack"; workspace: string; channel: string; messageId: string; threadTs?: string };

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
export function isReactionEmoji(value: string): boolean {
  return value.length <= 64 && [...graphemes.segment(value)].length === 1
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value);
}

export function messageReference(target: MessageTarget): string {
  const parts = target.transport === "pi" ? ["pi", target.sessionId, target.messageId]
    : target.transport === "messaging" ? ["messaging", target.messageId]
    : ["slack", target.workspace, target.channel, target.messageId];
  return parts.map(encodeURIComponent).join("/");
}

export function parseMessageReference(value: string): MessageTarget | null {
  let parts: string[];
  try { parts = value.split("/").map(decodeURIComponent); } catch { return null; }
  if (parts.some(part => !part || /[\u0000-\u001f]/.test(part))) return null;
  if (parts[0] === "pi" && parts.length === 3) return { transport: "pi", sessionId: parts[1]!, messageId: parts[2]! };
  if (parts[0] === "messaging" && parts.length === 2) return { transport: "messaging", messageId: parts[1]! };
  if (parts[0] === "slack" && parts.length === 4) return { transport: "slack", workspace: parts[1]!, channel: parts[2]!, messageId: parts[3]! };
  return null;
}
