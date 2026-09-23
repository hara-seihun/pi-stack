import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { API } from "../../server/api";
import { appPath, appStorageKey } from "./app-path";
import type { GovernorProvider, InlineImageSnapshot, StreamEvent } from "../../server/protocol";
import { ClientCache } from "./client-cache";
import { api, piFetch, registerUnlockHandler } from "./client";
import { fetchPersonChooser, reportWebReady } from "./native";
import { useChatDrawing } from "./chat-drawing";
import type { ReplyTarget } from "./message-reply";
import type { MessagingSnapshot } from "../../server/messaging/protocol";
import { applySessionDelta, inboxRows, reconcileDiscoveredSessions, selectedAiId, selectionAfterSync, type Chat, type ChatId } from "./chats";
import { SignInDialog } from "./SignInDialog";
import { DismissibleError } from "./dismissible-error";
import { dismissServerError } from "./error-feedback";
import { deliverIdleNotifications, readIdleCursor, saveIdleCursor, takeNotificationTarget, retainNotificationTarget } from "./notifications";
import { listenForFileDrops } from "./file-drop";
import { ensureMarkdown } from "./markdown-engine";
import { createStreamClient, type StreamClient } from "./stream";
import { working } from "./thread-state";
import { requestStop, submitThreadControl, ThreadStopDialog } from "./thread-controls";
import { LazyChatPicker } from "./chat-picker-lazy";
import type { ChatPickerHandle } from "./thread-start-menu";
import type { Attachment, Bootstrap, ContextEntry, Dashboard, QueuedMessage, Session, SlashCommand } from "./types";
import { Shell, TabNav } from "./app/Shell";
import { useLayout } from "./app/layout";
import { messagingAvatarUrl } from "./messaging-avatar";
import { MessagingCallProvider, SignalCallButton } from "./messaging-call";
import { RequestIndicator } from "./RequestIndicator";
import { hideClosing, reconcileCloses, withClose, withoutClose, type PendingCloses } from "./pending-closes";
import { shouldUndoClose, UndoCloses } from "./undo-closes";
import { toast, ToastViewport } from "./toasts";
import { useSystemBack } from "./app/system-back";
import { back, currentRoute, navigate, routeChatId, routeHome, routeThreadId, useRoute, withoutPanel, type Panel, type Route, type Tab } from "./app/routes";
import { Inbox } from "./features/chats/Inbox";
import { ConversationHeader, ConversationScreen, type Delivery } from "./features/conversation/ConversationScreen";
import { ItemBodies, ItemBodiesContext } from "./features/conversation/item-bodies";
import { createLiveText, type LiveTextStore } from "./features/conversation/live-text";
import { ThreadDirectoryProvider, type ThreadDirectory } from "./features/conversation/thread-chips";
import { entriesFromHeads, WAITING_ENTRY } from "./features/conversation/transcript-entries";
import { forgetPrefetchedTranscripts, prefetchTranscript, prefetchUnreadThreads, takePrefetchedWindow } from "./features/conversation/transcript-prefetch";
import { applyTranscriptEvent, hasEarlier, loadEarlier, transcriptCursor, type TranscriptWindow } from "./features/conversation/transcript-store";
import type { QueueAction } from "./features/queue/delivery";
import { threadStatus } from "./features/status/thread-status";
import { speech } from "./speech";
import { SpeechBar } from "./SpeechBar";

// What the first paint does not need waits for the screen that shows it. Each
// import below is one chunk: a screen or a feature, never a component at a
// time, so opening Files or the inspector is one request rather than six.
const MessagingConversations = lazy(() => import("./Messages").then(module => ({ default: module.MessagingConversations })));
const PasteTextDialog = lazy(() => import("./PasteTextDialog").then(module => ({ default: module.PasteTextDialog })));
const InspectorSheet = lazy(() => import("./features/inspector/InspectorSheet").then(module => ({ default: module.InspectorSheet })));
const QueueSheet = lazy(() => import("./features/queue/QueueSheet").then(module => ({ default: module.QueueSheet })));
const WorkersTree = lazy(() => import("./features/workers/WorkersTree").then(module => ({ default: module.WorkersTree })));
const FilesScreen = lazy(() => import("./features/files/FilesScreen").then(module => ({ default: module.FilesScreen })));
const MachineTab = lazy(() => import("./features/machine/MachineTab").then(module => ({ default: module.MachineTab })));

function Loading({ label }: { label: string }) {
  return <section className="empty-state" aria-busy="true"><strong>{label}</strong></section>;
}

// Everything the server owns arrives on one push stream. Sections replace
// wholesale, sessions arrive as per-id deltas, and the transcript arrives as
// item heads; the client never patches a server-owned value from a mutation
// response. What remains local is the view (the route), the window of items it
// holds, and composer scratch.
interface AppState {
  selectedChatId: ChatId | null;
  messaging: MessagingSnapshot;
  sessions: Session[];
  /** Threads opened from the picker or a notification before a delta carries them. */
  discovered: Session[];
  archivedTotal: number;
  dashboard: Dashboard | null;
  bootstrap: Bootstrap | null;
  transcript: TranscriptWindow | null;
  images: InlineImageSnapshot | null;
  attachments: Attachment[];
  slashCommands: SlashCommand[];
  offline: string;
  ownerErrors: { id: string; owner: string; message: string }[];
  syncing: boolean;
  loadingEarlier: boolean;
  earlierError: string;
}

const initialState: AppState = {
  selectedChatId: null, messaging: { version: 0, backends: [], conversations: [], calls: [] },
  sessions: [], discovered: [], archivedTotal: 0, dashboard: null, bootstrap: null,
  transcript: null, images: null,
  attachments: [], slashCommands: [], offline: "", ownerErrors: [], syncing: true,
  loadingEarlier: false, earlierError: "",
};

function draftKey(id: string) { return appStorageKey(`pi-remote-draft:${window.PiRemotePerson.get()}:${id}`); }
function loadDraft(id: string) { try { return localStorage.getItem(draftKey(id)) || ""; } catch { return ""; } }
function saveDraft(id: string, value: string) { try { value ? localStorage.setItem(draftKey(id), value) : localStorage.removeItem(draftKey(id)); } catch {} }
function replyKey(id: string) { return appStorageKey(`pi-remote-reply:${window.PiRemotePerson.get()}:${id}`); }
function loadReply(id: string): ReplyTarget | null {
  try {
    const value = JSON.parse(localStorage.getItem(replyKey(id)) || "null");
    return typeof value?.identity?.id === "string" && typeof value?.text === "string" ? value as ReplyTarget : null;
  } catch { return null; }
}
function saveReply(id: string, value: ReplyTarget | null) {
  try { value ? localStorage.setItem(replyKey(id), JSON.stringify(value)) : localStorage.removeItem(replyKey(id)); } catch {}
}

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
      <h2 id="unlock-title">Pi Remote</h2>
      {requiresKey && <p>Your folder key stays on this device.</p>}
      {people.length > 0 && <div className="unlock-field"><label htmlFor="unlock-person">Person</label><select id="unlock-person" value={selectedUser} onChange={(event) => { setSelectedUser(event.target.value); setKey(""); window.PiRemotePerson?.set(event.target.value); }}>{people.map((person) => <option key={person.user} value={person.user}>{person.displayName || person.user}</option>)}</select></div>}
      {requiresKey && <div className="unlock-field"><label htmlFor="unlock-key">Folder key</label><input id="unlock-key" type="password" autoComplete="current-password" spellCheck={false} required value={key} onChange={(event) => setKey(event.target.value)} /></div>}
      <DismissibleError className="unlock-error" message={message} />
      <div className="unlock-actions"><button className="accent" type="submit">{requiresKey ? "Unlock" : "Continue"}</button></div>
    </form>
  </dialog>;
}

export default function App() {
  const [person, setPerson] = useState(window.PiRemotePerson.get());
  const [lockGeneration, setLockGeneration] = useState(0);
  useEffect(reportWebReady, []);
  useEffect(() => {
    const changed = () => setPerson(window.PiRemotePerson.get());
    const authChanged = () => { if (!window.PiRemotePerson.session()) setLockGeneration(current => current + 1); };
    window.addEventListener("pi-person", changed);
    window.addEventListener("pi-auth", authChanged);
    return () => { window.removeEventListener("pi-person", changed); window.removeEventListener("pi-auth", authChanged); };
  }, []);
  return <><RequestIndicator /><SignInDialog /><UnlockDialog /><RemoteApp key={`${person}:${lockGeneration}`} /></>;
}

/**
 * The only subscriber to the live store. Everything else about the
 * conversation comes from props, so a live frame re-renders this component and
 * nothing above it: not the inbox, not the worker tree, not the tab badges.
 */
const LiveConversation = memo(function LiveConversation({ live, ...props }: { live: LiveTextStore } & Omit<Parameters<typeof ConversationScreen>[0], "liveText" | "liveThinking" | "thinkingActive">) {
  const { text, thinking } = useSyncExternalStore(live.subscribe, live.snapshot, live.snapshot);
  return <ConversationScreen {...props} liveText={text} liveThinking={thinking} thinkingActive={props.session.activity === "thinking" || !!thinking} />;
});

function RemoteApp() {
  const person = useRef(window.PiRemotePerson.get()).current;
  // Windows fetched for another person or environment mean nothing here.
  useEffect(() => forgetPrefetchedTranscripts, []);
  const { state, stateRef, patch } = useStableState();
  const layout = useLayout();
  const route = useRoute();
  const routeChat = routeChatId(route);
  const selectionKey = `${route.tab}:${routeChat ?? ""}`;
  const [listSelection, setListSelection] = useState({ key: "", visible: false });
  const onSelectedVisibleChange = useCallback((visible: boolean) => {
    setListSelection(current => current.key === selectionKey && current.visible === visible ? current : { key: selectionKey, visible });
  }, [selectionKey]);
  const showConversationIdentity = layout === "phone" || listSelection.key !== selectionKey || !listSelection.visible;
  const aiId = routeThreadId(route);
  const messagingActive = routeChat?.startsWith("human:") ?? false;
  const humanConversation = state.messaging.conversations.find(item => `human:${item.id}` === routeChat && item.current) ?? null;
  const [chatError, setChatError] = useState("");
  const [closing, setClosing] = useState<PendingCloses>(() => new Set());
  const undoCloses = useMemo(() => new UndoCloses(), []);
  const undoState = useSyncExternalStore(undoCloses.subscribe, undoCloses.snapshot, undoCloses.snapshot);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const replyRef = useRef<ReplyTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [stopTarget, setStopTarget] = useState<Session | null>(null);
  const [controlError, setControlError] = useState<{ sessionId: string; message: string } | null>(null);
  const [pasteSessionId, setPasteSessionId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{ sessionId: string; message: string } | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const [pasteName, setPasteName] = useState("pasted-text.txt");
  const [pasteContent, setPasteContent] = useState("");
  const [workersFilter, setWorkersFilter] = useState<"active" | "all">("active");
  const [voiceState, setVoiceState] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [voiceDetail, setVoiceDetail] = useState("");
  const voice = useRef<VoiceSession | null>(null);
  const stream = useRef<StreamClient | null>(null);
  // Live answer and thinking text, thirty frames a second, kept out of the
  // app's state so only the open conversation re-renders for them.
  const resync = useRef(() => {});
  const live = useRef<LiveTextStore | null>(null);
  live.current ??= createLiveText(() => resync.current());
  const panelPushed = useRef(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  // Reconnect now. The stream pushes on its own, so this only matters when it
  // is not carrying anything: after a mutation the server sends the change.
  const kick = useCallback(() => { if (stream.current?.state() !== "open") stream.current?.reconnect(); }, []);
  const reconnect = useCallback(() => { stream.current?.reconnect(); }, []);
  resync.current = reconnect;
  const liveText = live.current;
  const selectedSession = useCallback(() => {
    const current = stateRef.current;
    return [...current.sessions, ...current.discovered].find((session) => session.id === selectedAiId(current)) ?? null;
  }, [stateRef]);
  useEffect(() => {
    const onVisible = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, []);
  useEffect(() => () => { void voice.current?.stop(); }, []);
  useEffect(() => {
    voice.current?.stop();
    voice.current = null;
    setVoiceState("idle");
    setVoiceDetail("");
  }, [aiId, messagingActive]);

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

  const cache = useMemo(() => {
    let scope: Promise<string> | undefined;
    return new ClientCache(() => scope ??= (async () => {
      const environment = await window.KenanRemote?.getState();
      return `${person}:${environment?.id || location.origin}`;
    })());
  }, [person]);
  useEffect(() => () => cache.dispose(), [cache]);

  // Navigation. Opening anything pushes history so back returns to where the
  // person was; panels remember whether they pushed so closing a deep-linked
  // panel does not leave the app.
  const openChat = useCallback((chat: ChatId, options: { tab?: Tab; replace?: boolean } = {}) => {
    const tab = options.tab ?? (route.tab === "workers" && chat.startsWith("ai:") ? "workers" : "chats");
    if (tab === "workers") navigate({ tab: "workers", thread: chat.slice(3), panel: null }, options);
    else navigate({ tab: "chats", chat, panel: null }, options);
  }, [route.tab]);
  const openThreadId = useCallback((id: string, tab?: Tab) => openChat(`ai:${id}`, { tab }), [openChat]);
  // Opening a thread from inside a panel used to close the panel and navigate
  // in the same tick. `history.back()` settles later, so its popstate landed
  // after the push and returned the person to the thread they came from: a
  // worker opened from the inspector never appeared. One navigation replaces
  // the panel entry instead of popping it.
  const openThreadFromPanel = useCallback((id: string) => {
    const replace = panelPushed.current;
    panelPushed.current = false;
    openChat(`ai:${id}`, { replace });
  }, [openChat]);
  const openPanel = useCallback((panel: Panel) => {
    if (!("panel" in route)) return;
    panelPushed.current = true;
    navigate({ ...route, panel });
  }, [route]);
  const closePanel = useCallback(() => {
    if (panelPushed.current) { panelPushed.current = false; back(); }
    else navigate(withoutPanel(route), { replace: true });
  }, [route]);
  const closeDetail = useCallback(() => {
    if (history.length > 1) back();
    else navigate(routeHome(route), { replace: true });
  }, [route]);
  useSystemBack({ closePanel, closeDetail });
  const selectTab = useCallback((tab: Tab) => {
    if (tab === route.tab) navigate(routeHome(route));
    else if (tab === "chats") navigate({ tab, chat: null, panel: null });
    else if (tab === "workers") navigate({ tab, thread: null, panel: null });
    else if (tab === "files") navigate({ tab, path: null });
    else navigate({ tab });
  }, [route]);

  // The route decides the selection; this effect does the work of selecting.
  const selectionGeneration = useRef(0);
  const selectThread = useCallback(async (id: string, discovered?: Session, signal?: AbortSignal) => {
    const generation = ++selectionGeneration.current;
    const candidate = discovered ?? [...stateRef.current.sessions, ...stateRef.current.discovered].find(item => item.id === id);
    if (candidate?.archivedAt) await api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: id }), {});
    if (signal?.aborted || generation !== selectionGeneration.current) return;
    setStopTarget(null);
    setPasteSessionId(null);
    liveText.reset();
    const remembered = cache.thread(id);
    patch((current) => ({
      selectedChatId: `ai:${id}`, transcript: remembered?.transcript ?? null, images: remembered?.images ?? null, slashCommands: [], syncing: true,
      loadingEarlier: false, earlierError: "",
      discovered: discovered && ![...current.sessions, ...current.discovered].some(session => session.id === discovered.id)
        ? [...current.discovered, discovered] : current.discovered,
    }));
    setPrompt(loadDraft(id));
    replyRef.current = loadReply(id);
    setReply(replyRef.current);
    kick();
    // Memory paints synchronously. Disk and speculative fetches may fill a
    // cold opening, but never replace a newer stream frame.
    if (remembered?.transcript) return;
    let painted: TranscriptWindow | null = null;
    const usable = () => !signal?.aborted && selectedAiId(stateRef.current) === id && generation === selectionGeneration.current;
    void cache.restoreThread(id).then((window) => {
      if (window && usable() && !stateRef.current.transcript) {
        painted = window;
        cache.rememberThread(id, { transcript: window });
        patch({ transcript: window });
      }
    });
    const prefetched = await takePrefetchedWindow(id);
    if (prefetched && usable() && (!stateRef.current.transcript || stateRef.current.transcript === painted)) {
      cache.rememberThread(id, { transcript: prefetched });
      patch({ transcript: prefetched });
    }
  }, [cache, kick, liveText, patch, stateRef]);
  useLayoutEffect(() => {
    if (routeChat === stateRef.current.selectedChatId) return;
    if (!routeChat) { liveText.reset(); patch({ selectedChatId: null, transcript: null, images: null }); return; }
    if (routeChat.startsWith("ai:")) void selectThread(routeChat.slice(3)).catch(cause => setChatError(String(cause)));
    else { setStopTarget(null); setPasteSessionId(null); liveText.reset(); patch({ selectedChatId: routeChat, transcript: null, images: null, slashCommands: [] }); kick(); }
  }, [routeChat, selectThread, patch, kick, liveText, stateRef]);

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
        } else {
          // The window is on its way before the route changes.
          prefetchTranscript(target.sessionId);
          openThreadId(target.sessionId, "chats");
        }
      } catch (cause) { patch({ offline: `Could not open notification: ${String(cause)}` }); }
    };
    void openNotification();
    window.addEventListener("pi-notification", openNotification);
    return () => window.removeEventListener("pi-notification", openNotification);
  }, [openThreadId, patch]);

  // One stream carries every section. Session-scoped frames for a thread the
  // person left are dropped by the client before they reach this handler.
  const notificationsSubscribed = useRef(false);
  const carrying = useRef(false);
  const arrived = useRef(false);
  useEffect(() => {
    const handle = (event: StreamEvent) => {
      carrying.current = true;
      switch (event.type) {
        case "hello":
        case "bootstrap": {
          undoCloses.setScope(`${person}:${event.bootstrap.environmentId}`);
          patch({ bootstrap: event.bootstrap, syncing: false });
          speech.configure(event.bootstrap.speech);
          if (event.type === "hello" && !notificationsSubscribed.current && event.bootstrap.environmentId) {
            notificationsSubscribed.current = true;
            stream.current?.update({ notificationsAfter: readIdleCursor(person, event.bootstrap.environmentId) });
          }
          break;
        }
        case "state": {
          const current = stateRef.current;
          const sessions = applySessionDelta(current.sessions, event);
          for (const id of event.removed) cache.forgetThread(id);
          const update: Partial<AppState> = {
            sessions,
            archivedTotal: event.archivedTotal,
            ownerErrors: event.ownerErrors ?? [],
            discovered: reconcileDiscoveredSessions(current.discovered, sessions, event),
            syncing: false,
          };
          // A thread closed on another device leaves this client's view too.
          const closed = selectionAfterSync(current.selectedChatId, current, { sessions, messaging: current.messaging }) !== current.selectedChatId;
          if (closed) { liveText.reset(); Object.assign(update, { selectedChatId: null, transcript: null, images: null }); }
          patch(update);
          if (closed) navigate(routeHome(currentRoute()), { replace: true });
          // The threads that settled while the person was away are the ones
          // they open; their windows are worth having before the tap, on a
          // connection that is not counting bytes.
          if (!arrived.current) {
            arrived.current = true;
            prefetchUnreadThreads(sessions.filter(session => session.id !== routeThreadId(currentRoute())));
          }
          break;
        }
        case "messaging": {
          const current = stateRef.current;
          const update: Partial<AppState> = { messaging: event.snapshot, syncing: false };
          const closed = selectionAfterSync(current.selectedChatId, current, { sessions: current.sessions, messaging: event.snapshot }) !== current.selectedChatId;
          if (closed) { liveText.reset(); Object.assign(update, { selectedChatId: null, transcript: null, images: null }); }
          patch(update);
          if (closed) navigate(routeHome(currentRoute()), { replace: true });
          break;
        }
        case "dashboard": patch({ dashboard: event.dashboard }); break;
        case "transcript": {
          const transcript = applyTranscriptEvent(stateRef.current.transcript, event);
          patch({ transcript, syncing: false, earlierError: "" });
          stream.current?.remember({ transcript: transcriptCursor(transcript) });
          cache.rememberThread(event.sessionId, { transcript });
          break;
        }
        // Live frames do not touch the app's state: the conversation that
        // shows them subscribes to this store on its own.
        case "live": liveText.apply(event); break;
        case "images":
          cache.rememberThread(event.sessionId, { images: event.snapshot });
          patch({ images: event.snapshot });
          break;
        case "notifications": {
          deliverIdleNotifications(event.feed);
          const environment = stateRef.current.bootstrap?.environmentId;
          if (environment) saveIdleCursor(person, environment, event.feed.cursor);
          stream.current?.remember({ notificationsAfter: event.feed.cursor });
          break;
        }
        case "error": patch({ offline: event.message }); break;
      }
    };
    const opening = currentRoute();
    const client = createStreamClient({
      subscription: {
        session: routeThreadId(opening),
        viewing: document.visibilityState === "visible" && !!routeThreadId(opening),
        dashboard: opening.tab === "machine",
      },
      onEvent: handle,
      onStatus: (status) => {
        if (status.state !== "open") carrying.current = false;
        patch({
          offline: status.state === "offline" ? status.error || "Offline" : "",
          syncing: status.state !== "open" || !carrying.current,
        });
      },
    });
    stream.current = client;
    client.start();
    return () => {
      client.stop();
      stream.current = null;
    };
  }, [cache, liveText, patch, person, stateRef, undoCloses]);

  // What the stream carries follows the route: the open thread, whether the
  // person can see it, and the Machine screen only while it is showing.
  useEffect(() => {
    const client = stream.current;
    if (!client) return;
    const held = client.subscription();
    const next = {
      session: aiId,
      viewing: visible && !messagingActive && !!aiId,
      thinking: false,
      dashboard: route.tab === "machine",
    };
    const same = (held.session ?? null) === next.session && !!held.viewing === next.viewing && !!held.dashboard === next.dashboard && !held.thinking;
    if (same) return;
    // A different thread starts a fresh window; the server decides what to send.
    client.update(held.session === next.session ? next : { ...next, transcript: null });
  }, [aiId, messagingActive, route.tab, visible]);

  const showEarlier = useCallback(() => {
    const id = selectedAiId(stateRef.current);
    const window = stateRef.current.transcript;
    if (!id || !window || stateRef.current.loadingEarlier) return;
    patch({ loadingEarlier: true, earlierError: "" });
    void loadEarlier(id, window).then((result) => {
      if (selectedAiId(stateRef.current) !== id) return;
      cache.rememberThread(id, { transcript: result.window });
      patch({ transcript: result.window, loadingEarlier: false });
      stream.current?.remember({ transcript: transcriptCursor(result.window) });
    }, (cause: unknown) => {
      if (selectedAiId(stateRef.current) !== id) return;
      patch({ loadingEarlier: false, earlierError: cause instanceof Error ? cause.message : String(cause) });
    });
  }, [cache, patch, stateRef]);

  const thinkingOpen = useCallback((open: boolean) => {
    stream.current?.update({ thinking: open });
    if (!open) liveText.clearThinking();
  }, [liveText]);

  // A press starts before the tap lands, and the conversation needs its newest
  // window either way: ask for it now so it paints from the answer, and start
  // the Markdown renderer in the same beat since the thread will want it.
  const prefetchThread = useCallback((id: string) => {
    if (id === selectedAiId(stateRef.current)) return;
    if (!cache.thread(id)?.transcript) prefetchTranscript(id);
    void ensureMarkdown().catch(console.error);
  }, [cache, stateRef]);
  const prefetchChat = useCallback((chat: Chat) => { if (chat.kind === "ai") prefetchThread(chat.session.id); }, [prefetchThread]);
  const prefetchSession = useCallback((session: Session) => prefetchThread(session.id), [prefetchThread]);

  const selectChat = useCallback(async (chat: Chat, signal?: AbortSignal) => {
    if (chat.kind === "ai") {
      patch(current => ({ discovered: [...current.sessions, ...current.discovered].some(session => session.id === chat.session.id) ? current.discovered : [...current.discovered, chat.session] }));
      if (chat.session.archivedAt) await api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: chat.session.id }), {});
      if (signal?.aborted) return;
      openChat(chat.id, { tab: "chats" });
    } else {
      if (!chat.conversation.current) await api(API.messagingOpen.method, API.messagingOpen.path(), { backendId: chat.conversation.backendId, target: chat.conversation.externalId });
      if (signal?.aborted) return;
      openChat(chat.id, { tab: "chats" });
      kick();
    }
  }, [kick, openChat, patch]);
  const closeChat = useCallback(async (chat: Chat) => {
    if (undoCloses.isBusy(chat.id)) return;
    setClosing(current => withClose(current, chat.id));
    if (stateRef.current.selectedChatId === chat.id) {
      liveText.reset();
      patch({ selectedChatId: null, transcript: null, images: null });
      navigate(routeHome(route), { replace: true });
    }
    const result = await undoCloses.close(chat, () => chat.kind === "ai"
      ? api(API.archiveSession.method, API.archiveSession.path({ sessionId: chat.session.id }))
      : api(API.messagingClose.method, API.messagingClose.path({ conversationId: chat.conversation.id })));
    if (result?.ok && chat.kind === "ai") cache.forgetThread(chat.session.id);
    if (!result?.ok) {
      setClosing(current => withoutClose(current, chat.id));
      if (result) setChatError(result.error);
    }
    kick();
  }, [cache, kick, liveText, patch, route, stateRef, undoCloses]);
  const undoClose = useCallback(async () => {
    const chat = undoCloses.snapshot().entries.at(-1)?.chat;
    const result = await undoCloses.undo(item => item.kind === "ai"
      ? api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: item.session.id }), {})
      : api(API.messagingOpen.method, API.messagingOpen.path(), { backendId: item.conversation.backendId, target: item.conversation.externalId }));
    if (result?.ok && chat) setClosing(current => withoutClose(current, chat.id));
    if (result) kick();
  }, [kick, undoCloses]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!undoCloses.snapshot().entries.length || undoCloses.snapshot().restoring || !shouldUndoClose(event)) return;
      event.preventDefault();
      void undoClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoClose, undoCloses]);
  useEffect(() => {
    const entry = undoState.entries.at(-1);
    if (!entry || undoState.restoring) return;
    const description = entry.chat.kind === "ai" ? "Undo restores the chat, not stopped work." : "Restore this chat to your inbox.";
    const show = undoState.error ? toast.error : toast;
    const id = show(undoState.error ? `Could not restore ${entry.chat.title}` : `Closed ${entry.chat.title}`, {
      description: undoState.error || description,
      action: { label: undoState.error ? "Retry Undo" : "Undo", onClick: () => { void undoClose(); } },
    });
    return () => { toast.dismiss(id); };
  }, [undoState, undoClose]);
  const openInboxChat = useCallback((chat: Chat) => { void selectChat(chat).catch(cause => setChatError(String(cause))); }, [selectChat]);
  const closeInboxChat = useCallback((chat: Chat) => { void closeChat(chat); }, [closeChat]);
  const chatPicker = useRef<ChatPickerHandle>(null);
  const searchArchived = useCallback((query: string) => { chatPicker.current?.open({ kind: "archived", query }); }, []);
  const openWorker = useCallback((session: Session) => openThreadId(session.id, "workers"), [openThreadId]);

  const editFrom = useCallback(async (entry: ContextEntry) => {
    const id = selectedAiId(stateRef.current);
    if (!id || pending) return;
    setPending(true);
    try {
      const result = await api(API.sessionFork.method, API.sessionFork.path({ sessionId: id }), { requestId: crypto.randomUUID(), messageTimestamp: entry.messageTimestamp }, 45_000);
      if (selectedAiId(stateRef.current) !== id) return;
      const text = String(result.text ?? entry.text ?? "");
      setPrompt(text); saveDraft(id, text);
      // The fork starts a new generation; drop the window and take the server's.
      cache.forgetThread(id);
      patch({ transcript: null });
      stream.current?.update({ transcript: null });
    } finally { setPending(false); kick(); }
  }, [cache, kick, patch, pending, stateRef]);

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
    const id = selectedAiId(stateRef.current);
    if (!id) return;
    setUploadError(null);
    for (const source of files) {
      const result = await uploadFile(source, id);
      if (!result.ok) setUploadError({ sessionId: id, message: `${source.name}: ${result.error}` });
    }
  }, [uploadFile, stateRef]);
  useEffect(() => listenForFileDrops(window,
    () => !!selectedAiId(stateRef.current),
    (files) => { void uploadFiles(files); }, setFileDrag,
  ), [stateRef, uploadFiles]);
  const drawing = useChatDrawing(aiId, uploadFile);
  const removeAttachment = async (attachment: Attachment) => {
    patch((current) => ({ attachments: current.attachments.filter((item) => item.localId !== attachment.localId) }));
    if (attachment.storedName) await api(API.removeUploads.method, API.removeUploads.path({}, { name: attachment.storedName, sessionId: attachment.sessionId })).catch(console.error);
  };
  const attachPath = async (path: string) => {
    const id = selectedAiId(stateRef.current);
    if (!id) return;
    const name = path.split("/").filter(Boolean).at(-1) || "file";
    patch(current => ({ attachments: [...current.attachments, { localId: crypto.randomUUID(), name, path, storedName: null, sessionId: id, uploading: false }] }));
    openChat(`ai:${id}`, { tab: "chats" });
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

  const send = async (delivery: Delivery) => {
    const session = selectedSession();
    if (!session || pending) return;
    const sessionAttachments = stateRef.current.attachments.filter((file) => file.sessionId === session.id);
    if (sessionAttachments.some((file) => file.uploading)) return;
    const attachments = sessionAttachments.filter((file) => file.path);
    const text = prompt.trim();
    if (!text && !attachments.length) return;
    const selectedReply = replyRef.current;
    const command = text.startsWith("/") ? state.slashCommands.find((candidate) => candidate.name === text.slice(1).split(/\s/, 1)[0]) : null;
    setControlError(null);
    setPrompt(""); saveDraft(session.id, ""); setPending(true);
    try {
      const attachmentText = attachments.length ? `The following files were attached to this message:\n${attachments.map((file) => `- ${file.path}`).join("\n")}` : "";
      const bodyText = [text, attachmentText].filter(Boolean).join("\n\n");
      if (command && !attachments.length && !selectedReply) await api(API.sessionCommand.method, API.sessionCommand.path({ sessionId: session.id }), { requestId: crypto.randomUUID(), name: command.name, args: text.slice(command.name.length + 2).trim() }, 130_000);
      else await api(API.sessionPrompt.method, API.sessionPrompt.path({ sessionId: session.id }), { requestId: crypto.randomUUID(), text: bodyText, delivery: session.state === "running" ? delivery : "queue", replyTo: selectedReply?.identity.id });
      if (replyRef.current === selectedReply) {
        replyRef.current = null;
        saveReply(session.id, null);
        if (selectedAiId(stateRef.current) === session.id) setReply(null);
      }
      const sentIds = new Set(attachments.map((file) => file.localId));
      patch((current) => ({ attachments: current.attachments.filter((file) => !sentIds.has(file.localId)) }));
    } catch (error) { if (selectedAiId(stateRef.current) === session.id) setPrompt(text); saveDraft(session.id, text); setControlError({ sessionId: session.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { setPending(false); kick(); }
  };

  useEffect(() => {
    const id = aiId;
    if (!id || !prompt.startsWith("/") || state.slashCommands.length) return;
    api(API.sessionCommands.method, API.sessionCommands.path({ sessionId: id })).then((result) => patch({ slashCommands: result.commands || [{ name: "compact", description: "Compact the current conversation context" }] })).catch(console.error);
  }, [patch, prompt, aiId, state.slashCommands.length]);

  const queueAction = async (message: QueuedMessage, action: QueueAction) => {
    const session = selectedSession();
    if (!session) return;
    const route = action === "steer" ? API.queueSteer : action === "hardSteer" ? API.queueHardSteer : API.queueItem;
    try {
      const result = await api(route.method, route.path({ sessionId: session.id, workId: message.id }), route.method === "POST" ? {} : undefined);
      if (action === "edit") {
        const text = String(result.text ?? message.text ?? "");
        setPrompt((current) => current.trim() ? `${text}\n\n${current}` : text);
        saveDraft(session.id, text);
        closePanel();
      }
    } catch (error) { setControlError({ sessionId: session.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { kick(); }
  };
  const toggleAction = async (id: string) => { setPendingAction(id); try { await api(API.actionToggle.method, API.actionToggle.path({ id }), {}); } finally { setPendingAction(null); kick(); } };
  const toggleGovernor = async (provider: GovernorProvider) => { setPendingAction(provider); try { await api(API.governorToggle.method, API.governorToggle.path({ provider }), {}); } finally { setPendingAction(null); kick(); } };

  const dashboard = state.dashboard;
  const threadStarts = useMemo(() => state.bootstrap?.threadStarts ?? [], [state.bootstrap]);
  const home = state.bootstrap?.home ?? "/";
  const listedRows = useMemo(() => inboxRows(state.sessions, threadStarts, state.messaging), [state.sessions, threadStarts, state.messaging]);
  useEffect(() => { setClosing(current => reconcileCloses(current, listedRows.map(row => row.chat.id))); }, [listedRows]);
  const rows = useMemo(() => hideClosing(listedRows, closing), [listedRows, closing]);
  const knownSessions = useMemo(() => [...state.sessions, ...state.discovered.filter(discovered => !state.sessions.some(session => session.id === discovered.id))], [state.sessions, state.discovered]);
  const selected = knownSessions.find((session) => session.id === aiId) ?? null;
  const ancestors = useMemo(() => {
    const chain: Session[] = [];
    let cursor = selected?.parentId ? knownSessions.find(session => session.id === selected.parentId) : undefined;
    while (cursor && chain.length < 8) { chain.unshift(cursor); cursor = cursor.parentId ? knownSessions.find(session => session.id === cursor!.parentId) : undefined; }
    return chain;
  }, [selected, knownSessions]);
  const visibleAttachments = state.attachments.filter((file) => file.sessionId === aiId);
  const contextEntries = useMemo(() => {
    const heads = state.transcript?.items ?? [];
    return heads.length ? entriesFromHeads(heads) : [WAITING_ENTRY];
  }, [state.transcript]);
  const bodies = useMemo(() => aiId ? new ItemBodies(aiId, undefined, cache) : null, [aiId, cache]);
  // The newest head of a window, and of every update, carries its body when it
  // is small. Taking it here is what lets the step a person opens first render
  // whole without a request.
  useEffect(() => { bodies?.accept(state.transcript?.items ?? []); }, [bodies, state.transcript]);
  const modelCounts = useMemo(() => new Map((dashboard?.modelCounts ?? []).map((model) => [model.key, model.count])), [dashboard]);
  const images = useMemo(() => state.images ? new Map(state.images.images.map(image => [image.id, image])) : null, [state.images]);
  const humanBackend = state.messaging.backends.find(item => item.id === humanConversation?.backendId);
  // The tree shows every thread that is a worker or has workers, including
  // the person's own conversation roots that spawned them.
  const workerSessions = useMemo(() => {
    const live = knownSessions.filter(session => !session.archivedAt);
    const parents = new Set(live.map(session => session.parentId).filter(Boolean));
    return live.filter(session => session.parentId || session.origin === "fleet" || parents.has(session.id) || session.hasChildren);
  }, [knownSessions]);
  const showPlace = useMemo(() => new Set(state.sessions.map(session => `${session.environment}/${session.workspaceName}`)).size > 1, [state.sessions]);
  const attentionCount = rows.filter(row => row.section === "attention").length;
  const badges = {
    chats: { count: attentionCount || rows.length, attention: attentionCount > 0 },
    workers: { count: workerSessions.filter(session => (session.parentId || session.origin === "fleet") && working(session)).length },
    machine: { count: state.ownerErrors.length + (state.offline ? 1 : 0), attention: true },
  };
  // A thread tool call names threads by id. The transcript shows what they are
  // called, so an id the client has never seen is fetched once and kept with
  // the other threads it knows.
  const askedForThread = useRef(new Set<string>());
  const discoverThreads = useCallback((ids: string[]) => {
    for (const id of ids) {
      if (askedForThread.current.has(id)) continue;
      const current = stateRef.current;
      if ([...current.sessions, ...current.discovered].some(session => session.id === id)) continue;
      askedForThread.current.add(id);
      void api(API.session.method, API.session.path({ sessionId: id }))
        .then((result: { session?: Session }) => {
          const session = result?.session;
          if (!session) return;
          patch(state => [...state.sessions, ...state.discovered].some(item => item.id === session.id)
            ? {} : { discovered: [...state.discovered, session] });
        })
        .catch(() => {});
    }
  }, [patch, stateRef]);
  const threadDirectory = useMemo<ThreadDirectory>(() => ({
    name: id => knownSessions.find(session => session.id === id)?.name || null,
    busy: id => { const session = knownSessions.find(item => item.id === id); return session ? working(session) : false; },
    open: id => openThreadId(id),
    discover: discoverThreads,
  }), [knownSessions, openThreadId, discoverThreads]);

  const panel = "panel" in route ? route.panel : null;
  const showDetail = route.tab === "machine" || route.tab === "files" || !!routeChat;

  const picker = useMemo(() => <LazyChatPicker ref={chatPicker} starts={threadStarts} messaging={state.messaging} onSelect={selectChat} onCreated={id => openThreadId(id, "chats")} onSettled={kick} />,
    [threadStarts, state.messaging, selectChat, openThreadId, kick]);
  const debugTools = <div className="inspector-debug">
    <button type="button" className={voiceState === "idle" ? "" : voiceState} onClick={() => void toggleVoice()} title={voiceDetail || undefined}>{voiceState === "live" ? "Hang up voice" : voiceState === "connecting" ? "Connecting voice…" : "Start voice"}</button>
    {voiceState === "live" && <button type="button" onClick={() => void voice.current?.resumePlayback()}>Play Kenan audio</button>}
    <a href={`${appPath("meet.html")}?${new URLSearchParams({ user: window.PiRemotePerson.get() })}`} onClick={async (event) => { event.preventDefault(); const environment = await window.KenanRemote?.getState(); location.href = `${appPath("meet.html")}?${new URLSearchParams({ user: window.PiRemotePerson.get(), environment: environment?.id || "" })}`; }}>Open PiStack Meet</a>
    {voiceDetail && <p className="muted">{voiceDetail}</p>}
  </div>;

  const conversation = selected && !messagingActive
    ? <ItemBodiesContext.Provider value={bodies}><LiveConversation live={liveText} session={selected} ancestors={ancestors} entries={contextEntries} images={images} offline={state.offline} pending={pending} home={home} prompt={prompt}
        earlierAvailable={hasEarlier(state.transcript)} loadingEarlier={state.loadingEarlier} earlierError={state.earlierError} onShowEarlier={showEarlier} onThinkingOpen={thinkingOpen}
        attachments={visibleAttachments.map(file => ({ id: file.localId, name: file.name, uploading: file.uploading }))} slashCommands={state.slashCommands} drawing={drawing} uploadError={uploadError?.sessionId === aiId ? uploadError.message : ""} controlError={controlError?.sessionId === aiId && !stopTarget ? controlError.message : ""} showBack={layout === "phone"} showIdentity={showConversationIdentity}
        onBack={closeDetail} onOpenInspector={() => openPanel("inspector")} onOpenAncestor={session => openThreadId(session.id)} onOpenQueue={() => openPanel("queue")} onEdit={editFrom} reply={reply} onReply={target => { replyRef.current = target; setReply(target); saveReply(selected.id, target); }} onCancelReply={() => { replyRef.current = null; setReply(null); saveReply(selected.id, null); }} onPrompt={text => { setPrompt(text); if (aiId) saveDraft(aiId, text); }} onSend={delivery => void send(delivery)} onStop={() => stopThread(selected)} onResume={() => void controlThread(selected.id, "resume")} onReconnect={reconnect}
        onRemoveAttachment={id => { const file = visibleAttachments.find(item => item.localId === id); if (file) void removeAttachment(file); }} onUpload={files => void uploadFiles(files)} onPaste={() => setPasteSessionId(aiId)} onDraw={() => drawing.open()} onDismissControlError={() => setControlError(null)} /></ItemBodiesContext.Provider>
    : messagingActive && humanConversation
      ? <div className="conversation-screen"><ConversationHeader title={humanConversation.title} avatar={messagingAvatarUrl(humanConversation.backendId, humanConversation.externalId, humanConversation.avatar)} showIdentity={showConversationIdentity} meta={<span className="conversation-meta">{humanBackend?.label || "Messaging"}{humanBackend && humanBackend.status !== "ready" ? ` · ${humanBackend.status}` : ""}</span>} trailing={<SignalCallButton conversation={humanConversation} available={humanBackend?.plugin === "signal"} enabled={humanBackend?.status === "ready" && humanBackend.capabilities.calls === true} />} onBack={layout === "phone" ? closeDetail : null} onOpenInspector={null} />
        <Suspense fallback={<Loading label="Opening…" />}><MessagingConversations selected={humanConversation} snapshot={state.messaging} onRead={kick} /></Suspense></div>
      : routeChat && state.syncing
        ? <section className="empty-state"><strong>Opening…</strong></section>
        : <section className="empty-state"><strong>{route.tab === "workers" ? "Choose a worker" : "Choose a chat"}</strong></section>;

  const list = route.tab === "chats" ? <Inbox rows={rows} selectedId={routeChat} showPlace={showPlace} compactSelected={layout !== "phone"} error={chatError} picker={picker} onOpen={openInboxChat} onPrefetch={prefetchChat} onClose={closeInboxChat} onSearchArchived={searchArchived} onSelectedVisibleChange={onSelectedVisibleChange} />
    : route.tab === "workers" ? <Suspense fallback={<Loading label="Loading workers…" />}><WorkersTree sessions={workerSessions} selectedId={aiId} compactSelected={layout !== "phone"} filter={workersFilter} onFilter={setWorkersFilter} onOpen={openWorker} onPrefetch={prefetchSession} onSelectedVisibleChange={onSelectedVisibleChange} /></Suspense>
    : null;

  function filesScreen(mode: "stack" | "split") {
    const seen = new Set(["/", home]);
    const shortcuts = [{ label: "Home", path: home }, ...state.sessions.filter(session => {
      if (session.parentId || !session.cwd || seen.has(session.cwd)) return false;
      seen.add(session.cwd);
      return true;
    }).slice(0, 6).map(session => ({ label: session.name || session.cwd, path: session.cwd }))];
    return <Suspense fallback={<Loading label="Loading files…" />}><FilesScreen layout={mode} selectedPath={route.tab === "files" ? route.path : null} shortcuts={shortcuts} onAttach={selectedAiId(stateRef.current) ? path => void attachPath(path) : undefined} onSelect={path => navigate({ tab: "files", path }, { replace: mode === "split" || !path })} /></Suspense>;
  }

  const detail = route.tab === "machine"
    ? <Suspense fallback={<Loading label="Loading the machine…" />}><MachineTab dashboard={dashboard} modelCounts={modelCounts} ownerErrors={state.ownerErrors} offline={state.offline} syncing={state.syncing} pendingAction={pendingAction} onToggleAction={id => void toggleAction(id)} onToggleGovernor={provider => void toggleGovernor(provider)} onDismissOwnerError={id => void dismissServerError(id)} onReconnect={reconnect} sessionId={messagingActive ? null : aiId} /></Suspense>
    : route.tab === "files" ? filesScreen(layout === "phone" ? "stack" : "split")
    : <ThreadDirectoryProvider value={threadDirectory}>{conversation}</ThreadDirectoryProvider>;

  const showTabs = route.tab === "machine" || (route.tab === "files" && !route.path) || !showDetail;
  return <MessagingCallProvider snapshot={state.messaging}>
    <Shell layout={layout} nav={<TabNav layout={layout} active={route.tab} badges={badges} onSelect={selectTab} />} list={list} detail={detail} showDetail={showDetail} showTabs={showTabs}
      overlays={<>
        <SpeechBar />
        <ToastViewport scope={`${person}:${state.bootstrap?.environmentId || ""}`} position={layout === "phone" && !showTabs ? "top-center" : "bottom-center"} />
        {fileDrag && !messagingActive && aiId && <div className="file-drop-overlay" role="status">Drop files to attach to {selected?.name || "this conversation"}</div>}
        {stopTarget && <ThreadStopDialog session={stopTarget} pending={pending} error={controlError?.sessionId === stopTarget.id ? controlError.message : ""} onStop={descendants => void controlThread(stopTarget.id, "stop", descendants)} onClose={() => setStopTarget(null)} />}
        {/* The sheets and the paste dialog mount when they open, so their
            chunks arrive with the gesture that asks for them. */}
        {selected && !messagingActive && (panel === "inspector" || panel === "settings") && <Suspense fallback={null}><InspectorSheet key={selected.id} session={selected} sessions={knownSessions} open pending={pending} onClose={closePanel} onOpenThread={session => openThreadFromPanel(session.id)} onArchive={() => { closePanel(); void closeChat({ id: `ai:${selected.id}`, kind: "ai", title: selected.name, icon: "", label: "", session: selected }); }} onRestore={() => void selectThread(selected.id)} debug={debugTools} /></Suspense>}
        {selected && !messagingActive && panel === "queue" && <Suspense fallback={null}><QueueSheet open messages={selected.queuedMessages} held={selected.held} pending={pending} onClose={closePanel} onAction={(message, action) => void queueAction(message, action)} /></Suspense>}
        {!messagingActive && pasteSessionId && <Suspense fallback={null}><PasteTextDialog name={pasteName} content={pasteContent} onNameChange={setPasteName} onContentChange={setPasteContent} onAttach={file => uploadFile(file, pasteSessionId)} onClose={() => setPasteSessionId(null)} /></Suspense>}
      </>} />
  </MessagingCallProvider>;
}


export { threadStatus };
