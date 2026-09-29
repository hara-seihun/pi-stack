import { useState } from "react";
import { API } from "../../server/api";
import type { MessagingMessage } from "../../server/messaging/protocol";
import { extractMessageLinks } from "../../server/messaging/links";
import { AttachmentImage, AttachmentPlayback, attachmentKind, type ChatAttachment } from "./chat-message";
import { CachedImage } from "./cached-media";
import { MessageLinkPreviews } from "./link-previews";
import { copyText, useMessageMenu } from "./message-menu";
import { MessageReactions } from "./message-reactions";
import { ReplyQuote, replyTarget, type ReplyTarget } from "./message-reply";
import { messagingAvatarUrl } from "./messaging-avatar";
import { chatRows } from "./messaging-state";
import { resourceUrl } from "./resource-url";
import "./messaging-chat.css";

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "6:15 p.m." today, "Yesterday 6:15 p.m.", "Monday 6:15 p.m." this week, then a date. */
export function chatTimeLabel(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp), today = new Date(now);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((dayStart(today) - dayStart(date)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  const year = date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const };
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...year })}, ${time}`;
}

/** One to three emoji and nothing else reads as a picture, not a sentence. */
export function emojiOnly(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && value.length <= 24 && !/[0-9#*]/.test(value)
    && /^(?:\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]|\u200D\p{Extended_Pictographic})*\s*){1,3}$/u.test(value);
}

function attachments(message: MessagingMessage): ChatAttachment[] {
  return message.attachments.map(attachment => ({
    id: attachment.id,
    name: attachment.name,
    url: resourceUrl(API.messagingAttachment.path({ attachmentId: attachment.id })),
    size: attachment.size,
    kind: attachmentKind(attachment.mimeType),
  }));
}

export interface MessagingChatProps {
  messages: MessagingMessage[];
  backendId: string;
  group: boolean;
  checking?: readonly string[];
  now?: number;
  onReply?(message: MessagingMessage, target: ReplyTarget): void;
  onCheck?(message: MessagingMessage): void;
  onRetry?(message: MessagingMessage): void;
}

/**
 * A human conversation. Your messages sit on the right in a quiet bubble;
 * everyone else's are plain text on the left, named only in groups and only
 * when the speaker changes. Time appears where the conversation paused.
 *
 * Rows are emitted newest first so the newest messages are first in the DOM;
 * the column-reverse container restores reading order.
 */
export function MessagingChat({ messages, backendId, group, checking = [], now = Date.now(), onReply, onCheck, onRetry }: MessagingChatProps) {
  return <div className="chat">
    {chatRows(messages).reverse().map(row => row.kind === "time"
      ? <p key={row.key} className="chat-time"><time dateTime={new Date(row.timestamp).toISOString()}>{chatTimeLabel(row.timestamp, now)}</time></p>
      : <ChatLine key={row.key} message={row.message} head={row.head} tail={row.tail} backendId={backendId} group={group}
        checking={checking.includes(row.message.id)}
        onReply={onReply && (target => onReply(row.message, target))}
        onCheck={onCheck && (() => onCheck(row.message))}
        onRetry={onRetry && (() => onRetry(row.message))} />)}
  </div>;
}

function ChatLine({ message, head, tail, backendId, group, checking, onReply, onCheck, onRetry }: {
  message: MessagingMessage;
  head: boolean;
  tail: boolean;
  backendId: string;
  group: boolean;
  checking: boolean;
  onReply?(target: ReplyTarget): void;
  onCheck?(): void;
  onRetry?(): void;
}) {
  const own = message.direction === "outgoing";
  const { identity, text, reply } = message;
  const [reacting, setReacting] = useState(false);
  const { menu, handlers } = useMessageMenu([
    ...(text ? [{ label: "Copy", onSelect: () => copyText(text) }] : []),
    ...(identity && onReply ? [{ label: "Reply", onSelect: () => onReply(replyTarget(identity, text)) }] : []),
    ...(identity ? [{ label: "React", onSelect: () => setReacting(true) }] : []),
  ]);
  const files = attachments(message);
  const preview = (message.status === "received" || message.status === "sent") && extractMessageLinks(text, 1).length > 0;
  const emoji = !reply && emojiOnly(text);
  const avatar = own ? undefined : messagingAvatarUrl(backendId, message.sender, message.senderAvatar);
  const failed = own && (message.status === "failed" || message.status === "unknown");
  const classes = ["chat-line", own ? "own" : "theirs", head && "head", tail && "tail", message.status === "sending" && "pending", failed && "failed"].filter(Boolean).join(" ");
  return <div className={classes} data-message-id={identity?.id ?? message.id} tabIndex={identity ? 0 : undefined}
    title={new Date(message.timestamp).toLocaleString()} {...handlers}>
    {head && group && !own && <div className="chat-sender">
      {avatar && <CachedImage className="chat-sender-avatar" src={avatar} alt="" loading="lazy" decoding="async" />}
      <span>{message.senderName || message.sender}</span>
    </div>}
    {menu}
    {emoji ? <p className="chat-emoji">{text.trim()}</p>
      : (reply || text) && <div className="chat-body">
        {reply && <ReplyQuote reply={reply} />}
        {text && <p className="chat-text">{text}</p>}
      </div>}
    {preview && <MessageLinkPreviews key={message.id} messageId={message.id} />}
    {files.map(file => <div className="chat-attachment" key={file.id}>
      {file.kind === "image" ? <AttachmentImage src={file.url} alt={file.name} downloadQuery />
        : <>
          {(file.kind === "audio" || file.kind === "video") && <AttachmentPlayback attachment={file} />}
          <a className="chat-file" href={file.url} download={file.name}>{file.name} · {Math.ceil(file.size / 1024)} KB</a>
        </>}
    </div>)}
    {failed && <p className="chat-status" role="status">
      <span>{message.status === "failed" ? "Not sent" : "Delivery unknown"}{message.error ? ` · ${message.error}` : ""}</span>
      {message.status === "unknown" && message.requestId && onCheck && <button type="button" disabled={checking} onClick={onCheck}>Check send status</button>}
      {message.status === "failed" && message.requestId && onRetry && <button type="button" onClick={onRetry}>Use failed draft</button>}
    </p>}
    {identity && <MessageReactions identity={identity} reactions={message.reactions} open={reacting} onOpenChange={setReacting} />}
  </div>;
}
