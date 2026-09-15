import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "motion/react";
import { API } from "../../server/api";
import { appPath, appStorageKey } from "./app-path";
import type { GovernorProvider, GovernorState, InlineImageSnapshot, ThreadStart } from "../../server/protocol";
import { deleteCachedContext, readCachedContext, writeCachedContext } from "./context-cache";
import { api, piFetch, registerUnlockHandler, syncRequest } from "./client";
import { fetchPersonChooser } from "./native";
import { ContextTranscript, CopyButton, InlineImagesContext, Markdown, modelContextEntries } from "./context";
import { LiveActivity } from "./live-activity";
import { FileExplorer } from "./file-explorer";
import { DrawingCanvas } from "./DrawingCanvas";
import { EnvironmentControl } from "./EnvironmentControl";
import { PasteTextDialog } from "./PasteTextDialog";
import { DismissibleError } from "./dismissible-error";
import { dismissServerError } from "./error-feedback";
import { drawingImage, findDrawingDraft, type DrawingBackground, type DrawingDraft } from "./drawing-drafts";
import { NotificationControl, takeNotificationTarget, retainNotificationTarget } from "./notifications";
import { listenForFileDrops } from "./file-drop";
import { createSyncLoop, type SyncLoop } from "./sync-loop";
import { updateDocument } from "./sync";
import { threadsInOrder } from "./thread-order";
import { activityColor, activityLabel, composerAction, conversationThreads, orchestratorThreads, working } from "./thread-state";
import { OrchestratorThreadList } from "./thread-views";
import { SettingsPanel } from "./thread-settings";
import { requestStop, submitThreadControl, ThreadStopDialog } from "./thread-controls";
import { AppUpdateControl } from "./app-update";
import { ThreadStartMenu } from "./thread-start-menu";
import type { Attachment, ContextEntry, Dashboard, Governor, GovernorControls, MachineActionState, PlanCard, QueuedMessage, Session, SlashCommand, SyncRequest } from "./types";

// Everything the server owns arrives through one long poll and is replaced
// wholesale per section; the client never patches a server-owned value from a
// mutation response. What remains local is the view (which thread, which
// drawer tab), the verified documents for that view, and composer scratch.
interface AppState {
  selectedId: string | null;
  drawerTab: DrawerTab;
  drawerOpen: boolean;
  settingsOpen: boolean;
  sessions: Session[];
  archived: Session[];
  discovered: Session[];
  archivedTotal: number;
  /** A dropped drawer order shown until the server confirms it. */
  pendingOrder: string[] | null;
  dashboard: Dashboard | null;
  context: SyncDocument | null;
  images: InlineImageSnapshot | null;
  liveText: SyncDocument | null;
  liveThinking: SyncDocument | null;
  attachments: Attachment[];
  slashCommands: SlashCommand[];
  offline: string;
  ownerErrors: { id: string; owner: string; message: string }[];
  syncing: boolean;
}

const initialState: AppState = {
  selectedId: null, drawerTab: "threads", drawerOpen: innerWidth >= 1000, settingsOpen: false,
  sessions: [], archived: [], discovered: [], archivedTotal: 0, pendingOrder: null, dashboard: null,
  context: null, images: null, liveText: null, liveThinking: null,
  attachments: [], slashCommands: [], offline: "", ownerErrors: [], syncing: true,
};

function iconUrl(icon: string) {
  return /^(data:|https?:|\/\/)/.test(icon) ? icon : appPath(icon.startsWith("/") ? icon : `${encodeURIComponent(icon)}.svg`);
}
function draftKey(id: string) { return appStorageKey(`pi-remote-draft:${window.PiRemotePerson.get()}:${id}`); }
function loadDraft(id: string) { try { return localStorage.getItem(draftKey(id)) || ""; } catch { return ""; } }
function saveDraft(id: string, value: string) { try { value ? localStorage.setItem(draftKey(id), value) : localStorage.removeItem(draftKey(id)); } catch {} }

function useStableState() {
  const [state, setRenderedState] = useState(initialState);
  const stateRef = useRef(state);
  const patch = useCallback((value: Partial<AppState> | ((current: AppState) => Partial<AppState>)) => {
    const update = typeof value === "function" ? value(stateRef.current) : value;
    stateRef.current = { ...stateRef.current, ...update };
    setRenderedState(stateRef.current);
  }, []);
  return { state, stateRef, patch };
}

function UnlockDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((key: string) => void) | null>(null);
  const [people, setPeople] = useState<Array<{ user: string; displayName?: string; requiresUnlock?: boolean }>>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    registerUnlockHandler(async (nextMessage) => {
      setMessage(nextMessage);
      setKey("");
      try {
        const response = await fetchPersonChooser();
        if (!response.ok) throw new Error(`Person chooser returned HTTP ${response.status}`);
        const result = await response.json();
        const nextPeople = result?.environment?.persons || result?.persons || [];
        const savedUser = window.PiRemotePerson?.get() || "";
        const nextUser = nextPeople.some((person: { user: string }) => person.user === savedUser) ? savedUser : nextPeople[0]?.user || "";
        setPeople(nextPeople);
        setSelectedUser(nextUser);
        window.PiRemotePerson?.set(nextUser);
      } catch (error) { setMessage(`Could not load people: ${String(error)}`); }
      dialog.current?.showModal();
      return new Promise<string>((resolve) => { resolver.current = resolve; });
    });
  }, []);
  const requiresKey = people.find(person => person.user === selectedUser)?.requiresUnlock !== false;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if ((requiresKey && !key) || !selectedUser) return;
    resolver.current?.(key);
    resolver.current = null;
    dialog.current?.close();
  };
  return <dialog ref={dialog} className="unlock-dialog" aria-labelledby="unlock-title" onCancel={event => event.preventDefault()}>
    <form className="unlock-form" onSubmit={submit}>
      <h2 id="unlock-title">Unlock your folder</h2>
      <p>{requiresKey ? "Your folder key stays on this device and opens your private folder on the machine." : "Continue as this person to see their allowed environments."}</p>
      {people.length > 0 && <div className="unlock-field"><label htmlFor="unlock-person">Person</label><select id="unlock-person" value={selectedUser} onChange={(event) => { setSelectedUser(event.target.value); setKey(""); window.PiRemotePerson?.set(event.target.value); }}>{people.map((person) => <option key={person.user} value={person.user}>{person.displayName || person.user}</option>)}</select></div>}
      {requiresKey && <div className="unlock-field"><label htmlFor="unlock-key">Key</label><input id="unlock-key" type="password" autoComplete="current-password" spellCheck={false} required value={key} onChange={(event) => setKey(event.target.value)} /></div>}
      <DismissibleError className="unlock-error" message={message} />
      <div className="unlock-actions"><button className="accent" type="submit">Unlock</button></div>
    </form>
  </dialog>;
}

const GOVERNOR_CLASS: Record<GovernorState, string> = { off: "", green: " active boost-green", blue: " active boost-blue", red: " active halted" };
function governorDescription(name: string, governor: Governor) {
  const current: Record<GovernorState, string> = { off: "normal local allowance", green: "3× local allowance", blue: `${governor.boostedMultiplier}× local allowance`, red: "a background launch halt; operator-requested runs can still start" };
  return `${name} governor is using ${current[governor.state]}. Select to change it`;
}
function MachineControls({ actions, governors, onAction, onGovernor }: { actions: MachineActionState[]; governors: GovernorControls | null; onAction(id: string): void; onGovernor(provider: GovernorProvider): void }) {
  return <div className="machine-controls" aria-label="This machine controls">
    {actions.map((action) => <button key={action.id} className={`machine-control${action.active ? " active" : ""}`} type="button" aria-label={`${action.label} is ${action.active ? "on" : "off"}. Select to turn it ${action.active ? "off" : "on"}`} onClick={() => onAction(action.id)}><img src={iconUrl(action.icon)} alt="" /></button>)}
    {governors && (["openai", "anthropic"] as const).map((provider) => {
      const description = governorDescription(provider === "openai" ? "OpenAI" : "Anthropic", governors[provider]);
      return <button key={provider} className={`machine-control${GOVERNOR_CLASS[governors[provider].state]}`} type="button" aria-label={description} title={description} onClick={() => onGovernor(provider)}><img src={appPath(`${provider}.svg`)} alt="" /></button>;
    })}
  </div>;
}

function PlanSummary({ plans, counts }: { plans: PlanCard[]; counts: Map<string, number> }) {
  return <div className="plan-summary muted">{plans.flatMap((card) => card.metrics.filter((metric) => metric.text !== "—").map((metric) => {
    const description = `${card.label} ${metric.modelLabel}, ${counts.get(metric.model) || 0} in use, ${metric.description}`;
    return <div className="capacity-row" key={`${card.icon}:${metric.model}`} title={description} aria-label={description}><img src={iconUrl(card.icon)} alt={card.label} /><span className="capacity-model">{metric.modelLabel}</span><span className="capacity-count">{counts.get(metric.model) || 0}</span><span className="capacity-cache">{metric.cacheText}</span><span className="capacity-value">{metric.text}</span></div>;
  }))}</div>;
}

type DrawerTab = "threads" | "orchestrator" | "archived" | "files";

function DrawerTabIcon({ tab }: { tab: DrawerTab }) {
  if (tab === "threads") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Zm4 5h8" /></svg>;
  if (tab === "orchestrator") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M12 7.5v4M6 15.5v-4h12v4" /></svg>;
  if (tab === "archived") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v12H4V8Zm-1-4h18v4H3V4Zm6 9h6" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v10H3v-12Z" /></svg>;
}

function ThreadRow({ session, starts, selected, archived, onSelect, onArchive, onUnarchive }: { session: Session; starts: ThreadStart[]; selected: boolean; archived?: boolean; onSelect(id: string): void; onArchive(id: string): void; onUnarchive(id: string): void }) {
  const start = starts.find(candidate => candidate.id === session.environment);
  const alt = start?.label || session.provider;
  const content = <><span className="thread-name">{session.name || "Agent"}</span><span className="thread-meta"><img className="thread-provider" src={iconUrl(start?.icon || session.provider)} alt={alt} title={`${alt} thread`} /><span className="thread-state" style={{ color: activityColor(archived ? "idle" : session.activity, !archived && session.idleUnread) }}>{archived ? "ARCHIVED" : activityLabel(session.activity, session.activeTool ?? "")}</span></span></>;
  return <div className={`thread-row${selected ? " selected" : ""}${archived ? " archived" : " can-archive"}`}>
    {archived ? <div className="thread-open">{content}</div> : <button type="button" className="thread-open" onClick={() => onSelect(session.id)}>{content}</button>}
    {archived ? <button type="button" className="unarchive-thread" onClick={() => onUnarchive(session.id)}>Unarchive</button> : <button type="button" className="archive-thread" aria-label={`Archive thread ${session.name}`} title={`Archive ${session.name}`} onClick={() => onArchive(session.id)}>×</button>}
  </div>;
}

function SortableThreadRow({ session, ...props }: Omit<React.ComponentProps<typeof ThreadRow>, "archived">) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id });
  return <div ref={setNodeRef} className={isDragging ? "sortable-thread dragging" : "sortable-thread"} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}>
    <ThreadRow session={session} {...props} />
  </div>;
}

export default function App() {
  const [person, setPerson] = useState(window.PiRemotePerson.get());
  useEffect(() => {
    const changed = () => setPerson(window.PiRemotePerson.get());
    window.addEventListener("pi-person", changed);
    return () => window.removeEventListener("pi-person", changed);
  }, []);
  return <><UnlockDialog /><RemoteApp key={person} /></>;
}

function RemoteApp() {
  const person = useRef(window.PiRemotePerson.get()).current;
  const { state, stateRef, patch } = useStableState();
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [stopTarget, setStopTarget] = useState<Session | null>(null);
  const [controlError, setControlError] = useState<{ sessionId: string; message: string } | null>(null);
  const [pasteSessionId, setPasteSessionId] = useState<string | null>(null);
  const [drawings, setDrawings] = useState<DrawingDraft[]>([]);
  const [drawingId, setDrawingId] = useState<string | null>(null);
  const drawingOpener = useRef<{ sessionId: string; element: HTMLElement } | null>(null);
  const drawingWasOpen = useRef(false);
  const [uploadError, setUploadError] = useState<{ sessionId: string; message: string } | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const [pasteName, setPasteName] = useState("pasted-text.txt");
  const [pasteContent, setPasteContent] = useState("");
  const [rootFileCount, setRootFileCount] = useState(0);
  const [voiceState, setVoiceState] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [voiceDetail, setVoiceDetail] = useState("");
  const voice = useRef<VoiceSession | null>(null);
  const promptElement = useRef<HTMLTextAreaElement>(null);
  const syncLoop = useRef<SyncLoop | null>(null);
  const syncMeta = useRef({ epoch: "", seq: 0, stateVersion: 0, dashboardVersion: 0, orderCommitted: false });
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 350, tolerance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const kick = useCallback(() => {
    syncLoop.current?.kick();
  }, []);
  const selectedSession = useCallback(() => {
    const current = stateRef.current;
    return [...current.sessions, ...current.archived, ...current.discovered].find((session) => session.id === current.selectedId) ?? null;
  }, [stateRef]);
  const resizePrompt = useCallback(() => {
    const textarea = promptElement.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const style = getComputedStyle(textarea);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.4;
    const verticalChrome = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const maximum = lineHeight * 6 + verticalChrome;
    const height = Math.min(textarea.scrollHeight, maximum);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > maximum ? "auto" : "hidden";
  }, []);

  useLayoutEffect(resizePrompt, [prompt, resizePrompt, state.drawerOpen, state.selectedId]);
  useEffect(() => {
    window.addEventListener("resize", resizePrompt);
    return () => window.removeEventListener("resize", resizePrompt);
  }, [resizePrompt]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") kick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", kick);
    window.addEventListener("pageshow", kick);
    window.addEventListener("focus", kick);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", kick);
      window.removeEventListener("pageshow", kick);
      window.removeEventListener("focus", kick);
    };
  }, [kick]);
  useEffect(() => () => { void voice.current?.stop(); }, []);
  useEffect(() => {
    voice.current?.stop();
    voice.current = null;
    setVoiceState("idle");
    setVoiceDetail("");
  }, [state.selectedId]);

  const toggleVoice = async () => {
    const session = selectedSession();
    if (!session) return;
    if (voice.current && ["connecting", "live"].includes(voiceState)) {
      voice.current.stop(); voice.current = null; setVoiceState("idle"); return;
    }
    voice.current = window.PiRemoteVoice.create({
      sessionId: session.id,
      onState(next, detail) { setVoiceState(next as typeof voiceState); setVoiceDetail(detail || ""); },
      onNotice(message) { setVoiceDetail(message); },
    });
    await voice.current.start();
  };

  const cacheKey = useCallback(async (id: string) => {
    const environment = await window.KenanRemote?.getState().catch(() => null);
    return `${person}:${environment?.id || location.origin}:${id}`;
  }, [person]);

  const selectThread = useCallback(async (id: string, closeDrawer = true, discovered?: Session, drawerTab: DrawerTab = "threads") => {
    setStopTarget(null);
    setPasteSessionId(null);
    patch((current) => ({
      selectedId: id, drawerTab, settingsOpen: false, context: null, images: null, liveText: null, liveThinking: null, slashCommands: [], syncing: true,
      discovered: discovered && ![...current.sessions, ...current.archived, ...current.discovered].some(session => session.id === discovered.id)
        ? [...current.discovered, discovered] : current.discovered,
      ...(closeDrawer ? { drawerOpen: innerWidth >= 1000 } : {}),
    }));
    setPrompt(loadDraft(id));
    kick();
    try {
      const cached = await readCachedContext(await cacheKey(id));
      if (stateRef.current.selectedId === id && stateRef.current.syncing && !stateRef.current.context && cached) {
        patch({ context: cached });
        kick();
      }
    } catch (error) { console.error(error); }
  }, [cacheKey, kick, patch, stateRef]);

  useEffect(() => {
    const openNotification = async () => {
      try {
        const target = await takeNotificationTarget();
        if (!target?.sessionId || !target.environment) return;
        const environment = await window.KenanRemote?.getState();
        if (target.environment !== environment?.id || target.user !== (window.PiRemotePerson?.get() || "")) {
          retainNotificationTarget(target);
          if (target.user !== window.PiRemotePerson.get()) {
            window.PiRemotePerson.set(target.user || "");
            return;
          }
          await window.KenanRemote?.select({ id: target.environment, user: target.user || "" });
          location.reload();
        } else await selectThread(target.sessionId);
      } catch (cause) { patch({ offline: `Could not open notification: ${String(cause)}` }); }
    };
    void openNotification();
    window.addEventListener("pi-notification", openNotification);
    return () => window.removeEventListener("pi-notification", openNotification);
  }, [selectThread, patch]);

  useEffect(() => {
    let fullResync = false;
    const loop = createSyncLoop(async (signal, waitMs) => {
      const current = stateRef.current;
      const meta = syncMeta.current;
      const { selectedId } = current;
      const request: SyncRequest = { epoch: meta.epoch, seq: meta.seq, stateVersion: meta.stateVersion, dashboardVersion: meta.dashboardVersion, waitMs };
      if (selectedId) request.session = { id: selectedId, contextHash: current.context?.hash, imagesVersion: current.images?.version, liveTextHash: current.liveText?.hash, liveThinkingHash: current.liveThinking?.hash, viewing: document.visibilityState === "visible" };
      if (fullResync) {
        request.stateVersion = 0;
        request.dashboardVersion = 0;
        request.waitMs = 0;
        if (request.session) request.session = { id: request.session.id };
      }
      const response = await syncRequest(request, signal);
      signal.throwIfAborted();
      try {
        const update: Partial<AppState> = { offline: "", syncing: false };
        if (response.state) {
          Object.assign(update, response.state, { ownerErrors: response.state.ownerErrors ?? [] });
          if (meta.orderCommitted) update.pendingOrder = null;
        }
        if (response.dashboard) update.dashboard = response.dashboard;
        const live = stateRef.current;
        if (response.session && live.selectedId === selectedId) {
          [update.context, update.liveText, update.liveThinking] = await Promise.all([
            updateDocument(current.context, response.session.context),
            updateDocument(current.liveText, response.session.liveText),
            updateDocument(current.liveThinking, response.session.liveThinking),
          ]);
          if (update.context && update.context !== current.context) JSON.parse(update.context.document);
          if (response.session.images) update.images = response.session.images;
        }
        signal.throwIfAborted();
        Object.assign(meta, { epoch: response.epoch, seq: response.seq, stateVersion: response.stateVersion, dashboardVersion: response.dashboardVersion });
        if (response.state && meta.orderCommitted) meta.orderCommitted = false;
        fullResync = false;
        patch(update);
        if (update.context !== undefined && update.context !== current.context && selectedId) {
          const document = update.context;
          void cacheKey(selectedId).then((key) => document ? writeCachedContext(key, document) : deleteCachedContext(key)).catch(console.error);
        }
        const settled = stateRef.current;
        const firstThread = settled.sessions[0];
        if (!settled.selectedId && firstThread) void selectThread(firstThread.id, false);
      } catch (error) {
        if (!signal.aborted) fullResync = true;
        throw error;
      }
    }, (error) => patch({ offline: error instanceof Error ? error.message : String(error) }));
    syncLoop.current = loop;
    loop.start();
    return () => { loop.stop(); syncLoop.current = null; };
  }, [cacheKey, patch, selectThread, stateRef]);

  const archive = async (id: string) => {
    await api(API.archiveSession.method, API.archiveSession.path({ sessionId: id }));
    void cacheKey(id).then(deleteCachedContext).catch(console.error);
    if (stateRef.current.selectedId === id) patch({ selectedId: null, context: null, images: null, liveText: null, liveThinking: null });
    kick();
  };
  const unarchive = async (id: string) => {
    await api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: id }), {});
    await selectThread(id);
  };
  const reorder = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const previous = orderedSessions(stateRef.current);
    const sourceIndex = previous.findIndex((session) => session.id === active.id);
    const targetIndex = previous.findIndex((session) => session.id === over.id);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const ordered = [...arrayMove(previous, sourceIndex, targetIndex), ...orchestratorThreads(stateRef.current.sessions)].map((session) => session.id);
    patch({ pendingOrder: ordered });
    try {
      await api(API.reorderSessions.method, API.reorderSessions.path(), { sessionIds: ordered });
      syncMeta.current.orderCommitted = true;
      syncMeta.current.stateVersion = 0;
    } catch (error) { patch({ pendingOrder: null }); console.error(error); }
    kick();
  };
  const loadOlder = async () => {
    const offset = state.archived.length;
    const result = await api(API.archivedSessions.method, API.archivedSessions.path({}, { offset, limit: 20 }));
    patch((current) => ({ archived: [...current.archived, ...(result.sessions || []).filter((session: Session) => !current.archived.some((known) => known.id === session.id))], archivedTotal: Number(result.total ?? current.archivedTotal) }));
  };

  const editFrom = useCallback(async (entry: ContextEntry) => {
    const id = stateRef.current.selectedId;
    if (!id || pending) return;
    setPending(true);
    try {
      const result = await api(API.sessionFork.method, API.sessionFork.path({ sessionId: id }), { requestId: crypto.randomUUID(), messageTimestamp: entry.messageTimestamp }, 45_000);
      if (stateRef.current.selectedId !== id) return;
      const text = String(result.text ?? entry.text ?? "");
      setPrompt(text); saveDraft(id, text);
      patch({ context: null });
    } finally { setPending(false); kick(); }
  }, [kick, patch, pending, stateRef]);

  const uploadFile = useCallback(async (source: File, id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const localId = crypto.randomUUID();
    const attachment: Attachment = { localId, name: source.name || "attachment", path: null, storedName: null, sessionId: id, uploading: true };
    patch((current) => ({ attachments: [...current.attachments, attachment] }));
    try {
      const response = await piFetch(API.uploads.path({}, { name: attachment.name, sessionId: id }), { method: "POST", headers: { "content-type": source.type || "application/octet-stream" }, body: source });
      const result = await response.json();
      if (!response.ok) {
        patch((current) => ({ attachments: current.attachments.filter((item) => item.localId !== localId) }));
        return { ok: false, error: result.error || `Upload failed: HTTP ${response.status}` };
      }
      patch((current) => ({ attachments: current.attachments.map((item) => item.localId === localId ? { ...item, uploading: false, path: result.file.path, storedName: result.file.name, environment: result.file.environment } : item) }));
      return { ok: true };
    } catch (error) {
      patch((current) => ({ attachments: current.attachments.filter((item) => item.localId !== localId) }));
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [patch]);
  const uploadFiles = useCallback(async (files: File[]) => {
    const id = stateRef.current.selectedId;
    if (!id) return;
    setUploadError(null);
    for (const source of files) {
      const result = await uploadFile(source, id);
      if (!result.ok) setUploadError({ sessionId: id, message: `${source.name}: ${result.error}` });
    }
  }, [uploadFile, stateRef]);
  useEffect(() => listenForFileDrops(window,
    () => !!stateRef.current.selectedId,
    (files) => { void uploadFiles(files); }, setFileDrag,
  ), [stateRef, uploadFiles]);
  const openDrawing = (background?: DrawingBackground) => {
    const sessionId = stateRef.current.selectedId;
    if (!sessionId) return;
    const draft = findDrawingDraft(drawings, sessionId, background)
      ?? { id: crypto.randomUUID(), sessionId, background };
    setDrawings(current => current.some(item => item.id === draft.id) ? current : [...current, draft]);
    if (document.activeElement instanceof HTMLElement) drawingOpener.current = { sessionId, element: document.activeElement };
    setDrawingId(draft.id);
  };
  const editImage = (event: SyntheticEvent) => {
    if (!stateRef.current.selectedId) return;
    const image = drawingImage(event.target);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    image.focus({ preventScroll: true });
    openDrawing({ src: image.currentSrc || image.src, alt: image.alt });
  };
  const attachDrawing = async (file: File, draft: DrawingDraft) => {
    const result = await uploadFile(file, draft.sessionId);
    if (result.ok) {
      setDrawings(current => current.filter(item => item.id !== draft.id));
      setDrawingId(current => current === draft.id ? null : current);
    }
    return result;
  };
  const removeAttachment = async (attachment: Attachment) => {
    patch((current) => ({ attachments: current.attachments.filter((item) => item.localId !== attachment.localId) }));
    if (attachment.storedName) await api(API.removeUploads.method, API.removeUploads.path({}, { name: attachment.storedName, sessionId: attachment.sessionId })).catch(console.error);
  };

  const controlThread = async (sessionId: string, action: "stop" | "resume", descendants = false) => {
    setPending(true);
    setControlError(null);
    try {
      await submitThreadControl(action === "stop" ? { threadId: sessionId, action, descendants } : { threadId: sessionId, action });
      setStopTarget(null);
    } catch (error) {
      setControlError({ sessionId, message: error instanceof Error ? error.message : String(error) });
    } finally { setPending(false); kick(); }
  };

  const stopThread = (session: Session) => requestStop(session, (id, descendants) => { void controlThread(id, "stop", descendants); }, target => { setControlError(null); setStopTarget(target); });

  const send = async () => {
    const session = selectedSession();
    if (!session || pending) return;
    const action = composerAction(session, prompt);
    if (action === "stop") return stopThread(session);
    const sessionAttachments = stateRef.current.attachments.filter((file) => file.sessionId === session.id);
    if (sessionAttachments.some((file) => file.uploading)) return;
    const attachments = sessionAttachments.filter((file) => file.path);
    const text = prompt.trim();
    if (!text && !attachments.length) return;
    const command = text.startsWith("/") ? state.slashCommands.find((candidate) => candidate.name === text.slice(1).split(/\s/, 1)[0]) : null;
    setControlError(null);
    setPrompt(""); saveDraft(session.id, ""); setPending(true);
    try {
      const attachmentText = attachments.length ? `The following files were attached to this message:\n${attachments.map((file) => `- ${file.path}`).join("\n")}` : "";
      const bodyText = [text, attachmentText].filter(Boolean).join("\n\n");
      if (command && !attachments.length) await api(API.sessionCommand.method, API.sessionCommand.path({ sessionId: session.id }), { requestId: crypto.randomUUID(), name: command.name, args: text.slice(command.name.length + 2).trim() }, 130_000);
      else await api(API.sessionPrompt.method, API.sessionPrompt.path({ sessionId: session.id }), { requestId: crypto.randomUUID(), text: bodyText, delivery: "queue" });
      const sentIds = new Set(attachments.map((file) => file.localId));
      patch((current) => ({ attachments: current.attachments.filter((file) => !sentIds.has(file.localId)) }));
    } catch (error) { setPrompt(text); saveDraft(session.id, text); setControlError({ sessionId: session.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { setPending(false); kick(); }
  };

  useEffect(() => {
    const id = state.selectedId;
    if (!id || !prompt.startsWith("/") || state.slashCommands.length) return;
    api(API.sessionCommands.method, API.sessionCommands.path({ sessionId: id })).then((result) => patch({ slashCommands: result.commands || [{ name: "compact", description: "Compact the current conversation context" }] })).catch(console.error);
  }, [patch, prompt, state.selectedId, state.slashCommands.length]);

  const mutateQueued = async (message: QueuedMessage, route: typeof API.queueItem, edit = false) => {
    const session = selectedSession();
    if (!session) return;
    try {
      const result = await api(route.method, route.path({ sessionId: session.id, workId: message.id }), route.method === "POST" ? {} : undefined);
      if (edit) {
        const text = String(result.text ?? message.text ?? "");
        setPrompt((current) => current.trim() ? `${text}\n\n${current}` : text);
        saveDraft(session.id, text);
      }
    } catch (error) { setControlError({ sessionId: session.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { kick(); }
  };
  const toggleAction = async (id: string) => { try { await api(API.actionToggle.method, API.actionToggle.path({ id }), {}); } finally { kick(); } };
  const toggleGovernor = async (provider: GovernorProvider) => { try { await api(API.governorToggle.method, API.governorToggle.path({ provider }), {}); } finally { kick(); } };

  const sessions = orderedSessions(state);
  const knownSessions = [...state.sessions, ...state.archived, ...state.discovered.filter(discovered => !state.sessions.some(session => session.id === discovered.id) && !state.archived.some(session => session.id === discovered.id))];
  const selected = knownSessions.find((session) => session.id === state.selectedId) ?? null;
  const visibleAttachments = state.attachments.filter((file) => file.sessionId === state.selectedId);
  const action = composerAction(selected, prompt);
  const drawingOpen = drawings.some(draft => draft.id === drawingId && draft.sessionId === state.selectedId);
  useLayoutEffect(() => {
    if (drawingOpen) document.querySelector<HTMLButtonElement>('.drawing-slot:not([hidden]) button[aria-label="Cancel drawing"]')?.focus({ preventScroll: true });
    else if (drawingWasOpen.current && drawingOpener.current?.sessionId === state.selectedId) drawingOpener.current.element.focus({ preventScroll: true });
    drawingWasOpen.current = drawingOpen;
  }, [drawingOpen, drawingId, state.selectedId]);
  const contextEntries = useMemo(() => modelContextEntries(state.context ? JSON.parse(state.context.document) : null), [state.context]);
  const modelCounts = useMemo(() => new Map((state.dashboard?.modelCounts ?? []).map((model) => [model.key, model.count])), [state.dashboard]);
  const dashboard = state.dashboard;
  const selectedActivity = selected?.activity || "idle";
  const selectedTool = selected?.activeTool;
  const title = selected?.name || "Pi Remote";
  const activeOrchestratorCount = orchestratorThreads(knownSessions).filter(working).length;
  const machine = dashboard?.machine;
  const machineText = machine ? `CPU ${machine.cpuPercent ?? "—"}% · GPU ${machine.gpuPercent ?? "—"}% · RAM ${machine.memory?.percentUsed ?? "—"}% · DISK ${machine.disk?.percentUsed ?? "—"}%` : "CPU — · GPU — · RAM — · DISK —";
  const entries = contextEntries;
  const images = useMemo(() => state.images ? new Map(state.images.images.map(image => [image.id, image])) : null, [state.images]);
  const liveThinking = state.liveThinking?.document || "";
  const liveText = state.liveText?.document || "";
  const drawerCounts: Record<DrawerTab, number> = { threads: sessions.length, orchestrator: activeOrchestratorCount, archived: Math.max(state.archivedTotal, state.archived.length), files: rootFileCount };
  const drawerLabels: Record<DrawerTab, string> = { threads: "Threads", orchestrator: "Orchestrator", archived: "Archived", files: "Files" };
  const slashToken = prompt.startsWith("/") && !/\s/.test(prompt) ? prompt.slice(1).toLowerCase() : null;
  const visibleCommands = slashToken === null ? [] : state.slashCommands.filter((command) => command.source === "skill" && !command.name.toLowerCase().includes("mcp") && command.name.toLowerCase().startsWith(slashToken));

  return <div id="app">
    {fileDrag && state.selectedId && <div className="file-drop-overlay" role="status">Drop files to attach to {selected?.name || "this conversation"}</div>}
    {state.drawerOpen && innerWidth < 1000 && <div className="scrim" onClick={() => patch({ drawerOpen: false })} />}
    <aside id="drawer" className={state.drawerOpen ? "open" : ""} aria-label="Navigation">
      <header className="drawer-heading thread-start-heading"><nav className="drawer-tabs" role="tablist" aria-label="Drawer sections">{(["threads", "orchestrator", "archived", "files"] as const).map((tab) => <button key={tab} className="drawer-tab" type="button" role="tab" aria-label={`${drawerLabels[tab]}, ${drawerCounts[tab]}`} title={drawerLabels[tab]} aria-selected={state.drawerTab === tab} onClick={() => patch({ drawerTab: tab })}><DrawerTabIcon tab={tab} /><span className="drawer-tab-count">{drawerCounts[tab]}</span></button>)}</nav>{state.drawerOpen && <ThreadStartMenu starts={dashboard?.threadStarts ?? []} onCreated={selectThread} onSettled={kick} />}</header>
      {state.drawerTab === "threads" && <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorder(event)}><SortableContext items={sessions.map((session) => session.id)} strategy={verticalListSortingStrategy}><div className="thread-list">{sessions.length ? sessions.map((session) => <SortableThreadRow key={session.id} starts={dashboard?.threadStarts ?? []} session={session} selected={state.selectedId === session.id} onSelect={(id) => void selectThread(id)} onArchive={(id) => void archive(id)} onUnarchive={() => {}} />) : <div className="thread-empty">No threads</div>}</div></SortableContext></DndContext>}
      {state.drawerTab === "orchestrator" && <OrchestratorThreadList sessions={knownSessions} selectedId={state.selectedId} onOpen={session => void selectThread(session.id, true, session, "orchestrator")} />}
      {state.drawerTab === "archived" && <div className="thread-list">{state.archived.length ? state.archived.map((session) => <ThreadRow key={session.id} starts={dashboard?.threadStarts ?? []} archived session={session} selected={false} onSelect={() => {}} onArchive={() => {}} onUnarchive={(id) => void unarchive(id)} />) : <div className="thread-empty">No archived threads</div>}{state.archived.length < state.archivedTotal && <button type="button" className="archived-more" onClick={() => void loadOlder()}>Show older · {state.archivedTotal - state.archived.length} more</button>}</div>}
      <FileExplorer hidden={state.drawerTab !== "files"} onRootCount={setRootFileCount} />
      <footer className="drawer-footer">{state.ownerErrors.map(({ id, owner, message }) => <DismissibleError key={id} resetKey={id} role="status" className="connection" message={`${owner}: ${message}`} onDismiss={() => dismissServerError(id)} />)}<MachineControls actions={dashboard?.actions ?? []} governors={dashboard?.governors ?? null} onAction={(id) => void toggleAction(id)} onGovernor={(provider) => void toggleGovernor(provider)} /><EnvironmentControl /><AppUpdateControl /><NotificationControl sessionId={state.selectedId} /><PlanSummary plans={dashboard?.plans ?? []} counts={modelCounts} /><div className="usage-summary muted">{machineText}</div><div className="usage-summary muted" title={__PI_REMOTE_REVISION__}>Client {__PI_REMOTE_REVISION__.slice(0, 12)}</div><DismissibleError className="connection" message={state.offline ? `Offline · ${state.offline}` : ""} /></footer>
    </aside>
    <main id="main" className={drawingOpen ? "drawing-mode" : undefined}><header className="topbar"><button className="icon-button" aria-label="Open navigation" onClick={() => patch({ drawerOpen: true })}>☰</button><div className="top-title">{title}</div><div className="top-state" style={{ color: state.offline ? "var(--danger)" : activityColor(selectedActivity) }}>{state.offline ? "OFFLINE" : state.syncing ? "SYNCING" : activityLabel(selectedActivity, selectedTool ?? "")}</div>{state.offline && <button type="button" onClick={kick} title={state.offline}>Reconnect</button>}<a className="icon-button" aria-label="Open PiStack Meet" title="PiStack Meet" href={`${appPath("meet.html")}?${new URLSearchParams({ user: window.PiRemotePerson.get() })}`} onClick={async (event) => { event.preventDefault(); const environment = await window.KenanRemote?.getState(); location.href = `${appPath("meet.html")}?${new URLSearchParams({ user: window.PiRemotePerson.get(), environment: environment?.id || "" })}`; }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-4v12l-6-4z"/></svg></a><button className="icon-button" aria-label="Open thread settings" disabled={!selected} onClick={() => patch({ settingsOpen: true })}>⚙</button></header>
      {selected?.parentId && <nav className="thread-relations" aria-label="Related threads"><button type="button" onClick={() => void selectThread(selected.parentId!)}>Parent: {knownSessions.find(session => session.id === selected.parentId)?.name || selected.parentId}</button></nav>}
      {!state.selectedId ? <section className="empty-state"><strong>No threads</strong><span>Open the drawer to create one.</span></section> : <section className={`conversation${drawingOpen ? " is-drawing" : ""}`}><div className="scrollback" onClickCapture={editImage} onKeyDownCapture={event => { if (event.key === "Enter" || event.key === " ") editImage(event); }}><div className="scroll-content"><InlineImagesContext.Provider value={images}><ContextTranscript entries={entries} liveThinking={liveThinking} sessionId={state.selectedId || ""} home={dashboard?.home ?? "/"} onEdit={editFrom} />{liveText && <div className="live-answer"><Markdown source={liveText} sessionId={state.selectedId || ""} streaming assistant /><CopyButton text={liveText} label="Copy response" /></div>}<LiveActivity activity={selectedActivity} tool={selectedTool} offline={state.offline} /></InlineImagesContext.Provider></div></div>
        {drawings.map(draft => <div key={draft.id} className="drawing-slot" hidden={!drawingOpen || drawingId !== draft.id}><DrawingCanvas background={draft.background} onAttach={file => attachDrawing(file, draft)} onClose={() => setDrawingId(current => current === draft.id ? null : current)} /></div>)}
        <DismissibleError className="upload-error" dismissLabel="Dismiss thread failure" message={selected?.lastError} resetKey={selected?.lastErrorId ?? selected?.id} onDismiss={selected?.lastErrorId ? () => dismissServerError(selected.lastErrorId!) : undefined} />
        <DismissibleError className="upload-error" dismissLabel="Dismiss upload error" message={uploadError?.sessionId === state.selectedId ? uploadError.message : ""} resetKey={state.selectedId || ""} />
        {selected?.queuedMessages.length ? <div className="message-queue">{selected.queuedMessages.map((message) => <div className="queued-message" key={message.id}><div className="queued-message-copy"><span className="queued-message-label">{message.status}</span><span className="queued-message-preview">{message.text.split("\n").find((line) => line.trim()) || "Attached files"}</span></div><div className="queued-message-actions"><CopyButton text={message.text} className="queued-message-action icon-message-action" />{message.canSteer && <button className="queued-message-action steer-instead" type="button" onClick={() => void mutateQueued(message, API.queueSteer)}>STEER</button>}{message.canHardSteer && <button className="queued-message-action hard-steer" type="button" onClick={() => void mutateQueued(message, API.queueHardSteer)}>HARD STEER</button>}{message.canCancel && <><button className="queued-message-action edit-queued" type="button" onClick={() => void mutateQueued(message, API.queueItem, true)}>EDIT</button><button className="queued-message-action cancel-queued" type="button" onClick={() => void mutateQueued(message, API.queueItem)}>CANCEL</button></>}</div></div>)}</div> : null}
        <DismissibleError className="upload-error" dismissLabel="Dismiss thread error" message={controlError?.sessionId === state.selectedId && !stopTarget ? controlError.message : ""} resetKey={state.selectedId || ""} />
        {selected?.state === "stopped" && <div className="thread-held"><span>{selected.queuedMessages.length ? "Pending messages are held." : "Thread stopped."}</span>{selected.queuedMessages.length > 0 && <button type="button" disabled={pending} onClick={() => void controlThread(selected.id, "resume")}>Resume</button>}</div>}
        {visibleAttachments.length > 0 && <div className="attachments">{visibleAttachments.map((attachment) => <div className={`attachment-chip${attachment.uploading ? " uploading" : ""}`} key={attachment.localId}><span className="attachment-name">{attachment.name}{attachment.uploading ? " · uploading" : ""}</span><button className="attachment-remove" type="button" onClick={() => void removeAttachment(attachment)}>×</button></div>)}</div>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>{visibleCommands.length > 0 && <div className="slash-commands" role="listbox">{visibleCommands.map((command) => <button key={command.name} type="button" className="slash-command" onClick={() => setPrompt(`/${command.name} `)}><strong className="slash-command-name">/{command.name}</strong>{command.description && <span className="slash-command-description">{command.description}</span>}</button>)}</div>}<textarea ref={promptElement} id="prompt" rows={1} maxLength={200000} placeholder={`Message ${selected?.name || "Agent"}`} value={prompt} onChange={(event) => { setPrompt(event.target.value); if (state.selectedId) saveDraft(state.selectedId, event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(hover: hover) and (pointer: fine)").matches) { event.preventDefault(); void send(); } }} /><div className="composer-actions"><label className="composer-icon" aria-label="Attach files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6.5 8.7 14.3a2.5 2.5 0 0 0 3.5 3.5l8.1-8.1a4.5 4.5 0 0 0-6.4-6.4L5.5 11.7a6.5 6.5 0 0 0 9.2 9.2l6.1-6.1"/></svg><input type="file" multiple hidden onChange={(event) => { void uploadFiles([...event.target.files || []]); event.target.value = ""; }} /></label><button className="composer-icon" type="button" aria-label="Paste text document" onClick={() => setPasteSessionId(state.selectedId)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5V4h6v1.5M9 5.5h6M9 5.5H7v15h10v-15h-2M9 10h6m-6 4h6m-6 4h4"/></svg></button><button className="composer-icon drawing-toggle" type="button" aria-label="Draw a picture" title="Draw a picture" onClick={() => openDrawing()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 13 7-9a1.5 1.5 0 0 0-2-2l-9 7 4 4Z"/><path d="M10 9c-3-1-5 1-5 4 0 2-1 3-3 4 4 3 10 2 11-3l1-1"/></svg></button><span className="composer-spacer"/>{voiceState === "live" && <button type="button" onClick={() => void voice.current?.resumePlayback()}>Play Kenan audio</button>}<button id="voice" className={`composer-icon voice${voiceState === "idle" ? "" : ` ${voiceState}`}`} type="button" aria-label={voiceState === "live" ? "Hang up voice" : "Start voice"} title={voiceDetail || undefined} onClick={() => void toggleVoice()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6"/></svg></button><button id="action" className={`composer-icon send${action !== "send" ? " abort" : ""}`} type="submit" disabled={!selected || pending || (action === "send" && visibleAttachments.some((file) => file.uploading))} aria-label={action === "send" ? "Send message" : "Stop thread"}><svg className="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/></svg><svg className="stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button></div></form>
      </section>}
    </main>
    {stopTarget && <ThreadStopDialog session={stopTarget} pending={pending} error={controlError?.sessionId === stopTarget.id ? controlError.message : ""} onStop={descendants => void controlThread(stopTarget.id, "stop", descendants)} onClose={() => setStopTarget(null)} />}
    {selected && <SettingsPanel key={selected.id} session={selected} sessions={knownSessions} open={state.settingsOpen} onClose={() => patch({ settingsOpen: false })} onOpenThread={session => void selectThread(session.id, true, session, "orchestrator")} />}
    {pasteSessionId && <PasteTextDialog name={pasteName} content={pasteContent} onNameChange={setPasteName} onContentChange={setPasteContent} onAttach={file => uploadFile(file, pasteSessionId)} onClose={() => setPasteSessionId(null)} />}
  </div>;
}

function orderedSessions(state: Pick<AppState, "sessions" | "pendingOrder">) {
  return conversationThreads(state.pendingOrder ? threadsInOrder(state.sessions, state.pendingOrder) : state.sessions);
}
