import { useEffect, useRef, useState, type ReactNode } from "react";
import { agentAvatar, ChatMessage } from "../../chat-message";
import { ReplyComposer, type ReplyTarget } from "../../message-reply";
import { AGENT_NAME } from "../../../../server/agent-identity";
import { Composer, type ComposerAttachment } from "../../Composer";
import { ConversationView } from "../../ConversationView";
import { InlineImagesContext, Markdown } from "../../context";
import { DismissibleError } from "../../dismissible-error";
import type { ChatDrawing } from "../../chat-drawing";
import type { InlineImage } from "../../../../server/inline-image-contract";
import type { ContextEntry, Session, SlashCommand } from "../../types";
import { StatusPill } from "../status/StatusPill";
import { OFFLINE_STATUS, threadStatus } from "../status/thread-status";
import { composerAction } from "../../thread-state";
import { DELIVERY_LABELS } from "../queue/delivery";
import { Transcript } from "./Transcript";
import "./conversation.css";

export type Delivery = "queue" | "steer" | "hardSteer";

export function BackIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>; }
function InfoIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8v.2" /></svg>; }
function ChevronIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>; }

export function ConversationHeader({ title, status, onBack, onOpenInspector, trailing, meta, avatar, showIdentity = true }: { title: string; status?: ReactNode; onBack: (() => void) | null; onOpenInspector: (() => void) | null; trailing?: ReactNode; meta?: ReactNode; /** The contact's picture next to the title. */ avatar?: string; showIdentity?: boolean }) {
  return <header className="conversation-header">
    {onBack && <button type="button" className="header-icon" aria-label="Back" onClick={onBack}><BackIcon /></button>}
    {avatar && showIdentity && <img className="conversation-avatar" src={avatar} alt="" decoding="async" />}
    <div className="conversation-title">
      {showIdentity && <span className="conversation-title-text">{title}</span>}
      {(status || meta) && <span className="conversation-subtitle">{status}{meta}</span>}
    </div>
    {trailing}
    {onOpenInspector && <button type="button" className="header-icon" aria-label={`${title}. Thread details`} onClick={onOpenInspector}><InfoIcon /></button>}
  </header>;
}

export function ConversationScreen({ session, ancestors, entries, liveText, liveThinking, thinkingActive, images, offline, pending, home, prompt, attachments, slashCommands, drawing, uploadError, controlError, earlierAvailable, loadingEarlier, earlierError, onShowEarlier, onThinkingOpen, onBack, onOpenInspector, onOpenAncestor, onOpenQueue, onEdit, reply, onReply, onCancelReply, onPrompt, onSend, onStop, onResume, onReconnect, onRemoveAttachment, onUpload, onPaste, onDraw, onDismissControlError, showBack, showIdentity = true }: {
  session: Session;
  ancestors: Session[];
  entries: ContextEntry[];
  liveText: string;
  liveThinking: string;
  thinkingActive: boolean;
  earlierAvailable: boolean;
  loadingEarlier: boolean;
  earlierError: string;
  onShowEarlier(): void;
  onThinkingOpen(open: boolean): void;
  images: ReadonlyMap<string, InlineImage> | null;
  offline: string;
  pending: boolean;
  home: string;
  prompt: string;
  attachments: ComposerAttachment[];
  slashCommands: SlashCommand[];
  drawing: ChatDrawing;
  uploadError: string;
  controlError: string;
  showBack: boolean;
  showIdentity?: boolean;
  onBack(): void;
  onOpenInspector(): void;
  onOpenAncestor(session: Session): void;
  onOpenQueue(): void;
  onEdit(entry: ContextEntry): void;
  reply: ReplyTarget | null;
  onReply(target: ReplyTarget): void;
  onCancelReply(): void;
  onPrompt(text: string): void;
  onSend(delivery: Delivery): void;
  onStop(): void;
  onResume(): void;
  onReconnect(): void;
  onRemoveAttachment(id: string): void;
  onUpload(files: File[]): void;
  onPaste(): void;
  onDraw(): void;
  onDismissControlError(): void;
}) {
  const status = offline ? OFFLINE_STATUS : threadStatus(session);
  const running = session.state === "running";
  const hasText = prompt.trim().length > 0 || attachments.some(file => !file.uploading);
  const queued = session.queuedMessages.length;
  const action = composerAction(session, prompt);
  const [delivery, setDelivery] = useState<Delivery>("queue");
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null);
  const modeToggleRef = useRef<HTMLButtonElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!running) { setDelivery("queue"); setModeOpen(false); } }, [running, session.id]);
  useEffect(() => {
    if (!modeOpen) return;
    modeMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => { if (!modeRef.current?.contains(event.target as Node)) setModeOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [modeOpen]);
  const slashToken = prompt.startsWith("/") && !/\s/.test(prompt) ? prompt.slice(1).toLowerCase() : null;
  const visibleCommands = slashToken === null ? [] : slashCommands.filter(command => command.source === "skill" && !command.name.toLowerCase().includes("mcp") && command.name.toLowerCase().startsWith(slashToken));
  const modelShort = session.model.split("/").at(-1) || session.model;
  return <div className="conversation-screen">
    <ConversationHeader title={session.name || "Agent"} status={<StatusPill status={status} />} meta={<span className="conversation-meta">{modelShort}</span>} showIdentity={showIdentity} onBack={showBack ? onBack : null} onOpenInspector={onOpenInspector}
      trailing={<>{queued > 0 && <button type="button" className="header-chip" onClick={onOpenQueue} aria-label={`${queued} waiting. Open the queue`}>{queued === 1 ? "1 waiting" : `${queued} waiting`}</button>}{offline && <button type="button" className="header-action" onClick={onReconnect}>Reconnect</button>}</>} />
    {ancestors.length > 0 && <nav className="ancestry" aria-label="Parent threads">{ancestors.map(ancestor => <button key={ancestor.id} type="button" onClick={() => onOpenAncestor(ancestor)}>{ancestor.name || ancestor.id}</button>)}</nav>}
    <ConversationView key={session.id} active label={`Chat with ${session.name || "Agent"}`} drawing={drawing} transcript={<InlineImagesContext.Provider value={images}>
      <Transcript entries={entries} liveThinking={liveThinking} thinkingActive={thinkingActive} sessionId={session.id} home={home} images={images}
        earlierAvailable={earlierAvailable} loadingEarlier={loadingEarlier} earlierError={earlierError} onShowEarlier={onShowEarlier} onThinkingOpen={onThinkingOpen} onEdit={onEdit} onReply={onReply} />
      {liveText && <div className="live-answer"><ChatMessage kind="assistant" label={AGENT_NAME} avatar={agentAvatar()} text={liveText} contentFormat="markdown" renderMarkdown={text => <Markdown source={text} sessionId={session.id} streaming assistant />} /></div>}
    </InlineImagesContext.Provider>}>
      <DismissibleError className="conversation-error" dismissLabel="Dismiss upload error" message={uploadError} resetKey={session.id} />
      <DismissibleError className="conversation-error" dismissLabel="Dismiss thread error" message={controlError} resetKey={session.id} onDismiss={async () => { onDismissControlError(); return { ok: true as const }; }} />
      <Composer id="prompt" value={prompt} onChange={onPrompt} onSend={() => action === "stop" ? onStop() : action === "resume" ? onResume() : onSend(delivery)} placeholder={`Message ${session.name || "Agent"}`} action={action} disabled={pending || (action === "send" && (attachments.some(file => file.uploading) || !hasText))} layoutKey={session.id}
        attachments={attachments} onRemove={onRemoveAttachment} onUpload={onUpload} onPaste={onPaste} onDraw={onDraw}
        before={<>{reply && <ReplyComposer target={reply} onCancel={onCancelReply} />}{visibleCommands.length > 0 && <div className="slash-commands" role="listbox">{visibleCommands.map(command => <button key={command.name} type="button" className="slash-command" onClick={() => onPrompt(`/${command.name} `)}><strong className="slash-command-name">/{command.name}</strong>{command.description && <span className="slash-command-description">{command.description}</span>}</button>)}</div>}</>}
        actions={running && hasText && <div className="delivery-mode" ref={modeRef}>
          <button ref={modeToggleRef} type="button" className="delivery-toggle" aria-haspopup="menu" aria-expanded={modeOpen} aria-label={`Change delivery. Current: ${DELIVERY_LABELS[delivery].label}`} onClick={() => setModeOpen(open => !open)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setModeOpen(true); } }}><span>{DELIVERY_LABELS[delivery].label}</span><ChevronIcon /></button>
          {modeOpen && <div ref={modeMenuRef} className="delivery-menu" role="menu" aria-label="Change delivery" onKeyDown={event => {
            if (event.key === "Escape") { setModeOpen(false); modeToggleRef.current?.focus(); return; }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const current = choices.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : event.key === "ArrowDown" ? (current + 1) % choices.length : (current - 1 + choices.length) % choices.length;
            choices[next]?.focus();
          }}>{(["queue", "steer", "hardSteer"] as Delivery[]).filter(mode => mode !== delivery).map(mode => <button key={mode} type="button" role="menuitem" data-mode={mode} onClick={() => { setDelivery(mode); setModeOpen(false); modeToggleRef.current?.focus(); }}><strong>{DELIVERY_LABELS[mode].label}</strong><span>{DELIVERY_LABELS[mode].detail}</span></button>)}</div>}
        </div>} />
    </ConversationView>
  </div>;
}
