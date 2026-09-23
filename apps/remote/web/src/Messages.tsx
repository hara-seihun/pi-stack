import { useCallback, useEffect, useRef, useState } from "react";
import type { MessagingBackendInfo, MessagingConversation, MessagingMessage, MessagingSnapshot } from "../../server/messaging/protocol";
import { Composer } from "./Composer";
import { useChatDrawing } from "./chat-drawing";
import { ConversationView } from "./ConversationView";
import { ChatMessageGroup, messagingMessageProps, messagingMessageSegment } from "./chat-message";
import { PasteTextDialog } from "./PasteTextDialog";
import { DismissibleError } from "./dismissible-error";
import { listenForFileDrops } from "./file-drop";
import { messagingClient } from "./messaging-client";
import { beginHumanSend, draftFromHumanMessage, emptyHumanDraft, groupHumanMessages, mergeHumanMessages, requestFromHumanMessage, unconfirmedHumanSend, type HumanDraft } from "./messaging-state";
import "./messages.css";

export function MessagingConversations({ selected, snapshot, onRead }: {
  selected: MessagingConversation | null;
  snapshot: MessagingSnapshot;
  onRead(): void;
}) {
  const [visited, setVisited] = useState<MessagingConversation[]>([]);
  useEffect(() => {
    if (selected) setVisited(current => current.some(item => item.id === selected.id) ? current : [...current, selected]);
  }, [selected]);
  return <>{visited.map(previous => {
    const conversation = snapshot.conversations.find(item => item.id === previous.id) ?? previous;
    return <MessagingConversationController key={conversation.id} conversation={conversation} backend={snapshot.backends.find(item => item.id === conversation.backendId)} active={conversation.id === selected?.id} version={snapshot.version} onRead={onRead} />;
  })}</>;
}

function MessagingConversationController({ conversation, backend, active, version, onRead }: {
  conversation: MessagingConversation;
  backend?: MessagingBackendInfo;
  active: boolean;
  version: number;
  onRead(): void;
}) {
  const [draft, setDraft] = useState(emptyHumanDraft);
  const currentDraft = useRef(draft);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<MessagingMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const historyStarted = useRef(false);
  const [revision, setRevision] = useState(0);
  const checking = useRef(new Set<string>());
  const [pendingChecks, setPendingChecks] = useState<string[]>([]);
  const [uploading, setUploading] = useState<Array<{ id: string; name: string }>>([]);
  const uploads = useRef(0);
  const [olderLoading, setOlderLoading] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasteName, setPasteName] = useState("pasted-text.txt");
  const [pasteContent, setPasteContent] = useState("");
  const [fileDrag, setFileDrag] = useState(false);
  const lifetime = useRef(new AbortController());
  const lastRead = useRef("");
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  const save = useCallback((next: HumanDraft) => {
    currentDraft.current = next;
    setDraft(next);
  }, []);
  const applyMessage = useCallback((message: MessagingMessage) => {
    setMessages(current => mergeHumanMessages(current, [message]));
  }, []);
  const refresh = useCallback(async (signal: AbortSignal) => {
    const result = await messagingClient.history(conversation.id, signal);
    if (signal.aborted) return;
    if (!result.ok) { setError(result.error.message); return; }
    setError(""); setLoaded(true);
    setMessages(current => mergeHumanMessages(current, result.value.messages));
    if (!historyStarted.current) { setBefore(result.value.before); historyStarted.current = true; }
    const newest = result.value.messages.at(-1)?.id ?? "empty";
    if (conversation.unread > 0 && lastRead.current !== newest && document.visibilityState === "visible") {
      const read = await messagingClient.read(conversation.id, signal);
      if (signal.aborted) return;
      if (read.ok) { lastRead.current = newest; onRead(); }
      else setError(`Could not mark messages read: ${read.error.message}`);
    }
  }, [conversation.id, conversation.unread, revision, version, applyMessage, onRead]);
  useEffect(() => {
    if (!active) return;
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      if (document.visibilityState === "hidden") return;
      controller = new AbortController();
      void refresh(controller.signal);
    };
    load();
    document.addEventListener("visibilitychange", load);
    window.addEventListener("online", load);
    return () => { controller?.abort(); document.removeEventListener("visibilitychange", load); window.removeEventListener("online", load); };
  }, [active, refresh]);
  const older = async () => {
    if (before === null || olderLoading) return;
    setOlderLoading(true);
    const result = await messagingClient.history(conversation.id, lifetime.current.signal, before);
    if (lifetime.current.signal.aborted) return;
    setOlderLoading(false);
    if (result.ok) {
      setMessages(current => mergeHumanMessages(current, result.value.messages)); setBefore(result.value.before);
    } else setError(result.error.message);
  };
  const uploadFile = async (file: File): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!backend?.capabilities.attachments) return { ok: false, error: "This service does not support attachments." };
    if (currentDraft.current.attachments.length + uploads.current >= 32) return { ok: false, error: "A message can contain at most 32 attachments." };
    const id = crypto.randomUUID();
    uploads.current++;
    setUploading(current => [...current, { id, name: file.name }]);
    const result = await messagingClient.upload(conversation.id, file, lifetime.current.signal);
    uploads.current--;
    if (lifetime.current.signal.aborted) return { ok: false, error: "Upload cancelled" };
    setUploading(current => current.filter(item => item.id !== id));
    if (!result.ok) return { ok: false, error: result.error.message };
    setError("");
    save({ ...currentDraft.current, attachments: [...currentDraft.current.attachments, result.value.attachment] });
    return { ok: true };
  };
  const drawing = useChatDrawing(active ? conversation.id : null, uploadFile);
  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      const result = await uploadFile(file);
      if (!result.ok) { setError(`${file.name}: ${result.error}`); break; }
    }
  };
  const uploadHandler = useRef(uploadFiles);
  uploadHandler.current = uploadFiles;
  useEffect(() => {
    if (!active) return;
    return listenForFileDrops(window, () => !!backend?.capabilities.attachments,
      files => void uploadHandler.current(files), setFileDrag);
  }, [active, backend?.capabilities.attachments]);
  const remove = async (id: string) => {
    const attachment = currentDraft.current.attachments.find(item => item.id === id);
    if (!attachment) return;
    save({ ...currentDraft.current, attachments: currentDraft.current.attachments.filter(item => item.id !== id) });
    const result = await messagingClient.remove(id, lifetime.current.signal);
    if (lifetime.current.signal.aborted) return;
    if (!result.ok) {
      if (!currentDraft.current.attachments.some(item => item.id === id)) save({ ...currentDraft.current, attachments: [...currentDraft.current.attachments, attachment] });
      setError(result.error.message);
    }
  };
  const send = async () => {
    if (uploads.current || (!currentDraft.current.text.trim() && !currentDraft.current.attachments.length)) return;
    const { message, request } = beginHumanSend(currentDraft.current, conversation.id, crypto.randomUUID());
    setMessages(current => mergeHumanMessages(current, [message]));
    save(emptyHumanDraft());
    setError("");
    const result = await messagingClient.send(conversation.id, request, lifetime.current.signal);
    if (lifetime.current.signal.aborted) return;
    if (result.ok) { applyMessage(result.value.message); setRevision(current => current + 1); }
    else setMessages(current => unconfirmedHumanSend(current, message, result.error.message));
  };
  const checkRequest = async (message: MessagingMessage) => {
    const request = requestFromHumanMessage(message);
    if (!request || checking.current.has(request.requestId)) return;
    checking.current.add(request.requestId);
    setPendingChecks([...checking.current]);
    const result = await messagingClient.send(conversation.id, request, lifetime.current.signal);
    checking.current.delete(request.requestId);
    if (lifetime.current.signal.aborted) return;
    setPendingChecks([...checking.current]);
    if (result.ok) applyMessage(result.value.message);
    else setMessages(current => unconfirmedHumanSend(current, message, result.error.message));
  };
  const ready = backend?.status === "ready";
  return <ConversationView active={active} label={`Messages with ${conversation.title}`} drawing={drawing} editImages={!!backend?.capabilities.attachments} transcript={<div className="transcript">
        {before !== null && <button type="button" disabled={olderLoading} onClick={() => void older()}>{olderLoading ? "Loading…" : "Older messages"}</button>}
        {!loaded && !messages.length && !error && <p className="muted">Loading conversation…</p>}
        {loaded && !messages.length && <p className="muted">No messages yet</p>}
        {groupHumanMessages(messages).map(group => {
          const { kind, label, avatar } = messagingMessageProps(group[0], conversation.backendId);
          return <ChatMessageGroup key={group[0].id} kind={kind} label={label} avatar={avatar} checking={group.some(message => pendingChecks.includes(message.id))} segments={group.map(message => messagingMessageSegment(message, {
            onCheck: () => void checkRequest(message),
            onRetry: () => {
              if (currentDraft.current.text || currentDraft.current.attachments.length) { setError("Keep or send your current draft before restoring the failed message."); return; }
              save(draftFromHumanMessage(message));
            },
          }))} />;
        })}
      </div>}>
    {fileDrag && <div className="file-drop-overlay" role="status">Drop files to attach to {conversation.title}</div>}
    {!ready && <p className="messaging-notice" role="status">{backend?.detail || "This messaging service is unavailable. Open the chat picker to check its configuration."}</p>}
    <DismissibleError message={error} />
    {error && <button type="button" onClick={() => setRevision(current => current + 1)}>Refresh conversation</button>}
    <Composer value={draft.text} onChange={text => save({ ...currentDraft.current, text })} placeholder={`Message ${conversation.title}`} layoutKey={`${active}:${drawing.isOpen}`} disabled={!ready || !!uploading.length || (!draft.text.trim() && !draft.attachments.length)} attachmentDisabled={!backend?.capabilities.attachments}
      attachments={[...draft.attachments, ...uploading.map(item => ({ ...item, uploading: true }))]} onRemove={id => void remove(id)} onUpload={files => void uploadFiles(files)} onPaste={() => setPaste(true)} onDraw={() => drawing.open()} onSend={() => void send()} />
    {active && paste && <PasteTextDialog name={pasteName} content={pasteContent} onNameChange={setPasteName} onContentChange={setPasteContent} onAttach={uploadFile} onClose={() => setPaste(false)} />}
  </ConversationView>;
}
