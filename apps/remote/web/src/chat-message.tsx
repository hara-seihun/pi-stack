import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { ResponseMetrics } from "../../server/protocol";
import type { MessageIdentity, MessageReaction, MessageReply } from "../../server/message-protocol";
import { ReplyQuote, replyTarget, type ReplyTarget } from "./message-reply";
import { MessageReactions } from "./message-reactions";
import { AGENT_AVATAR } from "../../server/agent-identity";
import { appPath } from "./app-path";
import { CachedImage, useCachedMedia } from "./cached-media";
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
export type ChatDelivery = { status: string; error?: string | null };

/** Kenan's head, for the agent's own messages. */
export const agentAvatar = () => appPath(AGENT_AVATAR);

export type ChatMessageProps = {
  kind: string;
  label: string;
  appearance?: "bubble";
  /** Shown instead of the label when the sender needs more than a name, such as an agent-to-agent route. */
  heading?: ReactNode;
  /** Picture shown before the label: the sender's, or Kenan's head. */
  avatar?: string;
  text: string;
  /** Resolves native text before copying when the visible words are only a preview. */
  resolveCopyText?(): Promise<string>;
  timestamp?: number;
  responseMetrics?: ResponseMetrics;
  identity?: MessageIdentity;
  reactions?: MessageReaction[];
  reply?: MessageReply;
  onReply?(target: ReplyTarget): void;
  /** Extra long-press / right-click actions after Copy. */
  menu?: MessageMenuItem[];
  attachments?: ChatAttachment[];
  delivery?: ChatDelivery;
  onEditImage?(image: HTMLImageElement): void;
} & ({ contentFormat: "literal"; renderMarkdown?: never } | { contentFormat: "markdown"; renderMarkdown(text: string): ReactNode });

function MessageFrame({ kind, label, appearance, heading, avatar, text, resolveCopyText, timestamp, menu = [], identity, onReply, onReact, children }: {
  kind: string;
  label: string;
  appearance?: "bubble";
  heading?: ReactNode;
  avatar?: string;
  text: string;
  resolveCopyText?(): Promise<string>;
  timestamp?: number;
  menu?: MessageMenuItem[];
  identity?: MessageIdentity;
  onReply?(target: ReplyTarget): void;
  onReact?(): void;
  children: ReactNode;
}) {
  const time = timestamp === undefined ? undefined : new Date(timestamp);
  const reader = useSpeech().catalog !== null;
  const [copyError, setCopyError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const copy = async () => {
    try {
      const copied = await copyText(resolveCopyText ? await resolveCopyText() : text);
      setCopyError(copied ? null : "Copy failed.");
    } catch (cause) { setCopyError(cause instanceof Error ? cause.message : "The full message could not be copied."); }
  };
  const { menu: openMenu, handlers } = useMessageMenu([
    { label: "Copy", onSelect: copy },
    ...(reader && text.trim() ? [{ label: "Speak", onSelect: async () => {
      try { const full = resolveCopyText ? await resolveCopyText() : text; speech.speak(full, speechTitle(full)); setCopyError(null); }
      catch (cause) { setCopyError(cause instanceof Error ? cause.message : "The full message could not be loaded."); }
    } }] : []),
    ...(identity && onReply ? [{ label: "Reply", onSelect: async () => {
      try { onReply(replyTarget(identity, resolveCopyText ? await resolveCopyText() : text)); setCopyError(null); }
      catch (cause) { setCopyError(cause instanceof Error ? cause.message : "The full message could not be loaded."); }
    } }] : []),
    ...(onReact ? [{ label: "React", onSelect: onReact }] : []),
    ...(appearance === "bubble" && time ? [{ label: "Message time", onSelect: () => setDetailsOpen(value => !value) }] : []),
    ...menu,
  ]);
  return <article className={`message ${kind}${appearance === "bubble" ? " chat-bubble" : ""}`} aria-label={appearance === "bubble" ? `Message from ${label}` : undefined} data-message-id={identity?.id} tabIndex={identity ? 0 : undefined} {...handlers}>
    {appearance !== "bubble" && <header className="message-header">
      {avatar && <CachedImage className="message-avatar" src={avatar} alt="" loading="lazy" decoding="async" />}
      {heading ?? <span className="message-label">{label.toUpperCase()}</span>}
      {time && <time className="message-time" dateTime={time.toISOString()}>{time.toLocaleString()}</time>}
    </header>}
    {openMenu}
    {children}
    {detailsOpen && time && <time className="chat-message-detail-time" dateTime={time.toISOString()}>{time.toLocaleString()}</time>}
    {copyError && <p className="message-status failed" role="status">{copyError}</p>}
  </article>;
}

function MessageBody({ attachments = [], delivery, onEditImage, children }: {
  attachments?: ChatAttachment[];
  delivery?: ChatDelivery;
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
  </>;
}

export function ChatMessage(props: ChatMessageProps) {
  const { kind, label, appearance, heading, avatar, text, resolveCopyText, timestamp, responseMetrics, menu, attachments, delivery, onEditImage, identity, reactions, reply, onReply } = props;
  const [reactionsOpen, setReactionsOpen] = useState(false);
  return <MessageFrame kind={kind} label={label} appearance={appearance} heading={heading} avatar={avatar} text={text} resolveCopyText={resolveCopyText} timestamp={timestamp} menu={menu} identity={identity} onReply={onReply} onReact={identity ? () => setReactionsOpen(true) : undefined}>
    <MessageBody attachments={attachments} delivery={delivery} onEditImage={onEditImage}>
      {reply && <ReplyQuote reply={reply} />}
      {props.contentFormat === "markdown" ? props.renderMarkdown(text) : text && <div className="message-text">{text}</div>}
      {responseMetrics && <footer className="message-metrics">{formatResponseMetrics(responseMetrics)}</footer>}
    </MessageBody>
    {identity && <MessageReactions identity={identity} reactions={reactions} open={reactionsOpen} onOpenChange={setReactionsOpen} />}
  </MessageFrame>;
}

export function AttachmentPlayback({ attachment }: { attachment: ChatAttachment }) {
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
  const media = useCachedMedia(src, near, attempt);
  const imageSrc = media.src && (attempt && !media.ready ? `${media.src}${media.src.includes("?") ? "&" : "?"}retry=${attempt}` : media.src);
  const failed = state === "error" || !!media.error;
  const edit = (event: SyntheticEvent<HTMLImageElement>) => {
    if (!onEditImage || state !== "ready") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    onEditImage(event.currentTarget);
  };
  return <div className="attachment-image-frame" ref={ref}>
    {!failed && state === "loading" && !media.ready && <div className="attachment-placeholder" aria-hidden="true" />}
    {failed && <div className="attachment-error" role="alert">Could not load image. <button type="button" onClick={() => { setState("loading"); setAttempt(value => value + 1); }}>Retry</button></div>}
    {imageSrc && !failed && <img className={className} src={imageSrc} data-source-url={src} alt={alt} crossOrigin="anonymous" data-download-query={downloadQuery || undefined} loading="lazy" decoding="async" role="button" tabIndex={0} aria-label={`Draw on ${alt || "image"}`} onLoad={() => setState("ready")} onError={() => setState("error")} onClick={edit} onKeyDown={event => {
      if (event.key === "Enter" || event.key === " ") edit(event);
    }} />}
  </div>;
}
