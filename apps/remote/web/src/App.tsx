import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { API } from "../../server/api";
import type { GovernorProvider, GovernorState, ThreadStartModel } from "../../server/protocol";
import { deleteCachedContext, readCachedContext, writeCachedContext } from "./context-cache";
import { api, piFetch, registerUnlockHandler, syncRequest } from "./client";
import { ContextTranscript, CopyButton, Markdown, modelContextEntries } from "./context";
import { FileExplorer } from "./file-explorer";
import { createPollSchedule } from "./poll-schedule";
import { updateDocument } from "./sync";
import { threadsInOrder } from "./thread-order";
import type { AgentHostStatus, AgentRun, AgentRunEvent, Attachment, ContextEntry, Dashboard, Governor, GovernorControls, MachineActionState, PlanCard, QueuedMessage, Session, SlashCommand, SyncRequest, ThreadSettings, ThreadStart } from "./types";

// Everything the server owns arrives through one long poll and is replaced
// wholesale per section; the client never patches a server-owned value from a
// mutation response. What remains local is the view (which thread, which
// drawer tab), the verified documents for that view, and composer scratch.
interface AppState {
  selectedId: string | null;
  agentRunId: string | null;
  drawerTab: DrawerTab;
  drawerOpen: boolean;
  settingsOpen: boolean;
  sessions: Session[];
  archived: Session[];
  archivedTotal: number;
  /** A dropped drawer order shown until the server confirms it. */
  pendingOrder: string[] | null;
  dashboard: Dashboard | null;
  context: SyncDocument | null;
  liveText: SyncDocument | null;
  liveThinking: SyncDocument | null;
  agentRun: AgentRun | null;
  agentEntries: ContextEntry[];
  agentText: SyncDocument | null;
  agentThinking: SyncDocument | null;
  attachments: Attachment[];
  slashCommands: SlashCommand[];
  offline: string;
}

const initialState: AppState = {
  selectedId: null, agentRunId: null, drawerTab: "threads", drawerOpen: innerWidth >= 1000, settingsOpen: false,
  sessions: [], archived: [], archivedTotal: 0, pendingOrder: null, dashboard: null,
  context: null, liveText: null, liveThinking: null,
  agentRun: null, agentEntries: [], agentText: null, agentThinking: null,
  attachments: [], slashCommands: [], offline: "",
};

function normalizedActivity(activity = "IDLE") {
  return activity.trim().toUpperCase().replace(/[\s-]+/g, "_") || "IDLE";
}
function activityLabel(activity = "IDLE", tool = "") {
  const normalized = normalizedActivity(activity);
  if (normalized === "WAITING_ON_TOOL") return tool ? `WAITING ON ${tool.toUpperCase()}` : "WAITING ON TOOL";
  if (normalized === "RUNNING") return "WORKING";
  return normalized.replaceAll("_", " ");
}
function activityColor(activity = "IDLE") {
  const normalized = normalizedActivity(activity);
  return ["FAILED", "ABORTING"].includes(normalized) ? "var(--danger)" : normalized === "IDLE" ? "var(--muted)" : "var(--accent)";
}
function working(session: Session | null) { return Boolean(session && ["RUNNING", "STARTING", "ABORTING"].includes(session.state)); }
function threadProvider(session: Session) {
  return session.environment === "work" ? "work" : session.environment === "converge" ? "converge" : session.environment === "personal" ? "personal" : session.provider === "anthropic" ? "anthropic" : "openai";
}
function draftKey(id: string) { return `pi-remote-draft:${id}`; }
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
  const [people, setPeople] = useState<Array<{ user: string; displayName?: string }>>([]);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    registerUnlockHandler(async (nextMessage) => {
      setMessage(nextMessage);
      setKey("");
      try {
        const response = await fetch(API.environment.path(), { cache: "no-store", headers: { accept: "application/json" } });
        const result = await response.json();
        setPeople(result?.environment?.persons || result?.persons || []);
      } catch {}
      dialog.current?.showModal();
      return new Promise<string>((resolve) => { resolver.current = resolve; });
    });
  }, []);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!key) return;
    resolver.current?.(key);
    resolver.current = null;
    dialog.current?.close();
  };
  return <dialog ref={dialog} className="unlock-dialog" aria-labelledby="unlock-title">
    <form className="unlock-form" onSubmit={submit}>
      <h2 id="unlock-title">Unlock your folder</h2>
      <p>Your threads and private folder are encrypted on the machine. This key stays on this device and opens them while your agents are running.</p>
      {people.length > 1 && <div className="unlock-field"><label htmlFor="unlock-person">Person</label><select id="unlock-person" value={window.PiRemotePerson?.get() || people[0]?.user || ""} onChange={(event) => window.PiRemotePerson?.set(event.target.value)}>{people.map((person) => <option key={person.user} value={person.user}>{person.displayName || person.user}</option>)}</select></div>}
      <div className="unlock-field"><label htmlFor="unlock-key">Key</label><input id="unlock-key" type="password" autoComplete="current-password" spellCheck={false} required value={key} onChange={(event) => setKey(event.target.value)} /></div>
      {message && <p className="unlock-error">{message}</p>}
      <div className="unlock-actions"><button className="accent" type="submit">Unlock</button></div>
    </form>
  </dialog>;
}

function EnvironmentControl() {
  const [environment, setEnvironment] = useState<any>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => { window.KenanRemote?.getState().then((value) => { setEnvironment(value); document.title = "Kenan"; }).catch((error) => setFailed(String(error?.message || error))); }, []);
  if (!environment && !failed) return null;
  return <div className={`environment-control${failed ? " failed" : ""}`} title={failed}>
    <label htmlFor="environment-select">Environment</label>
    <select id="environment-select" aria-label="Environment" value={environment?.id || ""} disabled={Boolean(failed)} onChange={async (event) => {
      const id = event.target.value;
      try {
        const selected = await window.KenanRemote?.select?.({ id, user: window.PiRemotePerson?.get() || "" });
        if (selected) location.reload();
      } catch (error: any) { setFailed(error?.message || "Could not switch environment"); }
    }}>{(environment?.environments || []).map((candidate: any) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>
  </div>;
}

const GOVERNOR_CLASS: Record<GovernorState, string> = { off: "", green: " active boost-green", blue: " active boost-blue", red: " active halted" };
function governorDescription(name: string, governor: Governor) {
  const current: Record<GovernorState, string> = { off: "normal local allowance", green: "3× local allowance", blue: `${governor.boostedMultiplier}× local allowance`, red: "a launch halt" };
  return `${name} governor is using ${current[governor.state]}. Select to change it`;
}
function MachineControls({ actions, governors, onAction, onGovernor }: { actions: MachineActionState[]; governors: GovernorControls | null; onAction(id: string): void; onGovernor(provider: GovernorProvider): void }) {
  return <div className="machine-controls" aria-label="This machine controls">
    {actions.map((action) => <button key={action.id} className={`machine-control${action.active ? " active" : ""}`} type="button" aria-label={`${action.label} is ${action.active ? "on" : "off"}. Select to turn it ${action.active ? "off" : "on"}`} onClick={() => onAction(action.id)}><img src={action.icon.startsWith("/") || action.icon.startsWith("data:") ? action.icon : `/${action.icon}.svg`} alt="" /></button>)}
    {governors && (["openai", "anthropic"] as const).map((provider) => {
      const description = governorDescription(provider === "openai" ? "OpenAI" : "Anthropic", governors[provider]);
      return <button key={provider} className={`machine-control${GOVERNOR_CLASS[governors[provider].state]}`} type="button" aria-label={description} title={description} onClick={() => onGovernor(provider)}><img src={`/${provider}.svg`} alt="" /></button>;
    })}
  </div>;
}

function PlanSummary({ plans, counts }: { plans: PlanCard[]; counts: Map<string, number> }) {
  return <div className="plan-summary muted">{plans.flatMap((card) => card.metrics.filter((metric) => metric.text !== "—").map((metric) => {
    const description = `${card.label} ${metric.modelLabel}, ${counts.get(metric.model) || 0} in use, ${metric.description}`;
    return <div className="capacity-row" key={`${card.icon}:${metric.model}`} title={description} aria-label={description}><img src={`/${encodeURIComponent(card.icon)}.svg`} alt={card.label} /><span className="capacity-model">{metric.modelLabel}</span><span className="capacity-count">{counts.get(metric.model) || 0}</span><span className="capacity-cache">{metric.cacheText}</span><span className="capacity-value">{metric.text}</span></div>;
  }))}</div>;
}

type DrawerTab = "threads" | "agents" | "archived" | "files";

function DrawerTabIcon({ tab }: { tab: DrawerTab }) {
  if (tab === "threads") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Zm4 5h8" /></svg>;
  if (tab === "agents") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M12 7.5v4M6 15.5v-4h12v4" /></svg>;
  if (tab === "archived") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v12H4V8Zm-1-4h18v4H3V4Zm6 9h6" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v10H3v-12Z" /></svg>;
}

function ThreadRow({ session, selected, archived, onSelect, onArchive, onUnarchive }: { session: Session; selected: boolean; archived?: boolean; onSelect(id: string): void; onArchive(id: string): void; onUnarchive(id: string): void }) {
  const provider = threadProvider(session);
  const alt = provider === "work" ? "Work" : provider === "converge" ? "Cloud" : provider === "personal" ? "Personal" : provider === "anthropic" ? "Anthropic" : "OpenAI";
  const content = <><span className="thread-name">{session.name || "Agent"}</span><span className="thread-meta"><img className="thread-provider" src={`/${provider}.svg`} alt={alt} title={`${alt} thread`} /><span className="thread-state" style={{ color: activityColor(archived ? "IDLE" : session.activity) }}>{archived ? "ARCHIVED" : activityLabel(session.activity, session.activeTool ?? "")}</span></span></>;
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

function AgentList({ runs, hosts, selectedId, onSelect }: { runs: AgentRun[]; hosts: AgentHostStatus[]; selectedId: string | null; onSelect(run: AgentRun): void }) {
  return <div className="agent-list">{hosts.map((host) => {
    const owned = runs.filter((run) => run.host === host.key);
    return <div key={host.key}><div className={`agent-host${host.error ? " failed" : ""}`}><span>{host.name}</span><span>{host.error ? "unreachable" : host.running}</span></div>{host.error ? <div className="agent-empty">{host.error}</div> : !owned.length ? <div className="agent-empty">No agents working</div> : owned.map((run) => <button key={run.id} type="button" className={`agent-row${selectedId === run.id ? " selected" : ""}`} onClick={() => onSelect(run)}><span className="agent-row-title"><span className="agent-row-label">{run.teamRole === "supervisor" ? "SUPERVISOR" : run.teamRole === "worker" ? `WORKER ${run.teamSlot ?? ""}` : run.label}</span><span className="agent-row-task">{run.taskId}</span></span><span className="agent-row-meta" style={{ color: run.status === "running" ? activityColor(run.activity) : "var(--muted)" }}>{run.status === "running" ? activityLabel(run.activity, run.activeTool ?? "") : run.status.toUpperCase()}</span></button>)}</div>;
  })}</div>;
}

type ThreadStartChoice = { id: string; label: string; icon: string; accent?: string; models?: ThreadStartModel[] };

function darkGlyph(accent = "#89b4fa") {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return true;
  const [red, green, blue] = [1, 3, 5].map((at) => parseInt(accent.slice(at, at + 2), 16));
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 >= 0.5;
}

function ThreadStartMenu({ starts, onCreate }: { starts: ThreadStart[]; onCreate(destination: string, model: string | null): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ThreadStart | null>(null);
  const [origin, setOrigin] = useState(0);
  const choices: ThreadStartChoice[] = chosen?.models || starts;
  const stage = chosen?.id || "destinations";
  const size = Math.max(34, Math.min(42, Math.floor((310 - 12 * Math.max(0, choices.length - 1)) / Math.max(1, choices.length))));
  const target = (index: number) => -(choices.length - 1 - index) * (size + 12);
  const close = useCallback(() => { setOpen(false); setChosen(null); setOrigin(0); }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); window.removeEventListener("keydown", onKeyDown); };
  }, [close, open]);

  useEffect(() => { close(); }, [close, starts]);

  const choose = (choice: ThreadStartChoice, index: number) => {
    if (!chosen && choice.models?.length) {
      setOrigin(target(index));
      setChosen(choice as ThreadStart);
      return;
    }
    onCreate(chosen?.id || choice.id, chosen ? choice.id : null);
    close();
  };
  const shapeTransition = { type: "spring" as const, stiffness: 390, damping: 18, mass: 0.8 };
  const faceTransition = { type: "spring" as const, stiffness: 650, damping: 28, mass: 0.7 };

  return <MotionConfig reducedMotion="user"><div ref={root} className={`new-thread-buttons react-thread-start${open ? " expanded" : ""}`}>
    <svg className="motion-definitions" aria-hidden="true"><defs><filter id="thread-goo" x="-40%" y="-240%" width="180%" height="580%" colorInterpolationFilters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blurred" /><feColorMatrix in="blurred" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -10" /></filter></defs></svg>
    <div className="new-thread-shapes">
      <AnimatePresence initial={false}>
        {!open && <motion.span key="trigger-shape" className="thread-start-shape trigger" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={shapeTransition} />}
        {open && choices.map((choice, index) => <motion.span key={`${stage}:${choice.id}:shape`} className="thread-start-shape" style={{ width: size, height: size, marginTop: -size / 2, background: choice.accent || "var(--accent)" }} initial={{ x: origin, scale: 0 }} animate={{ x: target(index), y: 0, scale: 1 }} exit={{ x: open ? target(index) : 0, y: chosen ? 110 : 0, scale: 0 }} transition={{ ...shapeTransition, delay: index * 0.04 }} />)}
      </AnimatePresence>
    </div>
    <div className="new-thread-faces">
      <AnimatePresence initial={false}>
        {!open && <motion.button key="trigger-face" type="button" className="provider-button trigger" aria-label="New thread" disabled={!starts.length} initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={faceTransition} onClick={() => setOpen(true)} whileTap={{ scale: 0.86 }}><span className="glyph" /></motion.button>}
        {open && choices.map((choice, index) => {
          const label = chosen ? `Start a ${chosen.label} thread on ${choice.label}` : choice.models?.length ? `${choice.label} threads` : `Start a ${choice.label} thread`;
          return <motion.button key={`${stage}:${choice.id}:face`} type="button" className="provider-button" style={{ width: size, height: size, marginTop: -size / 2 }} aria-label={label} title={label} initial={{ x: origin, scale: 0, opacity: 0 }} animate={{ x: target(index), y: 0, scale: 1, opacity: 1 }} exit={{ x: open ? target(index) : 0, y: chosen ? 110 : 0, scale: 0, opacity: 0 }} transition={{ ...faceTransition, delay: index * 0.04 }} whileTap={{ scale: 0.84 }} onClick={() => choose(choice, index)}><span className={`glyph${darkGlyph(choice.accent) ? " dark" : ""}`}><img src={`/${choice.icon}.svg`} alt="" draggable={false} /></span></motion.button>;
        })}
      </AnimatePresence>
    </div>
  </div></MotionConfig>;
}

function settingLabel(value: string) {
  if (value === "xhigh") return "Extra high";
  return value ? value[0].toUpperCase() + value.slice(1).replaceAll("_", " ") : "";
}

function SettingsPanel({ session, open, onClose }: { session: Session | null; open: boolean; onClose(): void }) {
  const [settings, setSettings] = useState<ThreadSettings | null>(null);
  const [saving, setSaving] = useState("");
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!open || !session) return;
    let cancelled = false;
    setSettings(null);
    setSaving("");
    setFailure("");
    api(API.sessionSettings.method, API.sessionSettings.path({ sessionId: session.id }))
      .then((result) => { if (!cancelled) setSettings(result.settings); })
      .catch((error) => { if (!cancelled) setFailure(error?.message || String(error)); });
    return () => { cancelled = true; };
  }, [open, session?.id]);
  const update = async (field: string, body: Record<string, string>) => {
    if (!session || saving) return;
    setSaving(field);
    setFailure("");
    try {
      const result = await api(API.updateSessionSettings.method, API.updateSessionSettings.path({ sessionId: session.id }), body);
      setSettings(result.settings);
    } catch (error) { setFailure(error?.message || String(error)); }
    finally { setSaving(""); }
  };
  return <><AnimatePresence>{open && <motion.div key="settings-scrim" className="scrim settings-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />}</AnimatePresence>
    <AnimatePresence>{open && <motion.aside key="settings-panel" className="settings" aria-label="Thread settings" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.9 }}>
      <header className="settings-header"><div className="settings-title"><span>Thread settings</span><h2 title={session?.name}>{session?.name || "Thread"}</h2></div><button type="button" className="settings-close" aria-label="Close thread settings" onClick={onClose}>×</button></header>
      <div className="settings-body">{failure && <p className="setting-unavailable" role="alert">{failure}</p>}{!settings ? !failure && <div className="settings-loading" aria-label="Loading thread settings"><span /><span /><span /></div> : <>
        <section className="setting-card">
          <div className="setting-heading"><div><h3>Model</h3><p>The model used for new messages</p></div>{saving === "model" && <span className="setting-saving">Saving</span>}</div>
          <div className="setting-select"><select aria-label="Model" value={`${settings.model?.provider}\0${settings.model?.id}`} disabled={Boolean(saving)} onChange={(event) => { const [modelProvider, modelId] = event.target.value.split("\0"); void update("model", { modelProvider, modelId }); }}>{settings.models.map((model) => <option key={`${model.provider}:${model.id}`} value={`${model.provider}\0${model.id}`}>{model.name || model.id} · {model.provider}</option>)}</select><span aria-hidden="true">⌄</span></div>
        </section>
        <section className="setting-card">
          <div className="setting-heading"><div><h3>Thinking</h3><p>How much reasoning the model can use</p></div>{saving === "thinking" && <span className="setting-saving">Saving</span>}</div>
          <div className="setting-options thinking-options" role="radiogroup" aria-label="Thinking level">{settings.thinkingLevels.map((level) => <button key={level} type="button" role="radio" aria-checked={settings.thinkingLevel === level} className={settings.thinkingLevel === level ? "selected" : ""} disabled={Boolean(saving)} onClick={() => void update("thinking", { thinkingLevel: level })}>{settingLabel(level)}</button>)}</div>
        </section>
        <section className="setting-card">
          <div className="setting-heading"><div><h3>Speed</h3><p>Request scheduling priority</p></div>{saving === "speed" && <span className="setting-saving">Saving</span>}</div>
          {settings.speedModes.length ? <div className="setting-options speed-options" role="radiogroup" aria-label="Speed mode">{settings.speedModes.map((mode) => <button key={mode} type="button" role="radio" aria-checked={settings.speedMode === mode} className={settings.speedMode === mode ? "selected" : ""} disabled={Boolean(saving)} onClick={() => void update("speed", { speedMode: mode })}>{settingLabel(mode)}</button>)}</div> : <p className="setting-unavailable">This model does not offer speed controls.</p>}
        </section>
      </>}</div>
    </motion.aside>}</AnimatePresence>
  </>;
}

function eventEntries(current: ContextEntry[], events: AgentRunEvent[]): ContextEntry[] {
  const next = [...current];
  for (const event of events as any[]) {
    const key = event.type === "tool_start" || event.type === "tool_end" ? `toolCall:${event.toolCallId}` : `event:${event.seq}`;
    if (event.type === "tool_start") next.push({ key, signature: `start:${JSON.stringify(event)}`, kind: "toolCall", toolCall: { id: event.toolCallId, name: event.name, arguments: event.args || {} }, time: Date.parse(event.time) || Date.now() });
    else if (event.type === "tool_end") {
      const index = next.findIndex((entry) => entry.key === key);
      const previous = index >= 0 ? next[index] : { key, kind: "toolCall", toolCall: { id: event.toolCallId, name: event.name, arguments: event.args || {} }, time: Date.now() } as ContextEntry;
      const entry = { ...previous, signature: `end:${JSON.stringify(event)}`, toolResult: { content: event.output || "", isError: event.error, timestamp: Date.parse(event.time) || Date.now() } };
      if (index >= 0) next[index] = entry; else next.push(entry);
    } else if (["user", "assistant", "thinking", "notice"].includes(event.type)) next.push({ key, signature: JSON.stringify(event), kind: event.type === "notice" ? "notice" : event.type, label: event.type === "user" ? "You" : event.type === "assistant" ? "Pi" : event.type === "thinking" ? "Thinking" : "Status", text: event.text || "" });
  }
  return next.slice(-50);
}

export default function App() {
  const { state, stateRef, patch } = useStableState();
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState("pasted-text.txt");
  const [pasteContent, setPasteContent] = useState("");
  const [rootFileCount, setRootFileCount] = useState(0);
  const [voiceState, setVoiceState] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [voiceDetail, setVoiceDetail] = useState("");
  const voice = useRef<VoiceSession | null>(null);
  const promptElement = useRef<HTMLTextAreaElement>(null);
  const syncController = useRef<AbortController | null>(null);
  const syncSchedule = useRef(createPollSchedule());
  const syncMeta = useRef({ epoch: "", seq: 0, stateVersion: 0, dashboardVersion: 0, agentSeq: 0, orderCommitted: false });
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 350, tolerance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const kick = useCallback(() => {
    syncSchedule.current.requestImmediate();
    syncController.current?.abort();
  }, []);
  const selectedSession = useCallback(() => {
    const current = stateRef.current;
    return current.sessions.find((session) => session.id === current.selectedId) ?? null;
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
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [kick]);
  useEffect(() => () => voice.current?.stop(), []);
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
    return `${environment?.id || location.origin}:${id}`;
  }, []);

  const selectThread = useCallback(async (id: string) => {
    patch({ selectedId: id, agentRunId: null, agentRun: null, context: null, liveText: null, liveThinking: null, drawerOpen: innerWidth >= 1000 });
    setPrompt(loadDraft(id));
    kick();
    try {
      const cached = await readCachedContext(await cacheKey(id));
      if (stateRef.current.selectedId === id && !stateRef.current.context && cached) {
        patch({ context: cached });
        kick();
      }
    } catch (error) { console.error(error); }
  }, [cacheKey, kick, patch, stateRef]);

  const selectAgent = useCallback((run: AgentRun) => {
    syncMeta.current.agentSeq = 0;
    patch({ agentRunId: run.id, agentRun: run, agentEntries: [], agentText: null, agentThinking: null, drawerOpen: innerWidth >= 1000 });
    kick();
  }, [kick, patch]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stopped) return;
      const controller = new AbortController();
      syncController.current = controller;
      const current = stateRef.current;
      const meta = syncMeta.current;
      const { selectedId, agentRunId } = current;
      const request: SyncRequest = { epoch: meta.epoch, seq: meta.seq, stateVersion: meta.stateVersion, dashboardVersion: meta.dashboardVersion, waitMs: syncSchedule.current.takeWaitMs() };
      if (selectedId && !agentRunId) request.session = { id: selectedId, contextHash: current.context?.hash, liveTextHash: current.liveText?.hash, liveThinkingHash: current.liveThinking?.hash };
      if (agentRunId) request.agent = { id: agentRunId, after: meta.agentSeq, liveTextHash: current.agentText?.hash, liveThinkingHash: current.agentThinking?.hash };
      let delay = 0;
      try {
        const response = await syncRequest(request, controller.signal);
        const cancelled = () => controller.signal.aborted || stopped;
        if (cancelled()) return;
        meta.epoch = response.epoch;
        meta.seq = response.seq;
        meta.stateVersion = response.stateVersion;
        meta.dashboardVersion = response.dashboardVersion;
        const update: Partial<AppState> = { offline: "" };
        if (response.state) {
          Object.assign(update, response.state);
          if (meta.orderCommitted) { update.pendingOrder = null; meta.orderCommitted = false; }
        }
        if (response.dashboard) update.dashboard = response.dashboard;
        const live = stateRef.current;
        if (response.session && live.selectedId === selectedId && !live.agentRunId) {
          update.context = await updateDocument(current.context, response.session.context);
          update.liveText = await updateDocument(current.liveText, response.session.liveText);
          update.liveThinking = await updateDocument(current.liveThinking, response.session.liveThinking);
          if (update.context !== current.context && selectedId) {
            const document = update.context;
            void cacheKey(selectedId).then((key) => document ? writeCachedContext(key, document) : deleteCachedContext(key)).catch(console.error);
          }
        }
        if (response.agent && live.agentRunId === agentRunId) {
          update.agentRun = response.agent.run;
          update.agentText = await updateDocument(current.agentText, response.agent.liveText);
          update.agentThinking = await updateDocument(current.agentThinking, response.agent.liveThinking);
          update.agentEntries = eventEntries(current.agentEntries, response.agent.events);
          for (const event of response.agent.events) meta.agentSeq = Math.max(meta.agentSeq, Number(event.seq) || 0);
        }
        if (cancelled()) return;
        patch(update);
        const settled = stateRef.current;
        if (!settled.selectedId && !settled.agentRunId && settled.sessions.length) void selectThread(settled.sessions[0].id);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) { patch({ offline: error instanceof Error ? error.message : String(error) }); delay = 1_200; }
      } finally {
        if (!stopped) timer = setTimeout(poll, delay);
      }
    };
    void poll();
    return () => { stopped = true; syncController.current?.abort(); if (timer) clearTimeout(timer); };
  }, [cacheKey, patch, selectThread, stateRef]);

  const createThread = async (destination: string, model: string | null) => {
    const sessionId = crypto.randomUUID();
    await api(API.createSession.method, API.createSession.path(), { requestId: crypto.randomUUID(), sessionId, destination, model });
    await selectThread(sessionId);
  };
  const archive = async (id: string) => {
    await api(API.archiveSession.method, API.archiveSession.path({ sessionId: id }));
    void cacheKey(id).then(deleteCachedContext).catch(console.error);
    if (stateRef.current.selectedId === id) patch({ selectedId: null, context: null, liveText: null, liveThinking: null });
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
    const ordered = arrayMove(previous, sourceIndex, targetIndex).map((session) => session.id);
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

  const uploadFiles = async (files: File[]) => {
    const id = stateRef.current.selectedId; if (!id) return;
    for (const source of files) {
      const localId = crypto.randomUUID();
      const attachment: Attachment = { localId, name: source.name || "attachment", path: null, storedName: null, sessionId: id, uploading: true };
      patch((current) => ({ attachments: [...current.attachments, attachment] }));
      try {
        const response = await piFetch(API.uploads.path({}, { name: attachment.name, sessionId: id }), { method: "POST", headers: { "content-type": source.type || "application/octet-stream" }, body: source });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        patch((current) => ({ attachments: current.attachments.map((item) => item.localId === localId ? { ...item, uploading: false, path: result.file.path, storedName: result.file.name, environment: result.file.environment } : item) }));
      } catch (error) { patch((current) => ({ attachments: current.attachments.filter((item) => item.localId !== localId) })); console.error(error); }
    }
  };
  const removeAttachment = async (attachment: Attachment) => {
    patch((current) => ({ attachments: current.attachments.filter((item) => item.localId !== attachment.localId) }));
    if (attachment.storedName) await api(API.removeUploads.method, API.removeUploads.path({}, { name: attachment.storedName, sessionId: attachment.sessionId })).catch(console.error);
  };

  const send = async () => {
    const session = selectedSession();
    if (!session || pending) return;
    const attachments = stateRef.current.attachments.filter((file) => file.path && !file.uploading);
    const text = prompt.trim();
    if (!text && !attachments.length) {
      if (working(session)) {
        setPending(true);
        try { await api(API.sessionAbort.method, API.sessionAbort.path({ sessionId: session.id }), {}); }
        finally { setPending(false); kick(); }
      }
      return;
    }
    const command = text.startsWith("/") ? state.slashCommands.find((candidate) => candidate.name === text.slice(1).split(/\s/, 1)[0]) : null;
    setPrompt(""); saveDraft(session.id, ""); setPending(true);
    try {
      const attachmentText = attachments.length ? `The following files were attached to this message:\n${attachments.map((file) => `- ${file.path}`).join("\n")}` : "";
      const bodyText = [text, attachmentText].filter(Boolean).join("\n\n");
      if (command && !attachments.length) await api(API.sessionCommand.method, API.sessionCommand.path({ sessionId: session.id }), { requestId: crypto.randomUUID(), name: command.name, args: text.slice(command.name.length + 2).trim() }, 130_000);
      else await api(API.sessionPrompt.method, API.sessionPrompt.path({ sessionId: session.id }), { requestId: crypto.randomUUID(), text: bodyText, delivery: "followUp" });
      patch({ attachments: [] });
    } catch (error) { setPrompt(text); saveDraft(session.id, text); console.error(error); }
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
    } finally { kick(); }
  };
  const toggleAction = async (id: string) => { try { await api(API.actionToggle.method, API.actionToggle.path({ id }), {}); } finally { kick(); } };
  const toggleGovernor = async (provider: GovernorProvider) => { try { await api(API.governorToggle.method, API.governorToggle.path({ provider }), {}); } finally { kick(); } };

  const sessions = orderedSessions(state);
  const selected = sessions.find((session) => session.id === state.selectedId) ?? null;
  const contextEntries = useMemo(() => modelContextEntries(state.context ? JSON.parse(state.context.document) : null), [state.context]);
  const modelCounts = useMemo(() => new Map((state.dashboard?.modelCounts ?? []).map((model) => [model.key, model.count])), [state.dashboard]);
  const dashboard = state.dashboard;
  const selectedActivity = state.agentRunId ? state.agentRun?.activity || state.agentRun?.status || "IDLE" : selected?.activity || "IDLE";
  const selectedTool = state.agentRunId ? state.agentRun?.activeTool : selected?.activeTool;
  const title = state.agentRunId ? state.agentRun ? `${state.agentRun.label} · ${state.agentRun.taskId}` : "Agent" : selected?.name || "Pi Remote";
  const machine = dashboard?.machine;
  const machineText = machine ? `CPU ${machine.cpuPercent ?? "—"}% · GPU ${machine.gpuPercent ?? "—"}% · RAM ${machine.memory?.percentUsed ?? "—"}% · DISK ${machine.disk?.percentUsed ?? "—"}%` : "CPU — · GPU — · RAM — · DISK —";
  const entries = state.agentRunId ? state.agentEntries : contextEntries;
  const liveThinking = state.agentRunId ? state.agentThinking?.document || "" : state.liveThinking?.document || "";
  const liveText = state.agentRunId ? state.agentText?.document || "" : state.liveText?.document || "";
  const drawerCounts: Record<DrawerTab, number> = { threads: sessions.length, agents: dashboard?.agents.running ?? 0, archived: Math.max(state.archivedTotal, state.archived.length), files: rootFileCount };
  const drawerLabels: Record<DrawerTab, string> = { threads: "Interactive", agents: "Orchestrator", archived: "Archived", files: "Files" };
  const slashToken = prompt.startsWith("/") && !/\s/.test(prompt) ? prompt.slice(1).toLowerCase() : null;
  const visibleCommands = slashToken === null ? [] : state.slashCommands.filter((command) => command.source === "skill" && !command.name.toLowerCase().includes("mcp") && command.name.toLowerCase().startsWith(slashToken));

  return <div id="app">
    <UnlockDialog />
    {state.drawerOpen && innerWidth < 1000 && <div className="scrim" onClick={() => patch({ drawerOpen: false })} />}
    <aside id="drawer" className={state.drawerOpen ? "open" : ""} aria-label="Navigation">
      <header className="drawer-heading thread-start-heading"><nav className="drawer-tabs" role="tablist" aria-label="Drawer sections">{(["threads", "agents", "archived", "files"] as const).map((tab) => <button key={tab} className="drawer-tab" type="button" role="tab" aria-label={`${drawerLabels[tab]}, ${drawerCounts[tab]}`} title={drawerLabels[tab]} aria-selected={state.drawerTab === tab} onClick={() => patch({ drawerTab: tab })}><DrawerTabIcon tab={tab} /><span className="drawer-tab-count">{drawerCounts[tab]}</span></button>)}</nav><ThreadStartMenu starts={dashboard?.threadStarts ?? []} onCreate={(destination, model) => void createThread(destination, model)} /></header>
      {state.drawerTab === "threads" && <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorder(event)}><SortableContext items={sessions.map((session) => session.id)} strategy={verticalListSortingStrategy}><div className="thread-list">{sessions.length ? sessions.map((session) => <SortableThreadRow key={session.id} session={session} selected={!state.agentRunId && state.selectedId === session.id} onSelect={(id) => void selectThread(id)} onArchive={(id) => void archive(id)} onUnarchive={() => {}} />) : <div className="agent-empty">No threads</div>}</div></SortableContext></DndContext>}
      {state.drawerTab === "agents" && <AgentList runs={dashboard?.agents.runs ?? []} hosts={dashboard?.agents.hosts ?? []} selectedId={state.agentRunId} onSelect={selectAgent} />}
      {state.drawerTab === "archived" && <div className="thread-list">{state.archived.length ? state.archived.map((session) => <ThreadRow key={session.id} archived session={session} selected={false} onSelect={() => {}} onArchive={() => {}} onUnarchive={(id) => void unarchive(id)} />) : <div className="agent-empty">No archived threads</div>}{state.archived.length < state.archivedTotal && <button type="button" className="archived-more" onClick={() => void loadOlder()}>Show older · {state.archivedTotal - state.archived.length} more</button>}</div>}
      <FileExplorer hidden={state.drawerTab !== "files"} onRootCount={setRootFileCount} />
      <footer className="drawer-footer"><MachineControls actions={dashboard?.actions ?? []} governors={dashboard?.governors ?? null} onAction={(id) => void toggleAction(id)} onGovernor={(provider) => void toggleGovernor(provider)} /><EnvironmentControl /><PlanSummary plans={dashboard?.plans ?? []} counts={modelCounts} /><div className="usage-summary muted">{machineText}</div>{state.offline && <div className="connection" style={{ color: "var(--danger)" }}>● Offline · {state.offline}</div>}</footer>
    </aside>
    <main id="main"><header className="topbar"><button className="icon-button" aria-label="Open navigation" onClick={() => patch({ drawerOpen: true })}>☰</button><div className="top-title">{title}</div><div className="top-state" style={{ color: state.offline ? "var(--danger)" : activityColor(selectedActivity) }}>{state.offline ? "OFFLINE" : activityLabel(selectedActivity, selectedTool ?? "")}</div><button className="icon-button" aria-label="Open thread settings" disabled={!selected || Boolean(state.agentRunId)} onClick={() => patch({ settingsOpen: true })}>⚙</button></header>
      {!state.selectedId && !state.agentRunId ? <section className="empty-state"><strong>No threads</strong><span>Open the drawer to create one.</span></section> : <section className="conversation"><div className="scrollback"><div className="scroll-content"><ContextTranscript entries={entries} sessionId={state.selectedId || ""} home={dashboard?.home ?? "/"} onEdit={editFrom} />{liveThinking && <div className="live-thinking"><Markdown source={liveThinking} sessionId={state.selectedId || ""} streaming /><CopyButton text={liveThinking} label="Copy thinking" /></div>}{liveText && <div className="live-answer"><Markdown source={liveText} sessionId={state.selectedId || ""} streaming /><CopyButton text={liveText} label="Copy response" /></div>}</div></div>
        {selected?.queuedMessages.length ? <div className="message-queue">{selected.queuedMessages.map((message) => <div className="queued-message" key={message.id}><div className="queued-message-copy"><span className="queued-message-label">{message.status || "Queued"}</span><span className="queued-message-preview">{message.text.split("\n").find((line) => line.trim()) || "Attached files"}</span></div><div className="queued-message-actions"><CopyButton text={message.text} className="queued-message-action icon-message-action" />{message.canSteer && <button className="queued-message-action steer-instead" type="button" onClick={() => void mutateQueued(message, API.queueSteer)}>STEER</button>}{message.canHardSteer && <button className="queued-message-action hard-steer" type="button" onClick={() => void mutateQueued(message, API.queueHardSteer)}>HARD STEER</button>}{message.canCancel && <><button className="queued-message-action edit-queued" type="button" onClick={() => void mutateQueued(message, API.queueItem, true)}>EDIT</button><button className="queued-message-action cancel-queued" type="button" onClick={() => void mutateQueued(message, API.queueItem)}>CANCEL</button></>}</div></div>)}</div> : null}
        {state.attachments.length > 0 && <div className="attachments">{state.attachments.map((attachment) => <div className={`attachment-chip${attachment.uploading ? " uploading" : ""}`} key={attachment.localId}><span className="attachment-name">{attachment.name}{attachment.uploading ? " · uploading" : ""}</span><button className="attachment-remove" type="button" onClick={() => void removeAttachment(attachment)}>×</button></div>)}</div>}
        {state.agentRunId ? <div className="agent-banner">Observing {state.agentRun?.label} on {state.agentRun?.taskId} · read-only</div> : <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>{visibleCommands.length > 0 && <div className="slash-commands" role="listbox">{visibleCommands.map((command) => <button key={command.name} type="button" className="slash-command" onClick={() => setPrompt(`/${command.name} `)}><strong className="slash-command-name">/{command.name}</strong>{command.description && <span className="slash-command-description">{command.description}</span>}</button>)}</div>}<textarea ref={promptElement} id="prompt" rows={1} maxLength={200000} placeholder={`Message ${selected?.name || "Agent"}`} value={prompt} onChange={(event) => { setPrompt(event.target.value); if (state.selectedId) saveDraft(state.selectedId, event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(hover: hover) and (pointer: fine)").matches) { event.preventDefault(); void send(); } }} /><div className="composer-actions"><label className="composer-icon" aria-label="Attach files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6.5 8.7 14.3a2.5 2.5 0 0 0 3.5 3.5l8.1-8.1a4.5 4.5 0 0 0-6.4-6.4L5.5 11.7a6.5 6.5 0 0 0 9.2 9.2l6.1-6.1"/></svg><input type="file" multiple hidden onChange={(event) => { void uploadFiles([...event.target.files || []]); event.target.value = ""; }} /></label><button className="composer-icon" type="button" aria-label="Paste text document" onClick={() => setPasteOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5V4h6v1.5M9 5.5h6M9 5.5H7v15h10v-15h-2M9 10h6m-6 4h6m-6 4h4"/></svg></button><span className="composer-spacer"/><button id="voice" className={`composer-icon voice${voiceState === "idle" ? "" : ` ${voiceState}`}`} type="button" aria-label={voiceState === "live" ? "Hang up voice" : "Start voice"} title={voiceDetail || undefined} onClick={() => void toggleVoice()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6"/></svg></button><button id="action" className={`composer-icon send${working(selected) && !prompt.trim() ? " abort" : ""}`} type="submit" disabled={pending || state.attachments.some((file) => file.uploading)} aria-label={working(selected) && !prompt.trim() ? "Abort agent" : "Send message"}><svg className="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/></svg><span className="stop-icon" aria-hidden="true">■</span></button></div></form>}
      </section>}
    </main>
    <SettingsPanel session={selected} open={state.settingsOpen} onClose={() => patch({ settingsOpen: false })} />
    {pasteOpen && <dialog className="paste-text-dialog" open><form className="paste-text-form" onSubmit={(event) => { event.preventDefault(); const name = /\.[^./\\]+$/.test(pasteName) ? pasteName : `${pasteName}.txt`; void uploadFiles([new File([pasteContent], name, { type: "text/plain;charset=utf-8" })]); setPasteOpen(false); setPasteContent(""); }}><h2>Paste text document</h2><label>Document name</label><input value={pasteName} onChange={(event) => setPasteName(event.target.value)} /><label>Text</label><textarea value={pasteContent} onChange={(event) => setPasteContent(event.target.value)} /><div className="paste-text-actions"><button type="button" onClick={() => setPasteOpen(false)}>Cancel</button><button className="accent" type="submit" disabled={!pasteContent.trim()}>Attach</button></div></form></dialog>}
  </div>;
}

function orderedSessions(state: Pick<AppState, "sessions" | "pendingOrder">) {
  return state.pendingOrder ? threadsInOrder(state.sessions, state.pendingOrder) : state.sessions;
}
