import type { ReactNode } from "react";
import { agentAvatar, ChatMessage } from "../../chat-message";
import { managerLiveText } from "pi-orchestrator/manager-turn";
import { CachedImage } from "../../cached-media";
import { ReplyComposer, type ReplyTarget } from "../../message-reply";
import { AGENT_NAME } from "../../../../server/agent-identity";
import { Composer, type ComposerAttachment } from "../../Composer";
import { ConversationView } from "../../ConversationView";
import { InlineImagesContext, Markdown } from "../../context";
import { DismissibleError } from "../../dismissible-error";
import type { ChatDrawing } from "../../chat-drawing";
import type { InlineImage } from "../../../../server/inline-image-contract";
import type { ContextEntry, Session, SlashCommand } from "../../types";
import { ConversationStatus, type ConversationConnection } from "../status/ConversationStatus";
import { monoThreadStatus, threadStatus } from "../status/thread-status";
import { composerAction } from "../../thread-state";
import { Transcript } from "./Transcript";
import type { VisibleTranscriptRange } from "./transcript-store";
import { ConversationModelMeta } from "./ContextTokens";
import { QuestionsComposer } from "./questions";
import type { ThreadQuestion, QuestionsResource } from "../../../../server/protocol";
import "./conversation.css";
import { useLongPress } from "../../app/long-press";


export function BackIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>; }
function InfoIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8v.2" /></svg>; }

export function ConversationHeader({ title, subtitle, status, onBack, onOpenInspector, trailing, meta, avatar, showIdentity = true, compact = false, onLongPress }: { compact?: boolean; onLongPress?(): void; title: string; /** A second identity line, such as an agent's task under its name. */ subtitle?: string; /** Readable conversation state, beneath its identity. */ status?: ReactNode; onBack: (() => void) | null; onOpenInspector: (() => void) | null; trailing?: ReactNode; meta?: ReactNode; /** The contact's picture next to the title. */ avatar?: string; showIdentity?: boolean }) {
  const longPress = useLongPress(onLongPress);
  return <header className={`conversation-header${compact ? " chat-header" : ""}`} {...longPress} title={onLongPress ? "Long-press to return to classic view" : undefined}>
    {onBack && <button type="button" className="header-icon" aria-label="Back" onClick={onBack}><BackIcon /></button>}
    {avatar && showIdentity && <CachedImage className="conversation-avatar" src={avatar} alt="" decoding="async" />}
    <div className="conversation-title">
      {showIdentity ? <span className="conversation-title-line"><span className="conversation-title-text">{title}</span>{meta}</span> : meta}
      {showIdentity && subtitle && <span className="conversation-subtitle" title={subtitle}>{subtitle}</span>}
      {!compact && status && <span className="conversation-status">{status}</span>}
    </div>
    {compact && status && <span className="conversation-status">{status}</span>}
    {trailing}
    {onOpenInspector && <button type="button" className="header-icon" aria-label={`${title}. Thread details`} onClick={onOpenInspector}><InfoIcon /></button>}
  </header>;
}

export function ConversationScreen({ session, ancestors, entries, liveText, liveThinking, thinkingActive, autoCollapse = true, images, offline, syncing = false, pending, home, prompt, attachments, slashCommands, drawing, uploadError, controlError, earlierAvailable, loadingEarlier, earlierError, onShowEarlier, newerAvailable, onShowNewer, onJumpLatest, onVisibleRange, outbox, sentPromptId, onRetryPrompt, onDiscardPrompt, onThinkingOpen, onBack, onOpenInspector, onOpenAncestor, onOpenQueue, questions, questionsResource, onRetryQuestions, onQuestionAccepted, onEdit, reply, onReply, onCancelReply, onPrompt, onSend, onStop, onResume, onReconnect, onRemoveAttachment, onUpload, onPaste, onDraw, onDismissControlError, showBack, showIdentity = true, mono }: {
  session: Session;
  mono?: { hintSeen: boolean; onClassic(): void; onHintSeen(): void; saving: boolean };
  ancestors: Session[];
  entries: ContextEntry[];
  liveText: string;
  liveThinking: string;
  thinkingActive: boolean;
  autoCollapse?: boolean;
  earlierAvailable: boolean;
  loadingEarlier: boolean;
  earlierError: string;
  onShowEarlier(): void;
  newerAvailable?: boolean;
  onShowNewer?(): void;
  onJumpLatest?(): void;
  onVisibleRange?(range: VisibleTranscriptRange | null): void;
  outbox?: ReactNode;
  sentPromptId?: string;
  onRetryPrompt?(requestId: string): void;
  onDiscardPrompt?(requestId: string): void;
  onThinkingOpen(open: boolean): void;
  images: ReadonlyMap<string, InlineImage> | null;
  offline: string;
  syncing?: boolean;
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
  questions: ThreadQuestion[];
  questionsResource?: QuestionsResource;
  onRetryQuestions?(): void;
  onQuestionAccepted(id: string): void;
  onEdit(entry: ContextEntry): void;
  reply: ReplyTarget | null;
  onReply(target: ReplyTarget): void;
  onCancelReply(): void;
  onPrompt(text: string): void;
  onSend(): void;
  onStop(): void;
  onResume(): void;
  onReconnect(): void;
  onRemoveAttachment(id: string): void;
  onUpload(files: File[]): void;
  onPaste(): void;
  onDraw(): void;
  onDismissControlError(): void;
}) {
  const visibleLiveText = session.manager ? managerLiveText(liveText ?? "") : liveText;
  const status = mono ? monoThreadStatus(session) : threadStatus(session);
  const connection: ConversationConnection = offline ? { kind: "disconnected", reason: offline } : syncing ? { kind: "syncing" } : { kind: "connected" };
  const hasText = prompt.trim().length > 0 || attachments.some(file => !file.uploading);
  const queued = session.queuedMessages.length;
  const action = session.manager ? "send" : composerAction(session, prompt);
  const cancelAction = composerAction(session, "");
  const slashToken = prompt.startsWith("/") && !/\s/.test(prompt) ? prompt.slice(1).toLowerCase() : null;
  const visibleCommands = slashToken === null ? [] : slashCommands.filter(command => command.source === "skill" && !command.name.toLowerCase().includes("mcp") && command.name.toLowerCase().startsWith(slashToken));
  return <div className={`conversation-screen${mono ? " mono-conversation" : ""}${session.manager ? " manager-conversation" : ""}`}>
    <ConversationHeader title={mono || session.manager ? AGENT_NAME : session.name || "Agent"} compact={session.manager === true} avatar={session.manager ? agentAvatar() : undefined} onLongPress={mono?.onClassic} status={<ConversationStatus status={status} connection={connection} />} meta={session.manager || mono ? undefined : <ConversationModelMeta session={session} />} showIdentity={mono || session.manager ? true : showIdentity} onBack={!mono && showBack ? onBack : null} onOpenInspector={mono ? null : onOpenInspector}
      trailing={<>{!session.manager && questions.length > 0 && (cancelAction === "stop" || cancelAction === "cancel_wait") && <button type="button" className="header-action" disabled={pending} onClick={onStop}>{cancelAction === "stop" ? "Cancel work" : mono ? "Cancel request" : "Cancel wait"}</button>}{queued > 0 && <button type="button" className="header-chip" onClick={onOpenQueue} aria-label={`${queued} queued. Open the queue`}>{queued} queued</button>}{offline && <button type="button" className="header-action" onClick={onReconnect}>Reconnect</button>}</>} />
    {mono && !mono.hintSeen && <aside className="mono-hint" role="status"><span>Long-press this header to return to classic view. Long-press Chats to come back here.</span><button type="button" disabled={mono.saving} onClick={mono.onHintSeen} aria-label="Dismiss mono view hint">Got it</button></aside>}
    {!mono && ancestors.length > 0 && <nav className="ancestry" aria-label="Launched by">{ancestors.map(ancestor => <button key={ancestor.id} type="button" title={ancestor.name || undefined} onClick={() => onOpenAncestor(ancestor)}>{ancestor.name || ancestor.id}</button>)}</nav>}
    <DismissibleError className="conversation-error" dismissLabel="Dismiss thread error" message={controlError} resetKey={session.id} onDismiss={async () => { onDismissControlError(); return { ok: true as const }; }} />
    {outbox}
    <ConversationView key={session.id} active sentPromptId={sentPromptId} newerAvailable={newerAvailable} onJumpLatest={onJumpLatest} label={`Chat with ${mono ? AGENT_NAME : session.name || "Agent"}`} drawing={drawing} transcript={<InlineImagesContext.Provider value={images}>
      {(syncing || offline) && entries.length === 0 && <div className="conversation-loading" role={offline ? "alert" : "status"}><strong>{offline ? "Conversation unavailable" : "Opening conversation…"}</strong><span>{offline || "Waiting for the selected environment to return its history."}</span></div>}
      <Transcript entries={entries} mono={!!mono || session.manager === true} messenger={session.manager === true} working={session.state === "running" || session.state === "waiting"} liveThinking={liveThinking} thinkingActive={thinkingActive} autoCollapse={autoCollapse} sessionId={session.id} home={home} images={images}
        earlierAvailable={earlierAvailable} loadingEarlier={loadingEarlier} earlierError={earlierError} onShowEarlier={onShowEarlier} newerAvailable={newerAvailable} onShowNewer={onShowNewer} onVisibleRange={onVisibleRange} onThinkingOpen={onThinkingOpen} onEdit={onEdit} onReply={onReply} onRetryPrompt={onRetryPrompt} onDiscardPrompt={onDiscardPrompt} />
      {!session.manager && visibleLiveText && <div className="live-answer"><ChatMessage kind="assistant" appearance={session.manager ? "bubble" : undefined} label={AGENT_NAME} avatar={agentAvatar()} text={visibleLiveText} contentFormat="markdown" renderMarkdown={text => <Markdown source={text} sessionId={session.id} streaming assistant />} /></div>}
    </InlineImagesContext.Provider>}>
      <DismissibleError className="conversation-error" dismissLabel="Dismiss upload error" message={uploadError} resetKey={session.id} />
      {questionsResource?.state === "failed" && <div className="conversation-error" role="alert">Could not load questions: {questionsResource.error}. {questions.length > 0 ? "Showing previous questions; their status may have changed." : "Chat remains available."} <button type="button" onClick={onRetryQuestions}>Retry questions</button></div>}
      {questions.length > 0 && session.manager && <QuestionsComposer sessionId={session.id} questions={questions} onAccepted={onQuestionAccepted} />}
      {questions.length > 0 && !session.manager ? <QuestionsComposer sessionId={session.id} questions={questions} onAccepted={onQuestionAccepted} /> : <Composer id="prompt" value={prompt} onChange={onPrompt} onSend={() => action === "stop" || action === "cancel_wait" ? onStop() : action === "resume" ? onResume() : onSend()} cancelWaitLabel={mono ? "Cancel request" : "Cancel wait"} placeholder={`Message ${mono ? AGENT_NAME : session.name || "Agent"}`} action={action} disabled={pending || (action === "send" && (attachments.some(file => file.uploading) || !hasText))} layoutKey={session.id}
        attachments={attachments} onRemove={onRemoveAttachment} onUpload={onUpload} onPaste={onPaste} onDraw={onDraw}
        before={<>{reply && <ReplyComposer target={reply} onCancel={onCancelReply} />}{visibleCommands.length > 0 && <div className="slash-commands" role="listbox">{visibleCommands.map(command => <button key={command.name} type="button" className="slash-command" onClick={() => onPrompt(`/${command.name} `)}><strong className="slash-command-name">/{command.name}</strong>{command.description && <span className="slash-command-description">{command.description}</span>}</button>)}</div>}</>}
        />}
    </ConversationView>
  </div>;
}
