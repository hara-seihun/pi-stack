import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { API } from "../../server/api";
import type { MessagingMessage } from "../../server/messaging/protocol";
import { extractMessageLinks } from "../../server/messaging/links";
import type { ResponseMetrics } from "../../server/protocol";
import type { MessageIdentity, MessageReaction, MessageReply } from "../../server/message-protocol";
import { ReplyQuote, replyTarget, type ReplyTarget } from "./message-reply";
import { MessageReactions } from "./message-reactions";
import { AGENT_AVATAR } from "../../server/agent-identity";
import { appPath } from "./app-path";
import { messagingAvatarUrl } from "./messaging-avatar";
import { resourceUrl } from "./resource-url";
import { MessageLinkPreviews } from "./link-previews";
import { useNearViewport } from "./near-viewport";
import { formatResponseMetrics } from "./response-metrics";
import { copyText, useMessageMenu, type MessageMenuItem } from "./message-menu";
import { speech, speechTitle, useSpeech } from "./speech";
import "./chat-message.css";

const ClipboardIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2M9 5h6"/></svg>;

/** `text` may be a resolver so a lazy transcript body is loaded before copying. */
export function CopyButton({ text, label = "Copy message", className = "message-action" }: { text: string | (() => Promise<string>); label?: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const copy = async () => {
    clearTimeout(reset.current);
    try { await navigator.clipboard.writeText(typeof text === "function" ? await text() : text); setStatus("copied"); }
    catch { setStatus("failed"); }
    reset.current = setTimeout(() => setStatus("idle"), 1_200);
  };
  const description = status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label;
  return <button type="button" className={`${className}${status === "idle" ? "" : ` ${status}`}`} title={description} aria-label={description} onClick={copy}><ClipboardIcon /></button>;
}

export type ChatAttachmentKind = "image" | "audio" | "video" | "file";
export type ChatAttachment = { id: string; name: string; url: string; size: number; kind: ChatAttachmentKind };

/** How a message attachment of this MIME type appears: in place when every client can play or draw it. */
export function attachmentKind(mimeType: string): ChatAttachmentKind {
  const type = mimeType.toLowerCase().split(";", 1)[0].trim();
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(type)) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  return "file";
}
export type ChatDelivery = { status: string; error?: string | null; canCheck: boolean; canRetry: boolean };

/** One message's body: its text, files and delivery state. A block shows one or more of these under a single header. */
export type ChatMessageSegment = {
  id: string;
  text: string;
  timestamp?: number;
  previewMessageId?: string;
  identity?: MessageIdentity;
  reactions?: MessageReaction[];
  reply?: MessageReply;
  onReply?(target: ReplyTarget): void;
  attachments?: ChatAttachment[];
  delivery?: ChatDelivery;
  onCheck?(): void;
  onRetry?(): void;
};

/** Kenan's head, for the agent's own messages. */
export const agentAvatar = () => appPath(AGENT_AVATAR);

export type ChatMessageProps = {
  kind: string;
  label: string;
  /** Picture shown before the label: the sender's, or Kenan's head. */
  avatar?: string;
  text: string;
  timestamp?: number;
  responseMetrics?: ResponseMetrics;
  previewMessageId?: string;
  identity?: MessageIdentity;
  reactions?: MessageReaction[];
  reply?: MessageReply;
  onReply?(target: ReplyTarget): void;
  /** Extra long-press / right-click actions after Copy. */
  menu?: MessageMenuItem[];
  attachments?: ChatAttachment[];
  delivery?: ChatDelivery;
  checking?: boolean;
  onCheck?(): void;
  onRetry?(): void;
  onEditImage?(image: HTMLImageElement): void;
} & ({ contentFormat: "literal"; renderMarkdown?: never } | { contentFormat: "markdown"; renderMarkdown(text: string): ReactNode });

function MessageFrame({ kind, label, avatar, text, timestamp, menu = [], identity, onReply, onReact, children }: {
  kind: string;
  label: string;
  avatar?: string;
  text: string;
  timestamp?: number;
  menu?: MessageMenuItem[];
  identity?: MessageIdentity;
  onReply?(target: ReplyTarget): void;
  onReact?(): void;
  children: ReactNode;
}) {
  const time = timestamp === undefined ? undefined : new Date(timestamp);
  const reader = useSpeech().catalog !== null;
  const { menu: openMenu, handlers } = useMessageMenu([
    { label: "Copy", onSelect: () => copyText(text) },
    ...(reader && text.trim() ? [{ label: "Speak", onSelect: () => speech.speak(text, speechTitle(text)) }] : []),
    ...(identity && onReply ? [{ label: "Reply", onSelect: () => onReply(replyTarget(identity, text)) }] : []),
    ...(onReact ? [{ label: "React", onSelect: onReact }] : []),
    ...menu,
  ]);
  return <article className={`message ${kind}`} data-message-id={identity?.id} tabIndex={identity ? 0 : undefined} {...handlers}>
    <header className="message-header">
      {avatar && <img className="message-avatar" src={avatar} alt="" loading="lazy" decoding="async" />}
      <span className="message-label">{label.toUpperCase()}</span>
      {time && <time className="message-time" dateTime={time.toISOString()}>{time.toLocaleString()}</time>}
    </header>
    {openMenu}
    {children}
  </article>;
}

function MessageBody({ attachments = [], delivery, checking = false, onCheck, onRetry, onEditImage, children }: {
  attachments?: ChatAttachment[];
  delivery?: ChatDelivery;
  checking?: boolean;
  onCheck?(): void;
  onRetry?(): void;
  onEditImage?(image: HTMLImageElement): void;
  children?: ReactNode;
}) {
  return <>
    {children}
    {attachments.map(attachment => <div className="message-attachment" key={attachment.id}>
      {attachment.kind === "image" ? <AttachmentImage src={attachment.url} alt={attachment.name} downloadQuery onEditImage={onEditImage} />
        : <>
          {(attachment.kind === "audio" || attachment.kind === "video") && <AttachmentPlayback attachment={attachment} />}
          <a href={attachment.url} download={attachment.name}>{attachment.name} · {Math.ceil(attachment.size / 1024)} KB</a>
        </>}
    </div>)}
    {delivery && <footer className={`message-status ${delivery.status}`}>{delivery.status}{delivery.error ? ` · ${delivery.error}` : ""}</footer>}
    {delivery?.canCheck && onCheck && <button type="button" className="message-delivery-action" disabled={checking} onClick={onCheck}>Check send status</button>}
    {delivery?.canRetry && onRetry && <button type="button" className="message-delivery-action" disabled={checking} onClick={onRetry}>Use failed draft</button>}
  </>;
}

export function ChatMessage(props: ChatMessageProps) {
  const { kind, label, avatar, text, timestamp, responseMetrics, menu, attachments, delivery, checking, onCheck, onRetry, onEditImage, identity, reactions, reply, onReply } = props;
  const [reactionsOpen, setReactionsOpen] = useState(false);
  return <MessageFrame kind={kind} label={label} avatar={avatar} text={text} timestamp={timestamp} menu={menu} identity={identity} onReply={onReply} onReact={identity ? () => setReactionsOpen(true) : undefined}>
    <MessageBody attachments={attachments} delivery={delivery} checking={checking} onCheck={onCheck} onRetry={onRetry} onEditImage={onEditImage}>
      {reply && <ReplyQuote reply={reply} />}
      {props.contentFormat === "markdown" ? props.renderMarkdown(text) : text && <div className="message-text">{text}</div>}
      {props.previewMessageId && <MessageLinkPreviews key={props.previewMessageId} messageId={props.previewMessageId} />}
      {responseMetrics && <footer className="message-metrics">{formatResponseMetrics(responseMetrics)}</footer>}
    </MessageBody>
    {identity && <MessageReactions identity={identity} reactions={reactions} open={reactionsOpen} onOpenChange={setReactionsOpen} />}
  </MessageFrame>;
}

/**
 * Several literal messages from one sender under one header, each in its own
 * paragraph. The header carries the first message's time; each paragraph
 * carries its own on hover. "sent" footers only show on the last segment so a
 * run of delivered messages does not repeat itself; anything unresolved or
 * failed stays visible on the segment it belongs to.
 */
export function ChatMessageGroup({ kind, label, avatar, segments, checking = false, menu, onEditImage, newestFirstDom = false }: {
  kind: string;
  label: string;
  avatar?: string;
  segments: ChatMessageSegment[];
  checking?: boolean;
  menu?: MessageMenuItem[];
  onEditImage?(image: HTMLImageElement): void;
  newestFirstDom?: boolean;
}) {
  const text = segments.map(segment => segment.text).filter(Boolean).join("\n\n");
  return <MessageFrame kind={kind} label={label} avatar={avatar} text={text} timestamp={segments[0]?.timestamp} menu={menu}>
    <div className={newestFirstDom ? "message-segments newest-first-dom" : "message-segments"}>
    {(newestFirstDom ? segments.map((segment, index) => ({ segment, index })).reverse() : segments.map((segment, index) => ({ segment, index }))).map(({ segment, index }) => {
      const last = index === segments.length - 1;
      const delivery = segment.delivery && (last || segment.delivery.status !== "sent") ? segment.delivery : undefined;
      const time = segment.timestamp === undefined ? undefined : new Date(segment.timestamp);
      return <GroupSegment key={segment.id} segment={segment} label={label} time={time} delivery={delivery} checking={checking} onEditImage={onEditImage} />;
    })}
    </div>
  </MessageFrame>;
}

function GroupSegment({ segment, label, time, delivery, checking, onEditImage }: {
  segment: ChatMessageSegment;
  label: string;
  time?: Date;
  delivery?: ChatDelivery;
  checking: boolean;
  onEditImage?(image: HTMLImageElement): void;
}) {
  const { identity, onReply } = segment;
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const { menu, handlers } = useMessageMenu([
    { label: "Copy", onSelect: () => copyText(segment.text) },
    ...(identity && onReply ? [{ label: "Reply", onSelect: () => onReply(replyTarget(identity, segment.text)) }] : []),
    ...(identity ? [{ label: "React", onSelect: () => setReactionsOpen(true) }] : []),
  ]);
  return <div className="message-segment" data-message-id={identity?.id ?? segment.id} tabIndex={identity ? 0 : undefined} title={time?.toLocaleString()}
    {...handlers} onContextMenu={event => { event.stopPropagation(); handlers.onContextMenu?.(event); }}
    onPointerDown={event => { event.stopPropagation(); handlers.onPointerDown?.(event); }}
    onPointerMove={event => { event.stopPropagation(); handlers.onPointerMove?.(event); }}
    onPointerUp={event => { event.stopPropagation(); handlers.onPointerUp?.(); }}
    onPointerCancel={event => { event.stopPropagation(); handlers.onPointerCancel?.(); }}>
    {menu}
    <MessageBody attachments={segment.attachments} delivery={delivery} checking={checking} onCheck={segment.onCheck} onRetry={segment.onRetry} onEditImage={onEditImage}>
      {segment.reply && <ReplyQuote reply={segment.reply} />}
      {segment.text && <p className="message-text">{segment.text}</p>}
      {segment.previewMessageId && <MessageLinkPreviews key={segment.previewMessageId} messageId={segment.previewMessageId} />}
    </MessageBody>
    {identity && <MessageReactions identity={identity} reactions={segment.reactions} open={reactionsOpen} onOpenChange={setReactionsOpen} />}
  </div>;
}

/** One Signal message as a segment of a sender's block; check/retry handlers are wired by the caller. */
export function messagingMessageSegment(message: MessagingMessage, handlers: { onCheck?(): void; onRetry?(): void; onReply?(target: ReplyTarget): void } = {}): ChatMessageSegment {
  const { text, timestamp, attachments, delivery, previewMessageId, identity, reactions, reply } = messagingMessageProps(message);
  return { id: message.id, text, timestamp, attachments, delivery, previewMessageId, identity, reactions, reply, ...handlers };
}

export function messagingMessageProps(message: MessagingMessage, backendId = ""): ChatMessageProps {
  const outgoing = message.direction === "outgoing";
  return {
    kind: outgoing ? "user" : "assistant",
    label: outgoing ? "You" : message.senderName || message.sender,
    avatar: outgoing ? undefined : messagingAvatarUrl(backendId, message.sender, message.senderAvatar),
    text: message.text,
    previewMessageId: (message.status === "received" || message.status === "sent") && extractMessageLinks(message.text, 1).length > 0 ? message.id : undefined,
    contentFormat: "literal",
    timestamp: message.timestamp,
    identity: message.identity,
    reactions: message.reactions,
    reply: message.reply,
    attachments: message.attachments.map(attachment => ({
      id: attachment.id,
      name: attachment.name,
      url: resourceUrl(API.messagingAttachment.path({ attachmentId: attachment.id })),
      size: attachment.size,
      kind: attachmentKind(attachment.mimeType),
    })),
    delivery: outgoing ? {
      status: message.status,
      error: message.error,
      // `sending` is the supervisor at work; a supervisor that stops mid-send records `unknown`, and only that needs a check.
      canCheck: !!message.requestId && message.status === "unknown",
      canRetry: !!message.requestId && message.status === "failed",
    } : undefined,
  };
}

function AttachmentPlayback({ attachment }: { attachment: ChatAttachment }) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const src = attempt ? `${attachment.url}${attachment.url.includes("?") ? "&" : "?"}retry=${attempt}` : attachment.url;
  return <div className={`attachment-playback ${attachment.kind}`} ref={ref}>
    {(!near || attachment.kind === "video" && !ready && !error) && <div className="attachment-placeholder" aria-hidden="true" />}
    {near && !error && (attachment.kind === "audio"
      ? <audio className="message-attachment-media" controls preload="none" src={src} aria-label={attachment.name} onError={() => setError(true)} />
      : <video className="message-attachment-media" controls preload="metadata" playsInline src={src} aria-label={attachment.name} onLoadedMetadata={() => setReady(true)} onError={() => setError(true)} />)}
    {error && <div className="attachment-error" role="alert">Could not load {attachment.kind}. <button type="button" onClick={() => { setError(false); setReady(false); setAttempt(value => value + 1); }}>Retry</button></div>}
  </div>;
}

export function AttachmentImage({ src, alt, className = "context-image", downloadQuery = false, onEditImage }: {
  src: string;
  alt: string;
  className?: string;
  downloadQuery?: boolean;
  onEditImage?(image: HTMLImageElement): void;
}) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setState("loading"); setAttempt(0); }, [src]);
  const imageSrc = near ? (attempt ? `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}` : src) : undefined;
  const edit = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!onEditImage || state !== "ready") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    onEditImage(event.currentTarget);
  };
  return <div className="attachment-image-frame" ref={ref}>
    {state === "loading" && <div className="attachment-placeholder" aria-hidden="true" />}
    {state === "error" && <div className="attachment-error" role="alert">Could not load image. <button type="button" onClick={() => { setState("loading"); setAttempt(value => value + 1); }}>Retry</button></div>}
    {imageSrc && state !== "error" && <img className={className} src={imageSrc} alt={alt} crossOrigin="anonymous" data-download-query={downloadQuery || undefined} loading="lazy" decoding="async" role="button" tabIndex={0} aria-label={`Draw on ${alt || "image"}`} onLoad={() => setState("ready")} onError={() => setState("error")} onClick={edit} onKeyDown={event => {
      if (event.key === "Enter" || event.key === " ") edit(event);
    }} />}
  </div>;
}
