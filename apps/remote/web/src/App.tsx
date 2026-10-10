import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { API } from "../../server/api";
import { prioritizeQuestion } from "./features/conversation/question-drafts";
import { assertNever } from "../../shared/explicit-state";
import { validateSession, validateStreamSnapshot } from "../../shared/state-validation";
import { appPath, appStorageKey } from "./app-path";
import type { InlineImageSnapshot, StreamEvent, QuestionsResource } from "../../server/protocol";
import { ClientCache } from "./client-cache";
import { ClientCacheContext } from "./cached-media";
import { api, ApiError, piFetch, ensureUnlocked } from "./client";
import { UnlockDialog } from "./UnlockDialog";
import { reportWebReady, bootstrapUrl, pinnedFetch } from "./native";
import { PromptOutbox, type PromptOutboxEntry, type PromptOutboxScope, type PromptOutboxTransport } from "./prompt-outbox";
import { PromptSubmissions } from "./prompt-submissions";
import { capturedPromptIds, reconcilePromptEntries } from "./features/conversation/optimistic-prompts";
import { PromptOutboxStatus } from "./PromptOutboxStatus";
import { PromptStorage, type PromptStorageState, type PromptStorageResult } from "./prompt-storage";
import { useChatDrawing } from "./chat-drawing";
import type { ReplyTarget } from "./message-reply";
import { ReplyDrafts } from "./reply-drafts";
import { inboxRows, reconcileDiscoveredSessions, selectedAiId, selectionAfterSync, type Chat, type ChatId } from "./chats";
import { SignInDialog } from "./SignInDialog";
import { DismissibleError } from "./dismissible-error";
import { dismissServerError } from "./error-feedback";
import { deliverIdleNotifications, notificationReplayCursor, notificationFeedActivity, takeNotificationTarget, retainNotificationTarget } from "./notifications";
import { listenForFileDrops } from "./file-drop";
import { ensureMarkdown } from "./markdown-engine";
import { createStreamClient, type StreamClient } from "./stream";
import { useRooms, RoomConversation } from "./rooms";
import { conversationTab, working } from "./thread-state";
import { requestStop, submitThreadControl } from "./thread-controls";
import { LazyChatPicker, prepareChatPicker } from "./chat-picker-lazy";
import type { ChatPickerHandle } from "./thread-start-menu";
import type { Attachment, Bootstrap, ContextEntry, Dashboard, QueuedMessage, Session, SlashCommand } from "./types";
import { Shell, TabNav } from "./app/Shell";
import { useLayout } from "./app/layout";
import { preloadView } from "./app/preload-view";
import { RequestIndicator } from "./RequestIndicator";
import { AndroidDownloadPrompt } from "./android-download";
import { AppUpdateStatus, useAppUpdate } from "./app-update";
import { NetworkJoinPrompt } from "./network-join";
import { beginSectionLoad } from "./in-flight";
import { hideClosing, reconcileCloses, withClose, withoutClose, type PendingCloses } from "./pending-closes";
import { shouldUndoClose, UndoCloses } from "./undo-closes";
import { toast, ToastViewport } from "./toasts";
import { NotificationProvider } from "./notification-control";
import { useSystemBack } from "./app/system-back";
import { back, currentRoute, navigate, routeChatId, routeHome, routeThreadId, useRoute, withoutPanel, type Panel, type Route, type Tab } from "./app/routes";
import { observeArtifactActions, recordFeatureUsage, resetFeatureCollection } from "./feature-usage";
import { Inbox } from "./features/chats/Inbox";
import { ConversationScreen } from "./features/conversation/ConversationScreen";
import { ItemBodies, ItemBodiesContext } from "./features/conversation/item-bodies";
import { createLiveText, visibleLiveText, type LiveTextStore } from "./features/conversation/live-text";
import { ThreadDirectoryProvider, type ThreadDirectory } from "./features/conversation/thread-chips";
import { ThreadDiscovery } from "./thread-discovery";
import { entriesFromHeads, WAITING_ENTRY } from "./features/conversation/transcript-entries";
import { applyTranscriptEvent, hasEarlier, hasNewer, loadEarlier, loadNewer, loadLatest, type VisibleTranscriptRange, type TranscriptWindow } from "./features/conversation/transcript-store";
import type { QueueAction } from "./features/queue/QueueSheet";
import { threadStatus } from "./features/status/thread-status";
import { parseSettingsEntry, parseSettingsSnapshot } from "../../shared/settings-wire";
import { observeClientTimezone } from "./features/settings/client-timezone";
import { managerNavigation, monoTranscript, type ManagerPreference } from "./app/mono";
import { requestManager } from "./manager-client";

// Screen code warms after bootstrap, without mounting views or fetching data.
// A ready view never enters Suspense's cold retry throttle.
const PasteTextDialog = lazy(() => import("./PasteTextDialog").then(module => ({ default: module.PasteTextDialog })));
const InspectorSheet = preloadView(() => import("./features/inspector/InspectorSheet").then(module => ({ default: module.InspectorSheet })));
const QueueSheet = preloadView(() => import("./features/queue/QueueSheet").then(module => ({ default: module.QueueSheet })));
const AgentsScreen = preloadView(() => import("./features/agents/AgentsScreen").then(module => ({ default: module.AgentsScreen })));
const FilesScreen = preloadView(() => import("./features/files/FilesScreen").then(module => ({ default: module.FilesScreen })));
const MachineTab = preloadView(() => import("./features/machine/MachineTab").then(module => ({ default: module.MachineTab })));
const SettingsScreen = preloadView(() => import("./features/settings/SettingsScreen").then(module => ({ default: module.SettingsScreen })));

function prepareTab(tab: Tab) {
  switch (tab) {
    case "chats": return;
    case "agents": void AgentsScreen.preload(); return;
    case "files": void FilesScreen.preload(); return;
    case "machine": void MachineTab.preload(); return;
    case "settings": void SettingsScreen.preload(); return;
  }
  return assertNever(tab, "Prepare tab");
}

function Loading({ label }: { label: string }) {
  useEffect(() => beginSectionLoad(`screen:${label}`), [label]);
  return <section className="empty-state" aria-busy="true"><strong>{label}</strong></section>;
}

// Everything the server owns arrives on one push stream. Sections replace
// wholesale, including sessions and the recent transcript window; the client
// never patches a server-owned value from a mutation
// response. What remains local is the view (the route), the window of items it
// holds, and composer scratch.
interface AppState {
  selectedChatId: ChatId | null;
  sessions: Session[];
  /** Threads opened from the picker or a notification before a delta carries them. */
  discovered: Session[];
  /** Background agents discovered for opening or inspecting launch provenance. */
  fleet: Session[];
  archivedTotal: number;
  dashboard: Dashboard | null;
  bootstrap: Bootstrap | null;
  manager: ManagerPreference | null;
  transcript: TranscriptWindow | null;
  images: InlineImageSnapshot | null;
  attachments: Attachment[];
  slashCommands: SlashCommand[];
  offline: string;
  ownerErrors: { id: string; owner: string; message: string }[];
  syncing: boolean;
  threadSyncing: boolean;
  loadingEarlier: boolean;
  earlierError: string;
}

const initialState: AppState = {
  selectedChatId: null,
  sessions: [], discovered: [], fleet: [], archivedTotal: 0, dashboard: null, bootstrap: null, manager: null,
  transcript: null, images: null,
  attachments: [], slashCommands: [], offline: "", ownerErrors: [], syncing: true, threadSyncing: true,
  loadingEarlier: false, earlierError: "",
};

function draftKey(id: string) { return appStorageKey(`pi-remote-draft:${window.PiRemotePerson.get()}:${id}`); }
function loadDraft(id: string) { try { return localStorage.getItem(draftKey(id)) || ""; } catch { return ""; } }
function saveDraft(id: string, value: string) { try { value ? localStorage.setItem(draftKey(id), value) : localStorage.removeItem(draftKey(id)); } catch {} }
function replyKey(id: string) { return appStorageKey(`pi-remote-reply:${window.PiRemotePerson.get()}:${id}`); }

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

export default function App() {
  const update = useAppUpdate();
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
  return <><RequestIndicator /><SignInDialog /><UnlockDialog /><NetworkJoinPrompt /><AndroidDownloadPrompt /><RemoteApp key={`${person}:${lockGeneration}`} update={update} /></>;
}

/**
 * The only subscriber to the live store. Everything else about the
 * conversation comes from props, so a live frame re-renders this component and
 * nothing above it: not the inbox, not the worker tree, not the tab badges.
 */
const LiveConversation = memo(function LiveConversation({ live, ...props }: { live: LiveTextStore } & Omit<Parameters<typeof ConversationScreen>[0], "liveText" | "liveThinking" | "thinkingActive">) {
  const { text, thinking } = visibleLiveText(useSyncExternalStore(live.subscribe, live.snapshot, live.snapshot), props.entries);
  return <ConversationScreen {...props} liveText={text} liveThinking={thinking} thinkingActive={props.session.activity === "thinking" || !!thinking} />;
});

function RemoteApp({ update }: { update: ReturnType<typeof useAppUpdate> }) {
  const person = useRef(window.PiRemotePerson.get()).current;
  const autoCollapseKey = appStorageKey(`pi-remote-auto-collapse:${person}`);
  const [autoCollapse, setAutoCollapse] = useState(true);
  const updateAutoCollapse = useCallback((enabled: boolean) => {
    void api(API.updateSetting.method, API.updateSetting.path({ id: "person.autoCollapse" }), { value: enabled }).then(result => {
      const parsed = parseSettingsEntry(result.entry);
      if (!parsed.ok) { toast.error(parsed.error); return; }
      if (parsed.value.value.state !== "set" || typeof parsed.value.value.value !== "boolean") { toast.error("Auto-collapse owner returned an invalid state"); return; }
      setAutoCollapse(parsed.value.value.value);
      window.dispatchEvent(new Event("pi-settings-changed"));
    }, cause => toast.error(cause instanceof Error ? cause.message : "Could not save auto-collapse preference"));
  }, []);
  const { state, stateRef, patch } = useStableState();
  const roomDirectory = useRooms(state.bootstrap?.rooms === true);
  const bootstrapped = state.bootstrap !== null;
  useEffect(() => {
    if (!bootstrapped) return;
    let active = true;
    const load = async () => {
      try {
        const response = await api(API.settings.method, API.settings.path());
        if (!active || person !== window.PiRemotePerson.get()) return;
        const parsed = parseSettingsSnapshot(response);
        if (!parsed.ok) { toast.error(parsed.error); return; }
        const preference = parsed.value.entries.find(entry => entry.definition.id === "person.autoCollapse");
        if (!preference || preference.value.state === "unavailable") { if (active) toast.error(preference?.value.state === "unavailable" ? preference.value.message : "Display preference is not registered"); return; }
        if (preference.value.state === "set") {
          if (typeof preference.value.value !== "boolean") { if (active) toast.error("Invalid display preference"); return; }
          if (active) setAutoCollapse(preference.value.value);
          localStorage.removeItem(autoCollapseKey);
        } else {
          const saved = localStorage.getItem(autoCollapseKey);
          if (saved === "true" || saved === "false") {
            await api(API.updateSetting.method, API.updateSetting.path({ id: "person.autoCollapse" }), { value: saved === "true" });
            localStorage.removeItem(autoCollapseKey);
            if (active) setAutoCollapse(saved === "true");
          }
        }
      } catch (cause) { if (active) toast.error(String(cause)); }
    };
    void load();
    void observeClientTimezone().then(result => { if (active && !result.ok) toast.error(result.error); });
    window.addEventListener("pi-settings-changed", load);
    return () => { active = false; window.removeEventListener("pi-settings-changed", load); };
  }, [bootstrapped, autoCollapseKey, person]);
  useEffect(() => {
    if (!bootstrapped) return;
    const views = [{ preload: prepareChatPicker }, AgentsScreen, FilesScreen, MachineTab, SettingsScreen, InspectorSheet, QueueSheet];
    let cancelled = false;
    let next = 0;
    let cancelScheduled: (() => void) | null = null;
    const schedule = () => {
      if (cancelled || next === views.length) return;
      const load = () => {
        cancelScheduled = null;
        if (cancelled) return;
        void views[next++].preload().then(schedule);
      };
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(load);
        cancelScheduled = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(load, 0);
        cancelScheduled = () => window.clearTimeout(id);
      }
    };
    schedule();
    return () => { cancelled = true; cancelScheduled?.(); };
  }, [bootstrapped]);
  const layout = useLayout();
  const route = useRoute();
  const routeChat = routeChatId(route);
  const manager = state.manager;
  const managerOwnerId = state.bootstrap?.managerOwnerEnvironmentId;
  const mono = state.bootstrap?.environmentId === managerOwnerId && manager?.view === "mono" && routeThreadId(route) === manager.managerThreadId;
  const [managerSaving, setManagerSaving] = useState(false);
  const managerMutation = useRef(false);
  const managerGeneration = useRef(0);
  useEffect(() => () => { managerGeneration.current++; }, []);
  const managerObservation = useRef(0);
  const [managerError, setManagerError] = useState("");
  const [managerRefresh, setManagerRefresh] = useState(0);
  const openManager = useCallback(async (next: Route) => {
    const owner = stateRef.current.bootstrap?.managerOwnerEnvironmentId;
    if (!owner) { toast.error("Manager owner is unavailable"); return; }
    const generation = managerGeneration.current;
    try {
      if (stateRef.current.bootstrap?.environmentId !== owner) {
        if (!window.KenanRemote) throw new Error("Environment switching is unavailable");
        const selected = await window.KenanRemote.select({ id: owner, user: person });
        if (generation !== managerGeneration.current) return;
        if (!selected || selected.id !== owner) throw new Error("Manager environment selection was not confirmed");
        navigate(next, { replace: true });
        location.reload();
      } else navigate(next, { replace: true });
    } catch (cause) { if (generation === managerGeneration.current) toast.error(cause instanceof Error ? cause.message : "Could not open manager environment"); }
  }, [person, stateRef]);
  const previousManager = useRef<ManagerPreference | null>(null);
  useLayoutEffect(() => {
    if (!manager) return;
    const next = managerNavigation(previousManager.current, manager, currentRoute());
    previousManager.current = manager;
    if (next) { if (manager.view === "mono") void openManager(next); else navigate(next, { replace: true }); }
  }, [manager, openManager]);
  useEffect(() => {
    if (!managerOwnerId || state.bootstrap?.environmentId === managerOwnerId) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || managerMutation.current || document.visibilityState !== "visible") return;
      pending = true;
      const observation = ++managerObservation.current;
      const result = await requestManager(managerOwnerId, undefined, controller.signal);
      pending = false;
      if (controller.signal.aborted || observation !== managerObservation.current) return;
      if (result.ok) { setManagerError(""); patch({ manager: result.value }); }
      else if (result.error.kind !== "identity_changed") setManagerError(result.error.message);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const wake = () => void refresh();
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pi-app-foreground", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pi-app-foreground", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [managerOwnerId, state.bootstrap?.environmentId, managerRefresh, patch]);
  const updateManager = useCallback(async (view: "classic" | "mono", hintSeen?: boolean) => {
    if (managerMutation.current) return;
    const owner = stateRef.current.bootstrap?.managerOwnerEnvironmentId;
    if (!owner) { toast.error("Manager owner is unavailable"); return; }
    managerMutation.current = true;
    managerObservation.current++;
    const generation = managerGeneration.current;
    setManagerSaving(true);
    const result = await requestManager(owner, { view, ...(hintSeen === undefined ? {} : { hintSeen }) });
    if (generation === managerGeneration.current) {
      if (result.ok) {
        previousManager.current = result.value;
        setManagerError("");
        patch({ manager: result.value });
        if (result.value.view === "mono") await openManager({ tab: "chats", chat: `ai:${result.value.managerThreadId}`, panel: null });
        else navigate({ tab: "chats", chat: null, panel: null }, { replace: true });
        stream.current?.reconnect();
      } else if (result.error.kind !== "identity_changed") toast.error(result.error.message);
    }
    managerMutation.current = false;
    setManagerSaving(false);
  }, [patch, openManager, stateRef]);
  useEffect(() => { resetFeatureCollection(); const stop = observeArtifactActions(); return () => { stop(); resetFeatureCollection(); }; }, []);
  useEffect(() => {
    if (!bootstrapped || document.visibilityState !== "visible") return;
    const feature = route.tab === "chats" ? "chat" : route.tab === "files" ? null : route.tab;
    if (feature !== null) recordFeatureUsage(feature);
  }, [bootstrapped, route.tab, routeChat]);
  const inspectingContext = "panel" in route && route.panel === "inspector";
  useEffect(() => {
    if (bootstrapped && inspectingContext && document.visibilityState === "visible") recordFeatureUsage("context");
  }, [bootstrapped, inspectingContext]);
  const selectionKey = `${route.tab}:${routeChat ?? ""}`;
  const [listSelection, setListSelection] = useState({ key: "", visible: false });
  const onSelectedVisibleChange = useCallback((visible: boolean) => {
    setListSelection(current => current.key === selectionKey && current.visible === visible ? current : { key: selectionKey, visible });
  }, [selectionKey]);
  const showConversationIdentity = layout === "phone" || listSelection.key !== selectionKey || !listSelection.visible;
  const aiId = routeThreadId(route);
  const roomId = state.bootstrap?.rooms && routeChat?.startsWith("room:") ? routeChat.slice(5) : null;
  const [chatError, setChatError] = useState("");
  const [closing, setClosing] = useState<PendingCloses>(() => new Set());
  const undoCloses = useMemo(() => new UndoCloses(), []);
  const undoState = useSyncExternalStore(undoCloses.subscribe, undoCloses.snapshot, undoCloses.snapshot);
  const [prompt, setPrompt] = useState("");
  const promptDraft = useRef(prompt);
  useLayoutEffect(() => { promptDraft.current = prompt; }, [prompt]);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const replyRef = useRef<ReplyTarget | null>(null);
  const replyDrafts = useMemo(() => new ReplyDrafts(localStorage, replyKey), []);
  const [pending, setPending] = useState(false);
  const [controlError, setControlError] = useState<{ sessionId: string; message: string } | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<({ sessionId: string } & QuestionsResource) | null>(null);
  const [pasteSessionId, setPasteSessionId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{ sessionId: string; message: string } | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pasteName, setPasteName] = useState("pasted-text.txt");
  const [pasteContent, setPasteContent] = useState("");

  const stream = useRef<StreamClient | null>(null);
  const initialLoad = useRef<(() => void) | null>(null);
  const sectionLoad = useRef<{ name: string; finish: () => void } | null>(null);
  const finishSection = (name: string) => {
    if (sectionLoad.current?.name !== name) return;
    sectionLoad.current.finish();
    sectionLoad.current = null;
  };
  // Live answer and thinking text, thirty frames a second, kept out of the
  // app's state so only the open conversation re-renders for them.
  const live = useRef<LiveTextStore | null>(null);
  live.current ??= createLiveText();
  const panelPushed = useRef(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const kick = useCallback(() => stream.current?.reconnect(), []);
  const reconnect = useCallback(() => stream.current?.reconnect(), []);
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
    navigate({ tab: "chats", chat, panel: null }, options);
  }, [route.tab]);
  const openThreadId = useCallback((id: string, tab?: Tab) => openChat(id.startsWith("room:") ? id as ChatId : `ai:${id}`, { tab }), [openChat]);
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
    if (panel === "queue") void QueueSheet.preload();
    else void InspectorSheet.preload();
    panelPushed.current = true;
    navigate({ ...route, panel });
  }, [route]);
  const closePanel = useCallback(() => {
    if (panelPushed.current) { panelPushed.current = false; back(); }
    else navigate(withoutPanel(route), { replace: true });
  }, [route]);
  const closeDetail = useCallback(() => {
    if (manager?.view === "mono") void openManager({ tab: "chats", chat: `ai:${manager.managerThreadId}`, panel: null });
    else if (history.length > 1) back();
    else navigate(routeHome(route), { replace: true });
  }, [route, manager, openManager]);
  useSystemBack({ closePanel, closeDetail, rootChat: mono && manager?.view === "mono" ? `ai:${manager.managerThreadId}` : undefined });
  const selectTab = useCallback((tab: Tab) => {
    prepareTab(tab);
    if (tab === route.tab) navigate(routeHome(route));
    else if (tab === "chats") navigate({ tab, chat: null, panel: null });
    else if (tab === "files") navigate({ tab, path: null });
    else navigate({ tab });
  }, [route]);

  // The route decides the selection; this effect does the work of selecting.
  const selectionGeneration = useRef(0);
  const selectThread = useCallback(async (id: string, discovered?: Session, signal?: AbortSignal) => {
    const generation = ++selectionGeneration.current;
    const candidate = discovered ?? [...stateRef.current.sessions, ...stateRef.current.discovered].find(item => item.id === id);
    if (stateRef.current.manager?.managerThreadId === id) {
      if (!candidate) {
        const found = await api(API.session.method, API.session.path({ sessionId: id }));
        validateSession(found.session);
        discovered = found.session;
      }
    } else if (!candidate || candidate.archivedAt || candidate.foreground !== true) {
      const opened = await api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: id }), {});
      validateSession(opened.session);
      discovered = opened.session;
    }
    if (signal?.aborted || generation !== selectionGeneration.current) return;
    setPendingQuestions({ sessionId: id, state: "loading", questions: [] });
    setPasteSessionId(null);
    liveText.reset();
    const remembered = cache.thread(id);
    patch((current) => ({
      selectedChatId: `ai:${id}`, transcript: remembered?.transcript ?? null, images: remembered?.images ?? null, slashCommands: [], syncing: true, threadSyncing: true,
      loadingEarlier: false, earlierError: "",
      discovered: discovered && ![...current.sessions, ...current.discovered].some(session => session.id === discovered.id)
        ? [...current.discovered, discovered] : current.discovered,
    }));
    setPrompt(loadDraft(id));
    replyRef.current = replyDrafts.load(id);
    setReply(replyRef.current);
    if (remembered?.transcript) stream.current?.restore({ type: "transcript", sessionId: id, ...remembered.transcript });
    kick();
    // Memory paints synchronously. Disk may fill a cold opening, but never
    // replace a newer stream frame.
    if (remembered?.transcript) return;
    const usable = () => !signal?.aborted && selectedAiId(stateRef.current) === id && generation === selectionGeneration.current;
    void cache.restoreThread(id).then((window) => {
      if (window && usable() && !stateRef.current.transcript) {
        cache.rememberThread(id, { transcript: window });
        stream.current?.restore({ type: "transcript", sessionId: id, ...window });
        patch({ transcript: window });
        finishSection(`thread:${id}`);
        stream.current?.update({ transcriptFrom: null });
      }
    });
  }, [cache, kick, liveText, patch, stateRef]);
  useLayoutEffect(() => {
    if (routeChat === stateRef.current.selectedChatId) return;
    if (!routeChat) { liveText.reset(); patch({ selectedChatId: null, transcript: null, images: null }); return; }
    if (routeChat.startsWith("ai:")) void selectThread(routeChat.slice(3)).catch(cause => { finishSection(`thread:${routeChat.slice(3)}`); setChatError(String(cause)); });
    else { setPasteSessionId(null); liveText.reset(); patch({ selectedChatId: routeChat, transcript: null, images: null, slashCommands: [] }); kick(); }
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
          openThreadId(target.sessionId, "chats");
        }
      } catch (cause) { patch({ offline: `Could not open notification: ${String(cause)}` }); }
    };
    void openNotification();
    window.addEventListener("pi-notification", openNotification);
    return () => window.removeEventListener("pi-notification", openNotification);
  }, [openThreadId, patch]);

  useEffect(() => {
    initialLoad.current = beginSectionLoad("app");
    return () => { initialLoad.current?.(); initialLoad.current = null; };
  }, []);
  useEffect(() => {
    sectionLoad.current?.finish();
    sectionLoad.current = null;
    const name = aiId ? `thread:${aiId}` : route.tab === "machine" ? "machine" : null;
    if (!name || aiId && cache.thread(aiId)?.transcript || name === "machine" && stateRef.current.dashboard) return;
    const finish = beginSectionLoad(name);
    sectionLoad.current = { name, finish };
    return () => finishSection(name);
  }, [aiId, route.tab, cache]);

  type OutboxOwner = { store: PromptOutbox; transport: PromptOutboxTransport; scope: PromptOutboxScope; entries: PromptOutboxEntry[] };
  const outbox = useRef<OutboxOwner | null>(null);
  const promptStorage = useRef<PromptStorage<OutboxOwner> | null>(null);
  const storageFailure = useRef<string | null>(null);
  const [storageState, setStorageState] = useState<PromptStorageState<OutboxOwner>>({ kind: "loading" });
  const ensureOutbox = useCallback((): Promise<PromptStorageResult<OutboxOwner>> => promptStorage.current?.ensure()
    ?? Promise.resolve({ ok: false, error: { kind: "unavailable", message: "Prompt storage is initializing. Retry when storage is ready." } }), []);
  const [outboxEntries, setOutboxEntries] = useState<PromptOutboxEntry[]>([]);
  const [outboxBusy, setOutboxBusy] = useState<string | null>(null);
  const localPrompts = useRef(new Map<string, PromptOutboxEntry>());
  const localPromptDrafts = useRef(new Map<string, { sessionId: string; draft: string; replyVersion: number }>());
  const settlePromptDraft = useCallback((requestId: string) => {
    const source = localPromptDrafts.current.get(requestId);
    if (!source) return;
    if (loadDraft(source.sessionId) === source.draft) saveDraft(source.sessionId, "");
    replyDrafts.accept(source.sessionId, source.replyVersion);
    localPromptDrafts.current.delete(requestId);
  }, [replyDrafts]);
  const [localPromptEntries, setLocalPromptEntries] = useState<PromptOutboxEntry[]>([]);
  const [activePromptIds, setActivePromptIds] = useState<ReadonlySet<string>>(new Set());
  const [sentPrompt, setSentPrompt] = useState<{ sessionId: string; requestId: string } | null>(null);
  const updateLocalPrompt = useCallback((entry: PromptOutboxEntry) => {
    localPrompts.current.set(entry.requestId, entry);
    setLocalPromptEntries([...localPrompts.current.values()]);
  }, []);
  const ownedPrompts = useRef(new Map<string, string>());
  const interruptedPromptIds = useRef(new Set<string>());
  const promptSubmissions = useRef(new PromptSubmissions());
  const drainingPrompts = useRef(false);
  const refreshOutbox = useCallback(async () => {
    const owner = outbox.current;
    if (!owner) return;
    const entries = await owner.store.list();
    if (outbox.current !== owner) return;
    if (entries.ok) setOutboxEntries(entries.value);
    else promptStorage.current?.fail(entries.error.message);
  }, []);
  useEffect(() => {
    let active = true;
    const storage = new PromptStorage<OutboxOwner>({
      open: async currentAttempt => {
        const [environment, root] = await Promise.all([window.KenanRemote?.getState(), bootstrapUrl()]);
        if (!environment) return { ok: false, error: { kind: "unavailable", message: "Environment transport is unavailable" } };
        const scope: PromptOutboxScope = { person, environment: environment.id, bootstrap: new URL(root || "/", location.href).href };
        const currentScope = () => active && currentAttempt() && window.PiRemotePerson.get() === person
          && (!stateRef.current.bootstrap || stateRef.current.bootstrap.environmentId === scope.environment) ? scope : null;
        const store = new PromptOutbox({ scope, database: indexedDB, currentScope });
        const entries = await store.list();
        if (!entries.ok) { store.dispose(); return { ok: false, error: { kind: entries.error.kind === "scope_changed" ? "scope_changed" : "unavailable", message: entries.error.message } }; }
        const transport: PromptOutboxTransport = async (entry, signal) => {
          const selected = await window.KenanRemote?.getState();
          if (!selected || !currentScope() || selected.id !== scope.environment) throw new Error("The prompt belongs to another person or environment");
          signal.throwIfAborted();
          const response = await pinnedFetch(environment, person, API.sessionPrompt.path({ sessionId: entry.sessionId }), {
            method: "POST", signal, headers: { "content-type": "application/json" }, body: entry.bodyJson });
          if (response.status === 423 && window.PiRemotePerson.get() === person) {
            void ensureUnlocked().catch(error => toast.error(error instanceof Error ? error.message : String(error)));
          }
          return { status: response.status, body: await response.json() };
        };
        return { ok: true, value: { store, transport, scope, entries: entries.value } };
      },
      dispose: owner => owner.store.dispose(),
      changed: next => {
        if (!active) return;
        outbox.current = next.kind === "ready" ? next.owner : null;
        setStorageState(next);
        if (next.kind === "failed") storageFailure.current = next.error.message;
        if (next.kind === "ready") {
          setOutboxEntries(next.owner.entries);
          const recoveredError = storageFailure.current;
          if (recoveredError) setControlError(current => current?.message === recoveredError ? null : current);
          storageFailure.current = null;
        }
      },
    });
    promptStorage.current = storage;
    void storage.ensure();
    const reset = () => {
      ownedPrompts.current.clear();
      localPrompts.current.clear();
      localPromptDrafts.current.clear();
      setLocalPromptEntries([]);
      setActivePromptIds(new Set());
      setSentPrompt(null);
      setOutboxEntries([]);
      storage.invalidate();
      void storage.ensure();
    };
    window.addEventListener("pi-auth", reset);
    window.addEventListener("pi-person", reset);
    return () => {
      active = false;
      window.removeEventListener("pi-auth", reset);
      window.removeEventListener("pi-person", reset);
      ownedPrompts.current.clear();
      storage.close();
      if (promptStorage.current === storage) { promptStorage.current = null; outbox.current = null; }
    };
  }, [person, stateRef]);
  const submitSavedPrompt = useCallback((requestId: string) => {
    interruptedPromptIds.current.delete(requestId);
    const expectedEnvironment = stateRef.current.bootstrap?.environmentId;
    const fail = (message: string) => {
      const local = localPrompts.current.get(requestId);
      if (local) updateLocalPrompt({ ...local, outcome: { kind: "pending", reason: "transport", message } });
      else if (!interruptedPromptIds.current.has(requestId)) toast.error(message);
      ownedPrompts.current.delete(requestId);
    };
    return promptSubmissions.current.run(localPrompts.current, requestId, async () => {
      setOutboxBusy(requestId);
      setActivePromptIds(current => new Set(current).add(requestId));
      try {
        const initialized = await ensureOutbox();
        if (!initialized.ok) { fail(initialized.error.message); return; }
        const owner = initialized.value;
        if (outbox.current !== owner || expectedEnvironment !== owner.scope.environment) { fail("The saved prompt belongs to another environment."); return; }
        const local = localPrompts.current.get(requestId);
        if (local) {
          const entry = await owner.store.enqueue(local.sessionId, JSON.parse(local.bodyJson));
          if (outbox.current !== owner) return;
          if (entry.ok) settlePromptDraft(requestId);
          if (interruptedPromptIds.current.has(requestId)) { fail("Sending stopped. Tap Retry to check this same message."); return; }
          if (!entry.ok) {
            fail(entry.error.message);
            if (entry.error.kind === "storage_unavailable" || entry.error.kind === "storage_corrupt") promptStorage.current?.fail(entry.error.message);
            return;
          }
          updateLocalPrompt(entry.value);
          setOutboxEntries(current => [...current.filter(item => item.requestId !== requestId), entry.value]);
        }
        if (interruptedPromptIds.current.has(requestId)) { fail("Sending stopped. Tap Retry to check this same message."); return; }
        const result = await owner.store.submit(requestId, owner.transport);
        if (outbox.current !== owner) return;
        if (!result.ok) fail(result.error.message);
        else {
          if (localPrompts.current.has(requestId)) updateLocalPrompt(result.value);
          setOutboxEntries(current => [...current.filter(item => item.requestId !== requestId), result.value]);
          if (result.value.outcome.kind !== "pending") ownedPrompts.current.delete(requestId);
          if (result.value.outcome.kind === "accepted") kick();
        }
        await refreshOutbox();
      } finally {
        setOutboxBusy(current => current === requestId ? null : current);
        setActivePromptIds(current => { const next = new Set(current); next.delete(requestId); return next; });
      }
    });
  }, [kick, refreshOutbox, ensureOutbox, stateRef, updateLocalPrompt, settlePromptDraft]);
  const interruptPrompts = useCallback((sessionId: string, descendants: boolean) => {
    const ids = new Set([sessionId]);
    if (descendants) {
      const rows = [...stateRef.current.sessions, ...stateRef.current.discovered, ...stateRef.current.fleet];
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) { ids.add(row.id); changed = true; }
      }
    }
    const requests = new Set(outboxEntries.filter(entry => ids.has(entry.sessionId)).map(entry => entry.requestId));
    for (const [id, thread] of ownedPrompts.current) if (ids.has(thread)) requests.add(id);
    for (const id of requests) { interruptedPromptIds.current.add(id); outbox.current?.store.interrupt(id); ownedPrompts.current.delete(id); }
  }, [outboxEntries, stateRef]);
  const discardSavedPrompt = useCallback(async (requestId: string) => {
    interruptedPromptIds.current.add(requestId);
    ownedPrompts.current.delete(requestId);
    settlePromptDraft(requestId);
    localPrompts.current.delete(requestId);
    setLocalPromptEntries([...localPrompts.current.values()]);
    const initialized = await ensureOutbox();
    if (!initialized.ok) { toast.error(initialized.error.message); return; }
    const owner = initialized.value;
    if (outbox.current !== owner) return;
    const result = await owner.store.discard(requestId);
    if (!result.ok && result.error.kind !== "not_found") toast.error(result.error.message);
    await refreshOutbox();
  }, [refreshOutbox, ensureOutbox, settlePromptDraft]);
  const healthyPromptFeed = useRef(false);
  const feedActivity = useCallback((healthy: boolean) => {
    notificationFeedActivity(healthy);
    const recovered = healthy && !healthyPromptFeed.current;
    healthyPromptFeed.current = healthy;
    if (recovered && promptStorage.current?.state.kind !== "ready") void ensureOutbox();
    if (!healthy || drainingPrompts.current || document.visibilityState !== "visible") return;
    drainingPrompts.current = true;
    void (async () => {
      try {
        for (const requestId of [...ownedPrompts.current.keys()]) {
          if (ownedPrompts.current.has(requestId)) await submitSavedPrompt(requestId);
        }
      } finally { drainingPrompts.current = false; }
    })();
  }, [submitSavedPrompt, ensureOutbox]);

  const visibleHeads = useRef<{ sessionId: string; range: VisibleTranscriptRange | null } | null>(null);
  const onVisibleHeads = useCallback((range: VisibleTranscriptRange | null) => { visibleHeads.current = aiId ? { sessionId: aiId, range } : null; }, [aiId]);
  const carrying = useRef(false);
  useEffect(() => {
    let protocolError = "";
    let connectionError = "";
    const handle = (event: StreamEvent) => {
      carrying.current = true;
      switch (event.type) {
        case "hello":
        case "bootstrap": {
          if (outbox.current && outbox.current.scope.environment !== event.bootstrap.environmentId
            || stateRef.current.bootstrap && stateRef.current.bootstrap.environmentId !== event.bootstrap.environmentId) {
            ownedPrompts.current.clear();
            localPrompts.current.clear();
            localPromptDrafts.current.clear();
            setLocalPromptEntries([]);
            setActivePromptIds(new Set());
            setSentPrompt(null);
            setOutboxEntries([]);
            promptStorage.current?.invalidate();
          }
          undoCloses.setScope(`${person}:${event.bootstrap.environmentId}`);
          patch({ bootstrap: event.bootstrap, manager: event.bootstrap.manager ?? stateRef.current.manager, syncing: false });
          if (promptStorage.current?.state.kind !== "ready") void ensureOutbox();
          initialLoad.current?.();
          initialLoad.current = null;
          return;
        }
        case "state": {
          const current = stateRef.current;
          const sessions = event.sessions;
          const present = new Set(sessions.map(session => session.id));
          for (const [requestId, threadId] of ownedPrompts.current) {
            const before = current.sessions.find(row => row.id === threadId);
            const after = sessions.find(row => row.id === threadId);
            if (before && (!after || after.held && !before.held)) {
              interruptedPromptIds.current.add(requestId);
              outbox.current?.store.interrupt(requestId);
              ownedPrompts.current.delete(requestId);
            }
          }
          for (const previous of current.sessions) if (!present.has(previous.id)) cache.forgetThread(previous.id);
          const update: Partial<AppState> = {
            sessions,
            archivedTotal: event.archivedTotal,
            ownerErrors: event.ownerErrors ?? [],
            discovered: reconcileDiscoveredSessions(current.discovered, sessions),
            syncing: false,
          };
          // A thread closed on another device leaves this client's view too.
          const closed = selectionAfterSync(current.selectedChatId, current, { sessions }) !== current.selectedChatId;
          if (closed) { liveText.reset(); Object.assign(update, { selectedChatId: null, transcript: null, images: null }); }
          patch(update);
          if (closed) navigate(routeHome(currentRoute()), { replace: true });
          return;
        }
        case "dashboard": patch({ dashboard: event.dashboard }); finishSection("machine"); return;
        case "workers": patch({ fleet: event.sessions }); return;
        case "transcript": {
          const previous = stateRef.current.transcript;
          const transcript = applyTranscriptEvent(previous, event, visibleHeads.current?.sessionId === event.sessionId ? visibleHeads.current.range : null);
          patch({ transcript, syncing: false, earlierError: "" });
          finishSection(`thread:${event.sessionId}`);
          if (previous && previous.generation !== transcript.generation) stream.current?.update({ transcriptFrom: null });
          cache.rememberThread(event.sessionId, { transcript });
          return;
        }
        // Live frames do not touch the app's state: the conversation that
        // shows them subscribes to this store on its own.
        case "live": liveText.apply(event); return;
        case "images":
          cache.rememberThread(event.sessionId, { images: event.snapshot });
          patch({ images: event.snapshot });
          return;
        case "questions":
          setPendingQuestions(previous => event.state === "loading" && !event.questions.length && previous?.sessionId === event.sessionId
            ? { ...event, questions: previous.questions } : event);
          return;
        case "notifications": {
          deliverIdleNotifications(event.feed);
          stream.current?.remember({ notificationsAfter: event.feed.cursor });
          return;
        }
        case "error":
          protocolError = event.message;
          patch({ offline: connectionError || protocolError });
          return;
        case "events": return; // Voice owns occurrence feeds; this client subscribes to snapshots.
        case "reconcile": case "selection-ready": throw new Error(`Unprocessed stream control frame reached App: ${event.type}`);
      }
      assertNever(event, "App stream event");
    };
    const opening = currentRoute();
    const client = createStreamClient({
      suspendWhenHidden: true,
      beforeReconcile: async () => {
        const environment = await window.KenanRemote?.getState();
        if (!environment) throw new Error("Environment transport is unavailable");
        return { notificationsAfter: await notificationReplayCursor(person, environment.id) };
      },
      onActivity: feedActivity,
      subscription: {
        session: routeThreadId(opening),
        viewing: document.visibilityState === "visible" && !!routeThreadId(opening),
        dashboard: opening.tab === "machine",
        transcriptFrom: null,
      },
      onEvent: handle,
      onSelectionStatus: ({ sessionId, ready }) => {
        if (sessionId !== selectedAiId(stateRef.current)) return;
        if (ready) protocolError = "";
        patch({ threadSyncing: !ready, offline: connectionError || protocolError });
      },
      onStatus: (status) => {
        if (status.state !== "open") { carrying.current = false; notificationFeedActivity(false); }
        if (status.state === "offline") {
          initialLoad.current?.();
          initialLoad.current = null;
          sectionLoad.current?.finish();
          sectionLoad.current = null;
        }
        connectionError = status.state === "offline" ? status.error || "Offline" : "";
        patch({
          offline: connectionError || protocolError,
          syncing: status.state !== "open" || !carrying.current,
        });
      },
    });
    stream.current = client;
    const selectedId = routeThreadId(opening);
    const remembered = selectedId ? cache.thread(selectedId)?.transcript : null;
    if (selectedId && remembered) client.restore({ type: "transcript", sessionId: selectedId, ...remembered });
    client.start();
    let replayQueued = false;
    const replayRequired = (event: Event) => {
      const detail = (event as CustomEvent<{ user: string; session: string; environment: string }>).detail;
      if (!detail || detail.user !== person || detail.session !== window.PiRemotePerson.session() || detail.environment !== stateRef.current.bootstrap?.environmentId || replayQueued) return;
      replayQueued = true;
      queueMicrotask(() => { replayQueued = false; if (stream.current === client) client.reconnect(); });
    };
    window.addEventListener("pi-notification-replay-required", replayRequired);
    return () => {
      window.removeEventListener("pi-notification-replay-required", replayRequired);
      client.stop();
      stream.current = null;
    };
  }, [cache, liveText, patch, person, stateRef, undoCloses, feedActivity, ensureOutbox]);

  // What the stream carries follows the route: the open thread, whether the
  // person can see it, and the Machine screen only while it is showing.
  useEffect(() => {
    const client = stream.current;
    if (!client) return;
    const held = client.subscription();
    const next = {
      session: aiId,
      viewing: visible && !!aiId,
      thinking: !mono && !autoCollapse && visible && !!aiId,
      dashboard: route.tab === "machine",
      workers: route.tab === "agents",
      transcriptFrom: null,
    };
    const same = (held.session ?? null) === next.session && !!held.viewing === next.viewing && !!held.dashboard === next.dashboard && !!held.workers === next.workers && !!held.thinking === next.thinking;
    if (same) return;
    // A list nobody refreshes would show settled fleet threads as they were.
    if (!next.workers && held.workers) patch({ fleet: [] });
    client.update(next);
  }, [aiId, autoCollapse, mono, route.tab, visible]);

  const retryQuestions = useCallback(() => {
    const id = selectedAiId(stateRef.current);
    if (!id) return;
    const generation = selectionGeneration.current;
    setPendingQuestions(current => ({ sessionId: id, state: "loading", questions: current?.sessionId === id ? current.questions : [] }));
    void api(API.sessionQuestions.method, API.sessionQuestions.path({ sessionId: id })).then(result => {
      validateStreamSnapshot(`questions:${id}`, { type: "questions", sessionId: id, state: "ready", questions: result.questions });
      if (generation === selectionGeneration.current && selectedAiId(stateRef.current) === id) setPendingQuestions({ sessionId: id, state: "ready", questions: result.questions });
    }).catch(cause => {
      if (generation === selectionGeneration.current && selectedAiId(stateRef.current) === id) setPendingQuestions(current => ({ sessionId: id, state: "failed", questions: current?.sessionId === id ? current.questions : [], error: cause instanceof Error ? cause.message : String(cause) }));
    });
  }, [stateRef]);

  const showEarlier = useCallback(() => {
    const id = selectedAiId(stateRef.current);
    const window = stateRef.current.transcript;
    if (!id || !window || stateRef.current.loadingEarlier) return;
    patch({ loadingEarlier: true, earlierError: "" });
    void loadEarlier(id, window).then((result) => {
      if (selectedAiId(stateRef.current) !== id) return;
      const latest = stateRef.current.transcript;
      const changedWhilePaging = latest?.generation !== window.generation;
      const updated = !result.reset && latest?.generation === result.window.generation
        ? { ...result.window, total: Math.max(latest.total, result.window.total), items: result.window.items.map(item => latest.items.find(current => current.seq === item.seq) ?? item) }
        : changedWhilePaging ? latest ?? result.window : result.window;
      cache.rememberThread(id, { transcript: updated });
      patch({ transcript: updated, loadingEarlier: false });
      stream.current?.update({ transcriptFrom: null });
    }, (cause: unknown) => {
      if (selectedAiId(stateRef.current) !== id) return;
      patch({ loadingEarlier: false, earlierError: cause instanceof Error ? cause.message : String(cause) });
    });
  }, [cache, patch, stateRef]);

  const showNewer = useCallback(async (jump: boolean) => {
    const id = selectedAiId(stateRef.current);
    const held = stateRef.current.transcript;
    if (!id || !held || stateRef.current.loadingEarlier) return;
    patch({ loadingEarlier: true, earlierError: "" });
    try {
      const page = jump ? await loadLatest(id) : (await loadNewer(id, held)).window;
      if (selectedAiId(stateRef.current) !== id) return;
      const current = stateRef.current.transcript;
      if (current && current.generation !== held.generation && current.generation !== page.generation) return;
      const updated = current?.generation === page.generation
        ? { ...page, total: Math.max(current.total, page.total), items: page.items.map(item => current.items.find(head => head.seq === item.seq) ?? item) }
        : page;
      visibleHeads.current = null;
      cache.rememberThread(id, { transcript: updated });
      patch({ transcript: updated });
    } catch (cause) {
      if (selectedAiId(stateRef.current) === id) patch({ earlierError: cause instanceof Error ? cause.message : String(cause) });
    } finally { if (selectedAiId(stateRef.current) === id) patch({ loadingEarlier: false }); }
  }, [cache, patch, stateRef]);

  const thinkingOpen = useCallback((open: boolean) => {
    if (!mono && !autoCollapse) return;
    stream.current?.update({ thinking: open });
    if (!open) liveText.clearThinking();
  }, [autoCollapse, liveText, mono]);

  // Start the renderer before opening a thread; the stream supplies its window.
  const prefetchThread = useCallback((_id: string) => {
    void ensureMarkdown().catch(console.error);
  }, []);
  const prefetchChat = useCallback((chat: Chat) => { if (chat.kind === "ai") prefetchThread(chat.session.id); }, [prefetchThread]);

  const selectChat = useCallback(async (chat: Chat, signal?: AbortSignal) => {
    if (chat.kind === "ai") {
      patch(current => ({ discovered: [...current.sessions, ...current.discovered].some(session => session.id === chat.session.id) ? current.discovered : [...current.discovered, chat.session] }));
      if (chat.session.archivedAt) await api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: chat.session.id }), {});
      if (signal?.aborted) return;
      openChat(chat.id, { tab: conversationTab(chat.session) });
    } else if (chat.kind === "room") {
      if (chat.room.current === false) await api("POST", `/v1/rooms/${chat.room.id}/open`, {});
      if (signal?.aborted) return;
      openChat(chat.id, { tab: "chats" });
      await roomDirectory.refresh();
    } else {
      assertNever(chat, "Select chat");
    }
  }, [openChat, patch, roomDirectory.refresh]);
  const closeChat = useCallback(async (chat: Chat) => {
    if (undoCloses.isBusy(chat.id)) return;
    setClosing(current => withClose(current, chat.id));
    const result = await undoCloses.close(chat, () => chat.kind === "ai"
      ? api(API.archiveSession.method, API.archiveSession.path({ sessionId: chat.session.id }))
      : api("POST", `/v1/rooms/${chat.room.id}/close`, {}));
    if (result?.ok) {
      if (chat.kind === "ai") { interruptPrompts(chat.session.id, false); cache.forgetThread(chat.session.id); }
      if (stateRef.current.selectedChatId === chat.id) {
        liveText.reset(); patch({ selectedChatId: null, transcript: null, images: null });
        navigate(routeHome(route), { replace: true });
      }
    }
    if (!result?.ok) {
      setClosing(current => withoutClose(current, chat.id));
      if (result) setChatError(result.error);
    }
    if (chat.kind === "room") await roomDirectory.refresh();
    kick();
  }, [cache, kick, liveText, patch, route, stateRef, undoCloses, roomDirectory.refresh, interruptPrompts]);
  const undoClose = useCallback(async () => {
    const chat = undoCloses.snapshot().entries.at(-1)?.chat;
    const result = await undoCloses.undo(item => item.kind === "ai"
      ? api(API.unarchiveSession.method, API.unarchiveSession.path({ sessionId: item.session.id }), {})
      : api("POST", `/v1/rooms/${item.room.id}/open`, {}));
    if (result?.ok && chat) setClosing(current => withoutClose(current, chat.id));
    if (result) { if (chat?.kind === "room") await roomDirectory.refresh(); kick(); }
  }, [kick, undoCloses, roomDirectory.refresh]);
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
    if (!entry || undoState.restoring || !undoState.error) return;
    const id = toast.error(`Could not restore ${entry.chat.title}`, {
      description: undoState.error,
      action: { label: "Retry Undo", onClick: () => { void undoClose(); } },
    });
    return () => { toast.dismiss(id); };
  }, [undoState, undoClose]);
  const dismissChatError = useCallback(() => setChatError(""), []);
  const openInboxChat = useCallback((chat: Chat) => { void selectChat(chat).catch(cause => setChatError(String(cause))); }, [selectChat]);
  const requestCloseChat = useCallback((chat: Chat) => { void closeChat(chat); }, [closeChat]);
  const closeInboxChat = requestCloseChat;
  const chatPicker = useRef<ChatPickerHandle>(null);
  const searchArchived = useCallback((query: string) => { chatPicker.current?.open({ kind: "archived", query }); }, []);


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
      stream.current?.invalidate(`transcript:${id}`);
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
    if (action === "stop") interruptPrompts(sessionId, descendants);
    setPending(true);
    setControlError(null);
    try {
      await submitThreadControl(action === "stop" ? { threadId: sessionId, action, descendants } : { threadId: sessionId, action });
    } catch (error) {
      setControlError({ sessionId, message: error instanceof Error ? error.message : String(error) });
    } finally { setPending(false); kick(); }
  };
  const stopThread = (session: Session) => requestStop(session, (id, descendants) => { void controlThread(id, "stop", descendants); });

  const sending = useRef(false);
  const send = async () => {
    const session = selectedSession();
    if (!session || pending || sending.current) return;
    const sessionAttachments = stateRef.current.attachments.filter((file) => file.sessionId === session.id);
    if (sessionAttachments.some((file) => file.uploading)) return;
    const attachments = sessionAttachments.filter((file) => file.path);
    const draft = promptDraft.current;
    const text = draft.trim();
    if (!text && !attachments.length) return;
    sending.current = true;
    const selectedReply = replyRef.current;
    const replyVersion = replyDrafts.version(session.id);
    const command = text.startsWith("/") ? state.slashCommands.find((candidate) => candidate.name === text.slice(1).split(/\s/, 1)[0]) : null;
    setControlError(null);
    setPending(true);
    try {
      const attachmentText = attachments.length ? `The following files were attached to this message:\n${attachments.map((file) => `- ${file.path}`).join("\n")}` : "";
      const bodyText = [text, attachmentText].filter(Boolean).join("\n\n");
      if (command && !attachments.length && !selectedReply) await api(API.sessionCommand.method, API.sessionCommand.path({ sessionId: session.id }), { requestId: crypto.randomUUID(), name: command.name, args: text.slice(command.name.length + 2).trim() }, 130_000);
      else {
        const requestId = crypto.randomUUID();
        const entry: PromptOutboxEntry = { requestId, sessionId: session.id, createdAt: Date.now(),
          bodyJson: JSON.stringify({ requestId, text: bodyText, ...(selectedReply ? { replyTo: selectedReply.identity.id } : {}) }),
          outcome: { kind: "pending", reason: "saved", message: "Saving and sending this message." } };
        localPromptDrafts.current.set(requestId, { sessionId: session.id, draft, replyVersion });
        updateLocalPrompt(entry);
        setSentPrompt({ sessionId: session.id, requestId });
        if (hasNewer(stateRef.current.transcript)) void showNewer(true);
        ownedPrompts.current.set(requestId, session.id);
        void submitSavedPrompt(requestId);
      }
      if (selectedAiId(stateRef.current) === session.id) {
        if (promptDraft.current === draft) promptDraft.current = "";
        setPrompt(current => current === draft ? "" : current);
      }
      if (command && !attachments.length && !selectedReply) {
        if (loadDraft(session.id) === draft) saveDraft(session.id, "");
        replyDrafts.accept(session.id, replyVersion);
      }
      if (replyDrafts.version(session.id) === replyVersion && selectedAiId(stateRef.current) === session.id) {
        replyRef.current = null;
        setReply(null);
      }
      const sentIds = new Set(attachments.map((file) => file.localId));
      patch((current) => ({ attachments: current.attachments.filter((file) => !sentIds.has(file.localId)) }));
    } catch (error) {
      setControlError({ sessionId: session.id, message: error instanceof Error ? error.message : String(error) });
    } finally { sending.current = false; setPending(false); kick(); }
  };

  useEffect(() => {
    const id = aiId;
    if (!id || !prompt.startsWith("/") || state.slashCommands.length) return;
    api(API.sessionCommands.method, API.sessionCommands.path({ sessionId: id })).then((result) => patch({ slashCommands: result.commands || [{ name: "compact", description: "Compact the current conversation context" }] })).catch(console.error);
  }, [patch, prompt, aiId, state.slashCommands.length]);

  const queueAction = async (message: QueuedMessage, action: QueueAction) => {
    const session = selectedSession();
    if (!session) return;
    const route = API.queueItem;
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

  const dashboard = state.dashboard;
  const threadStarts = useMemo(() => state.bootstrap?.threadStarts ?? [], [state.bootstrap]);
  const home = state.bootstrap?.home ?? "/";
  const previousRooms = useRef(roomDirectory.rooms);
  useEffect(() => {
    const previous = { sessions: [], rooms: previousRooms.current };
    previousRooms.current = roomDirectory.rooms;
    if (routeChat?.startsWith("room:") && selectionAfterSync(routeChat, previous, { ...previous, rooms: roomDirectory.rooms }) !== routeChat) {
      patch({ selectedChatId: null });
      navigate(routeHome(route), { replace: true });
    }
  }, [roomDirectory.rooms, routeChat, route, patch, stateRef]);
  const listedRows = useMemo(() => inboxRows(state.sessions, threadStarts, roomDirectory.rooms), [state.sessions, threadStarts, roomDirectory.rooms]);
  useEffect(() => { setClosing(current => reconcileCloses(current, listedRows.map(row => row.chat.id))); }, [listedRows]);
  const rows = useMemo(() => hideClosing(listedRows, closing), [listedRows, closing]);
  const knownSessions = useMemo(() => {
    const present = new Set(state.sessions.map(session => session.id));
    const extra = [...state.fleet, ...state.discovered].filter(session => !present.has(session.id) && (present.add(session.id), true));
    return extra.length ? [...state.sessions, ...extra] : state.sessions;
  }, [state.sessions, state.fleet, state.discovered]);
  const selected = knownSessions.find((session) => session.id === aiId) ?? null;
  const ancestors = useMemo(() => {
    const chain: Session[] = [];
    let cursor = selected?.parentId ? knownSessions.find(session => session.id === selected.parentId) : undefined;
    while (cursor && chain.length < 8) { chain.unshift(cursor); cursor = cursor.parentId ? knownSessions.find(session => session.id === cursor!.parentId) : undefined; }
    return chain;
  }, [selected, knownSessions]);
  const visibleAttachments = state.attachments.filter((file) => file.sessionId === aiId);
  const pendingPromptEntries = useMemo(() => {
    const entries = new Map(outboxEntries.map(entry => [entry.requestId, entry]));
    for (const entry of localPromptEntries) entries.set(entry.requestId, entry);
    return [...entries.values()].filter(entry => entry.sessionId === aiId);
  }, [outboxEntries, localPromptEntries, aiId]);
  const durableEntries = useMemo(() => {
    if (state.transcript === null) return [];
    const inputs = new Map(selected?.inputs?.map(input => [input.id, input]));
    const source = state.transcript.items.map(head => head.kind === "user" && head.inputId && inputs.has(head.inputId)
      ? { ...head, inputState: inputs.get(head.inputId) } : head);
    const heads = mono ? monoTranscript(source) : source;
    return heads.length ? entriesFromHeads(heads) : mono ? [] : [WAITING_ENTRY];
  }, [state.transcript, mono, selected?.inputs]);
  const contextEntries = useMemo(() => reconcilePromptEntries(durableEntries, pendingPromptEntries,
    new Set([...activePromptIds, ...localPromptEntries.filter(entry => entry.outcome.kind === "pending" && entry.outcome.reason === "saved").map(entry => entry.requestId)])),
    [durableEntries, pendingPromptEntries, activePromptIds, localPromptEntries]);
  useEffect(() => {
    const owner = outbox.current;
    if (!owner) return;
    const captured = capturedPromptIds(durableEntries, pendingPromptEntries);
    if (!captured.length) return;
    void (async () => {
      for (const requestId of captured) {
        const removed = await owner.store.acknowledge(requestId);
        if (outbox.current !== owner) return;
        if (!removed.ok && removed.error.kind !== "not_found") { toast.error(removed.error.message); return; }
        localPrompts.current.delete(requestId);
      }
      setLocalPromptEntries([...localPrompts.current.values()]);
      await refreshOutbox();
    })();
  }, [durableEntries, pendingPromptEntries, refreshOutbox]);
  const bodies = useMemo(() => aiId ? new ItemBodies(aiId, undefined, cache) : null, [aiId, cache]);
  // The newest head of a window, and of every update, carries its body when it
  // is small. Taking it here is what lets the step a person opens first render
  // whole without a request.
  useEffect(() => { bodies?.accept(state.transcript?.items ?? []); }, [bodies, state.transcript]);
  const modelCounts = useMemo(() => new Map((dashboard?.modelCounts ?? []).map((model) => [model.key, model.count])), [dashboard]);
  const images = useMemo(() => state.images ? new Map(state.images.images.map(image => [image.id, image])) : null, [state.images]);
  const showPlace = useMemo(() => new Set(state.sessions.map(session => `${session.environment}/${session.workspaceName}`)).size > 1, [state.sessions]);
  const attentionCount = rows.filter(row => row.section === "attention").length;
  const badges = {
    chats: { count: attentionCount || rows.length, attention: attentionCount > 0 },
    machine: { count: state.ownerErrors.length + (state.offline ? 1 : 0), attention: true },
  };
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const discoveryRef = useRef<ThreadDiscovery<Session> | null>(null);
  const getDiscovery = useCallback(() => discoveryRef.current ??= new ThreadDiscovery<Session>({
    known: id => {
      const current = stateRef.current;
      return [...current.sessions, ...current.fleet, ...current.discovered].some(session => session.id === id);
    },
    load: async id => {
      try {
        const result = await api(API.session.method, API.session.path({ sessionId: id }));
        const session = result?.session;
        validateSession(session);
        if (session.id !== id) return { ok: false, error: { code: "invalid_response", message: "Thread lookup returned a different thread" } };
        return { ok: true, value: session };
      } catch (cause) {
        return { ok: false, error: { code: cause instanceof ApiError && cause.code ? cause.code : "request_failed",
          message: cause instanceof Error ? cause.message : String(cause) } };
      }
    },
    accept: session => patch(state => [...state.sessions, ...state.fleet, ...state.discovered].some(item => item.id === session.id)
      ? {} : { discovered: [...state.discovered, session] }),
    changed: () => setDiscoveryRevision(value => value + 1),
    now: Date.now,
  }), [patch, stateRef]);
  useEffect(() => () => {
    discoveryRef.current?.dispose();
    discoveryRef.current = null;
  }, [getDiscovery]);
  const discoverThreads = useCallback((ids: string[]) => getDiscovery().discover(ids), [getDiscovery]);
  const threadDirectory = useMemo<ThreadDirectory>(() => ({
    name: id => knownSessions.find(session => session.id === id)?.name || null,
    busy: id => { const session = knownSessions.find(item => item.id === id); return session ? working(session) : false; },
    open: id => openThreadId(id),
    discover: discoverThreads,
    lookupError: id => knownSessions.some(session => session.id === id) ? null : discoveryRef.current?.error(id) ?? null,
  }), [knownSessions, openThreadId, discoverThreads, discoveryRevision]);

  const panel = "panel" in route ? route.panel : null;
  const showDetail = route.tab === "agents" || route.tab === "machine" || route.tab === "settings" || route.tab === "files" || !!routeChat;

  const picker = useMemo(() => <LazyChatPicker ref={chatPicker} starts={threadStarts} onSelect={selectChat} onCreated={id => openThreadId(id, "chats")} onSettled={kick} rooms={state.bootstrap?.rooms ? roomDirectory : undefined} onRoomCreated={id => openChat(`room:${id}`)} />,
    [threadStarts, selectChat, openThreadId, kick, state.bootstrap?.rooms, roomDirectory, openChat]);

  const conversation = roomId
    ? <RoomConversation key={roomId} id={roomId} people={roomDirectory.people} onBack={closeDetail} showBack={layout === "phone"} showIdentity={showConversationIdentity} onRefresh={roomDirectory.refresh} />
    : selected
    ? <ItemBodiesContext.Provider value={bodies}><LiveConversation sentPromptId={sentPrompt?.sessionId === selected.id ? sentPrompt.requestId : undefined} onRetryPrompt={id => void submitSavedPrompt(id)} onDiscardPrompt={id => void discardSavedPrompt(id)} outbox={<PromptOutboxStatus entries={[]} busyRequestId={outboxBusy} storage={localPromptEntries.length ? undefined : { state: storageState, retry: () => void ensureOutbox() }} onRetry={id => void submitSavedPrompt(id)} onDiscard={id => void discardSavedPrompt(id)} />} live={liveText} session={selected} mono={mono && manager ? { hintSeen: manager.hintSeen, onClassic: () => void updateManager("classic"), onHintSeen: () => void updateManager("mono", true), saving: managerSaving } : undefined} ancestors={ancestors} entries={contextEntries} images={images} offline={state.offline} syncing={state.threadSyncing} pending={pending} home={home} prompt={prompt}
        onVisibleRange={onVisibleHeads} newerAvailable={hasNewer(state.transcript)} onShowNewer={() => void showNewer(false)} onJumpLatest={() => void showNewer(true)} earlierAvailable={hasEarlier(state.transcript)} loadingEarlier={state.loadingEarlier} earlierError={state.earlierError} onShowEarlier={showEarlier} onThinkingOpen={thinkingOpen} autoCollapse={autoCollapse}
        attachments={visibleAttachments.map(file => ({ id: file.localId, name: file.name, uploading: file.uploading }))} slashCommands={state.slashCommands} drawing={drawing} uploadError={uploadError?.sessionId === aiId ? uploadError.message : ""} controlError={controlError?.sessionId === aiId ? controlError.message : ""} questionsResource={pendingQuestions?.sessionId === aiId ? pendingQuestions : undefined} onRetryQuestions={retryQuestions} showBack={layout === "phone" || manager?.view === "mono"} showIdentity={showConversationIdentity}
        onBack={closeDetail} onOpenInspector={() => openPanel("inspector")} onOpenAncestor={session => openThreadId(session.id)} onOpenQueue={() => openPanel("queue")} questions={pendingQuestions?.sessionId === selected.id ? prioritizeQuestion(pendingQuestions.questions, route.tab === "chats" ? route.questionId : undefined) : []} onQuestionAccepted={id => { setPendingQuestions(current => current?.sessionId === selected.id ? { ...current, questions: current.questions.filter(question => question.id !== id) } : current); }} onEdit={editFrom} reply={reply} onReply={target => { replyRef.current = target; setReply(target); replyDrafts.save(selected.id, target); }} onCancelReply={() => { replyRef.current = null; setReply(null); replyDrafts.save(selected.id, null); }} onPrompt={text => { promptDraft.current = text; setPrompt(text); if (aiId) saveDraft(aiId, text); }} onSend={() => void send()} onStop={() => stopThread(selected)} onResume={() => void controlThread(selected.id, "resume")} onReconnect={reconnect}
        onRemoveAttachment={id => { const file = visibleAttachments.find(item => item.localId === id); if (file) void removeAttachment(file); }} onUpload={files => void uploadFiles(files)} onPaste={() => setPasteSessionId(aiId)} onDraw={() => drawing.open()} onDismissControlError={() => setControlError(null)} /></ItemBodiesContext.Provider>
    : routeChat && state.syncing
        ? <section className="empty-state"><strong>Opening…</strong></section>
        : <section className="empty-state"><strong>Choose a chat</strong></section>;

  const list = (() => {
    switch (route.tab) {
      case "chats":
        if (!state.bootstrap) return <section className="empty-state" aria-busy={!state.offline} aria-live="polite">
          <strong>{state.offline ? "Chats unavailable" : "Connecting to your chats…"}</strong>
          <span>{state.offline || "Waiting for the selected environment to return its conversation list."}</span>
          {state.offline && <button type="button" className="accent" onClick={reconnect}>Reconnect</button>}
        </section>;
        return <Inbox rows={rows} selectedId={routeChat} showPlace={showPlace} compactSelected={layout !== "phone"} error={chatError || roomDirectory.error} onDismissError={dismissChatError} picker={picker} onOpen={openInboxChat} onPrefetch={prefetchChat} onClose={closeInboxChat} onSearchArchived={searchArchived} onSelectedVisibleChange={onSelectedVisibleChange} />;
      case "agents": case "machine": case "settings": case "files": return null;
    }
    return assertNever(route, "App list route");
  })();

  function filesScreen(mode: "stack" | "split") {
    const seen = new Set(["/", home]);
    const shortcuts = [{ label: "Home", path: home }, ...state.sessions.filter(session => {
      if (session.parentId || !session.cwd || seen.has(session.cwd)) return false;
      seen.add(session.cwd);
      return true;
    }).slice(0, 6).map(session => ({ label: session.name || session.cwd, path: session.cwd }))];
    return <Suspense fallback={<Loading label="Loading files…" />}><FilesScreen onEditorState={setEditorOpen} layout={mode} selectedPath={route.tab === "files" ? route.path : null} shortcuts={shortcuts} onAttach={selectedAiId(stateRef.current) ? path => void attachPath(path) : undefined} onSelect={path => navigate({ tab: "files", path }, { replace: mode === "split" || !path })} /></Suspense>;
  }

  const detail = (() => {
    switch (route.tab) {
      case "agents": return <Suspense fallback={<Loading label="Loading agents…" />}><AgentsScreen liveSessions={state.sessions} fleet={state.fleet} onOpen={id => openThreadId(id, "chats")} /></Suspense>;
      case "machine": return <Suspense fallback={<Loading label="Loading the machine…" />}><MachineTab dashboard={dashboard} modelCounts={modelCounts} ownerErrors={state.ownerErrors} offline={state.offline} syncing={state.syncing} onDismissOwnerError={id => void dismissServerError(id)} onReconnect={reconnect} /></Suspense>;
      case "settings": return <Suspense fallback={<Loading label="Loading settings…" />}><SettingsScreen sessions={knownSessions} initialThreadId={selectedAiId(stateRef.current)} update={update} autoCollapse={autoCollapse} onAutoCollapseChange={updateAutoCollapse} onOpenThread={openThreadId} /></Suspense>;
      case "files": return filesScreen(layout === "phone" ? "stack" : "split");
      case "chats": return <ThreadDirectoryProvider value={threadDirectory}>{conversation}</ThreadDirectoryProvider>;
    }
    return assertNever(route, "App detail route");
  })();

  const showTabs = route.tab === "agents" || route.tab === "machine" || route.tab === "settings" || (route.tab === "files" && !route.path) || !showDetail;
  return <ClientCacheContext.Provider value={cache}><NotificationProvider sessionId={roomId ? `room:${roomId}` : routeThreadId(route)}>
    <Shell layout={layout} mono={mono} bare={route.tab === "files" && editorOpen} nav={<TabNav layout={layout} active={route.tab} badges={badges} onSelect={selectTab} onPrepare={prepareTab} onMono={managerOwnerId && !managerSaving ? () => void updateManager("mono") : undefined} update={update} />} list={mono ? null : list} detail={detail} showDetail={showDetail} showTabs={showTabs}
      overlays={<>
        {managerError && <aside className="manager-error"><DismissibleError message={managerError} dismissLabel="Dismiss manager connection error" /><button type="button" onClick={() => setManagerRefresh(value => value + 1)}>Retry manager connection</button></aside>}
        <AppUpdateStatus update={update} />
        <ToastViewport scope={`${person}:${state.bootstrap?.environmentId || ""}`} position={layout === "phone" && !showTabs ? "top-center" : "bottom-center"} />
        {fileDrag && aiId && <div className="file-drop-overlay" role="status">Drop files to attach to {selected?.name || "this conversation"}</div>}
        {/* The sheets and the paste dialog mount when they open, so their
            chunks arrive with the gesture that asks for them. */}
        {!mono && selected && (panel === "inspector" || panel === "settings") && <Suspense fallback={null}><InspectorSheet key={selected.id} session={selected} sessions={knownSessions} open pending={pending} onClose={closePanel} onOpenThread={session => openThreadFromPanel(session.id)} onOpenThreadId={openThreadFromPanel} onArchive={() => { closePanel(); requestCloseChat({ id: `ai:${selected.id}`, kind: "ai", title: selected.name, name: null, icon: "", label: "", session: selected }); }} onRestore={() => void selectThread(selected.id)} onBackground={() => {
          void api(API.sessionPlacement.method, API.sessionPlacement.path({ sessionId: selected.id }), { foreground: false }).then(() => { panelPushed.current = false; navigate({ tab: "chats", chat: null, panel: null }); kick(); }, cause => setControlError({ sessionId: selected.id, message: String(cause) }));
        }} /></Suspense>}
        {selected && panel === "queue" && <Suspense fallback={null}><QueueSheet open messages={selected.queuedMessages} held={selected.held} pending={pending} onClose={closePanel} onAction={(message, action) => void queueAction(message, action)} /></Suspense>}
        {pasteSessionId && <Suspense fallback={null}><PasteTextDialog name={pasteName} content={pasteContent} onNameChange={setPasteName} onContentChange={setPasteContent} onAttach={file => uploadFile(file, pasteSessionId)} onClose={() => setPasteSessionId(null)} /></Suspense>}
      </>} />
  </NotificationProvider></ClientCacheContext.Provider>;
}


export { threadStatus };
