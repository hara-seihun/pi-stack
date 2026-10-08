import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { API } from "../../server/api";
import { api } from "./client";
import { validateSession, stateArray } from "../../shared/state-validation";
import { ChatIcon } from "./chat-row";
import { aiChat, roomChat, type Chat } from "./chats";
import { agentName } from "./agent-name";
import { StatusIcon } from "./features/status/StatusIcon";
import { threadStatus } from "./features/status/thread-status";
import type { Room, RoomMember } from "../../shared/rooms";
import { RoomCreator } from "./rooms";
import { DismissibleError } from "./dismissible-error";
import { groupedModels, modelDisplayIcon } from "./model-groups";
import { formatTokens, pickerOptions, PICKER_RESULT_LIMIT } from "./chat-picker-options";
import { threadStartReducer, threadStartSelection, threadStartStage, type ThreadStartEvent, type ThreadStartState } from "./thread-start-state";
import type { Session, ThreadStart } from "./types";
import "./chat-picker-trigger.css";
import "./chat-picker.css";

type Category = { kind: "root" } | { kind: "models" } | { kind: "archived" } | { kind: "agents" } | { kind: "room" };
type ArchivePage = { query: string; sessions: Session[]; total: number };
export type ChatPickerEntry = { kind: "root" } | { kind: "archived"; query?: string };
export type ChatPickerHandle = { open(entry?: ChatPickerEntry): void };
export type ChatPickerProps = {
  starts: ThreadStart[];
  rooms?: { rooms: Room[]; people: RoomMember[]; refresh(): Promise<void> };
  onRoomCreated?(id: string): void;
  onSelect(chat: Chat, signal?: AbortSignal): Promise<void>; onCreated(id: string): void; onSettled(): void;
  /** Entry requested while the lazy picker module was loading. */
  initialEntry?: ChatPickerEntry;
};

export const ChatPicker = forwardRef<ChatPickerHandle, ChatPickerProps>(function ChatPicker({ starts, onSelect, onCreated, onSettled, initialEntry, rooms, onRoomCreated }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(Boolean(initialEntry));
  const [category, setCategory] = useState<Category>(initialEntry?.kind === "archived" ? { kind: "archived" } : { kind: "root" });
  const [query, setQuery] = useState(initialEntry?.kind === "archived" ? initialEntry.query ?? "" : "");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [archivePage, setArchivePage] = useState<ArchivePage | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const [agents, setAgents] = useState<Session[] | null>(null);
  const [placement, setPlacement] = useState<"all" | "foreground" | "background">("background");
  const [archiveAttempt, setArchiveAttempt] = useState(0);
  const [state, setState] = useState<ThreadStartState>({ kind: "closed" });
  const current = useRef(state);
  const operation = useRef<AbortController | null>(null);
  const dispatch = useCallback((event: ThreadStartEvent) => {
    current.current = threadStartReducer(current.current, event);
    setState(current.current);
  }, []);
  const selection = threadStartSelection(state);
  const chosen = selection?.kind === "models" ? selection.destination : null;
  const contexts = chosen?.contexts ?? [];
  const checkedContexts = selection?.kind === "models" ? selection.contexts : [];
  const checkedTokens = contexts.filter(context => checkedContexts.includes(context.name)).reduce((sum, context) => sum + context.tokens, 0);
  const request = state.kind === "creating" ? state.request : null;
  const busy = opening || state.kind === "creating";
  const models = pickerOptions(chosen?.models ?? [], query, item => `${item.label} ${item.id}`);
  const agentOptions = pickerOptions((agents ?? []).filter(item => placement === "all" || (item.foreground ? "foreground" : "background") === placement), query, item => `${item.agentName ?? ""} ${item.name} ${item.id}`);
  const searchable = category.kind === "agents" || category.kind === "archived" || (category.kind === "models" && models.searchable);
  const title = category.kind === "agents" ? "Open agent" : category.kind === "room" ? "Room" : category.kind === "archived" ? "Archived" : chosen?.label || "New chat";
  const close = useCallback((restoreFocus = false) => {
    setOpen(false); setCategory({ kind: "root" }); setQuery(""); setError("");
    dispatch({ type: "dismiss" }); operation.current?.abort(); operation.current = null; setOpening(false);
    if (restoreFocus) trigger.current?.focus();
  }, [dispatch]);
  const openAt = useCallback((entry: ChatPickerEntry = { kind: "root" }) => {
    operation.current?.abort(); operation.current = null; setOpening(false);
    setCategory(entry.kind === "archived" ? { kind: "archived" } : { kind: "root" });
    setQuery(entry.kind === "archived" ? entry.query ?? "" : "");
    setError(""); setArchiveError(""); setArchivePage(null);
    dispatch({ type: "dismiss" });
    setOpen(true);
  }, [dispatch]);
  useImperativeHandle(ref, () => ({ open: openAt }), [openAt]);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (open && category.kind === "root" && state.kind === "closed" && starts.length) dispatch({ type: "open", starts });
  }, [open, category, state.kind, starts, dispatch]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => panel.current?.querySelector<HTMLElement>(searchable ? ".chat-picker-search" : "button:not(:disabled)")?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, category, searchable]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);
  useEffect(() => {
    if (!open || category.kind !== "agents") return;
    let active = true;
    setAgents(null); setArchiveError("");
    void api(API.sessions.method, `${API.sessions.path()}?allAgents=1`).then(result => {
      if (!active) return;
      stateArray(result.sessions, "Agent directory").forEach(validateSession);
      setAgents(result.sessions);
    }, cause => { if (active) setArchiveError(String(cause)); });
    return () => { active = false; };
  }, [open, category.kind, archiveAttempt]);
  useEffect(() => {
    if (!open || category.kind !== "archived") return;
    let active = true;
    setArchiveError("");
    const timer = setTimeout(() => {
      void api(API.archivedSessions.method, API.archivedSessions.path({}, { query, limit: PICKER_RESULT_LIMIT }))
        .then((result: { sessions: Session[]; total: number }) => {
          if (!active) return;
          stateArray(result.sessions, "Archived directory").forEach(validateSession);
          setArchivePage({ ...result, query });
        }).catch((cause: unknown) => {
          if (active) setArchiveError(cause instanceof Error ? cause.message : String(cause));
        });
    }, query ? 120 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [open, category, query, archiveAttempt]);
  useEffect(() => {
    if (!request) return;
    let active = true;
    void api(API.createSession.method, API.createSession.path(), request).then(() => {
      if (active && current.current.kind === "creating" && current.current.request === request) { close(); onCreated(request.sessionId); }
    }, (cause: unknown) => {
      if (active) dispatch({ type: "failed", requestId: request.requestId, error: cause instanceof Error ? cause.message : String(cause) });
    }).finally(onSettled);
    return () => { active = false; };
  }, [request, close, onCreated, onSettled, dispatch]);
  const navigate = (next: Category) => {
    setCategory(next); setQuery(""); setError(""); setArchiveError("");
    setArchivePage(null);
    dispatch({ type: "dismiss" }); dispatch({ type: "open", starts });
  };
  const choose = (id: string) => dispatch({ type: "choose", stage: threadStartStage(selection), id, origin: 0, requestId: crypto.randomUUID(), sessionId: crypto.randomUUID() });
  const select = async (chat: Chat) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setOpening(true); setError("");
    try { await onSelect(chat, controller.signal); if (!controller.signal.aborted) close(); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      if (operation.current === controller) { operation.current = null; setOpening(false); }
      onSettled();
    }
  };
  const archiveReady = archivePage?.query === query;
  const total = category.kind === "agents" ? agentOptions.total : category.kind === "archived" ? archivePage?.total ?? 0 : category.kind === "models" ? models.total : 0;
  const destinations = [...(selection?.starts ?? starts)].sort((a, b) => {
    const rank = (id: string) => id === "personal" ? 0 : id === "home" ? 1 : 2;
    return rank(a.id) - rank(b.id);
  });
  const rootIconCounts = destinations.reduce((counts, item) => counts.set(item.icon, (counts.get(item.icon) ?? 0) + 1), new Map<string, number>());
  const modelIconCounts = (chosen?.models ?? []).reduce((counts, item) => {
    const icon = modelDisplayIcon(item.id, item.label, item.icon);
    return counts.set(icon, (counts.get(icon) ?? 0) + 1);
  }, new Map<string, number>());
  const modelGroups = groupedModels(models.items, item => ({ id: item.id, label: item.label }));
  const showRootIcon = (icon: string) => Boolean(icon) && rootIconCounts.get(icon) === 1;
  const showModelIcon = (icon: string) => /\p{Extended_Pictographic}/u.test(icon) && modelIconCounts.get(icon) === 1;
  return <div className="chat-picker" ref={root}>
    <button ref={trigger} type="button" className="icon-button chat-picker-trigger" aria-label="New or open chat" title="New or open chat" aria-controls="chat-picker-menu" aria-expanded={open} aria-haspopup="dialog" onClick={() => {
      if (open) close(true); else openAt();
    }}>+</button>
    {open && <div id="chat-picker-menu" className="chat-picker-popover" role="dialog" aria-labelledby="chat-picker-title">
      <div className="chat-picker-header"><h2 id="chat-picker-title">{title}</h2><div className="chat-picker-actions">{category.kind !== "root" && <button type="button" className="chat-picker-back" aria-label="Back to chat categories" disabled={busy} onClick={() => navigate({ kind: "root" })}>Back</button>}<button type="button" className="chat-picker-dismiss" aria-label="Close chat menu" onClick={() => close(true)}>Close</button></div></div>
      <section ref={panel} className="chat-picker-panel" aria-busy={busy}>
      {searchable && <input className="chat-picker-search" type="search" aria-label={`Search ${title}`} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder={`Search ${title.toLocaleLowerCase()}`} />}
      {category.kind === "root" ? <div className="chat-picker-identities">
        {destinations.map(choice => <button className="chat-picker-identity" type="button" key={choice.id} aria-label={choice.label} title={choice.label} onClick={() => { setCategory({ kind: "models" }); choose(choice.id); }}>{showRootIcon(choice.icon) ? <ChatIcon icon={choice.icon} /> : <span className="chat-picker-identity-label">{choice.label}</span>}</button>)}
        {rooms && <button className="chat-picker-identity" type="button" aria-label="Room" title="Room" onClick={() => navigate({ kind: "room" })}><ChatIcon icon="room" /></button>}
        <button className="chat-picker-identity" type="button" aria-label="Open agent" title="Open agent" onClick={() => navigate({ kind: "agents" })}><span className="chat-picker-identity-label">Open agent</span></button>
        <button className="chat-picker-identity" type="button" aria-label="Archived" title="Archived" onClick={() => navigate({ kind: "archived" })}><svg className="chat-picker-archive-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v12H4V8Zm-1-4h18v4H3V4Zm6 9h6" /></svg></button>
      </div> : category.kind === "room" && rooms ? <>
        <RoomCreator people={rooms.people} onCreated={id => { close(); onRoomCreated?.(id); }} onRefresh={rooms.refresh} />
        {rooms.rooms.some(room => room.current === false) && <div className="chat-picker-list" aria-label="Closed rooms">
          <h3>Closed rooms</h3>
          {rooms.rooms.filter(room => room.current === false).map(room => <button type="button" key={room.id} disabled={busy} onClick={() => void select(roomChat(room))}><ChatIcon icon="room" /><span>{room.title}</span></button>)}
        </div>}
      </> : <>
        {category.kind === "models" && contexts.length > 0 && <fieldset className="chat-picker-contexts" disabled={busy || state.kind === "failed"}>
          <legend>Context<span className="chat-picker-contexts-total">{checkedContexts.length ? `${formatTokens(checkedTokens)} tokens chosen` : "none chosen"}</span></legend>
          {contexts.map(context => <label key={context.name} className="chat-picker-context" title={context.name}>
            <input type="checkbox" checked={checkedContexts.includes(context.name)} onChange={() => dispatch({ type: "toggleContext", name: context.name })} />
            <span className="chat-picker-context-name">{context.label ?? context.name.replace(/\.md$/i, "")}</span>
            <span className="chat-picker-context-tokens">{formatTokens(context.tokens)} tokens</span>
          </label>)}
        </fieldset>}
        {category.kind === "agents" && <label>Placement <select aria-label="Agent placement" value={placement} onChange={event => setPlacement(event.target.value as typeof placement)}><option value="background">Background</option><option value="foreground">Foreground</option><option value="all">All</option></select></label>}
        <div className="chat-picker-list">
          {category.kind === "agents" && agents === null && !archiveError && <p role="status">Loading agents…</p>}
          {category.kind === "agents" && agentOptions.items.map(item => <button type="button" key={item.id} disabled={busy} onClick={() => void select(aiChat(item, starts))}><StatusIcon status={threadStatus(item)} /><span>{agentName(item) ?? item.name}<small>{[agentName(item) && item.name, item.foreground ? "Foreground" : "Background"].filter(Boolean).join(" · ")}</small></span></button>)}
          {category.kind === "models" && modelGroups.map(group => <section className="chat-picker-model-group" key={group.id} aria-label={[group.title, group.description].filter(Boolean).join(" · ")}>
            <h3>{group.title}{group.description && <small>{group.description}</small>}</h3>
            <div className="chat-picker-identities">{group.models.map(choice => {
              const icon = modelDisplayIcon(choice.id, choice.label, choice.icon);
              return <button className="chat-picker-identity" type="button" key={choice.id} aria-label={choice.label} title={choice.label} disabled={busy || state.kind === "failed"} onClick={() => choose(choice.id)}>{showModelIcon(icon) ? <ChatIcon icon={icon} /> : <span className="chat-picker-identity-label">{choice.label}</span>}</button>;
            })}</div>
          </section>)}
          {category.kind === "archived" && archiveReady && archivePage.sessions.map(item => <button type="button" key={item.id} disabled={busy} onClick={() => void select(aiChat(item, starts))}><ChatIcon icon={aiChat(item, starts).icon} /><span>{agentName(item) ?? (item.name || "Agent")}{agentName(item) && item.name && <small>{item.name}</small>}</span></button>)}
        </div>
        {category.kind === "archived" && !archiveReady && !archiveError ? <p role="status">Loading chats…</p> : !archiveError && <p className="chat-picker-count" role="status">{total === 0 ? (query ? "No matches" : "No options yet") : total > PICKER_RESULT_LIMIT ? `Showing ${PICKER_RESULT_LIMIT} of ${total}. Search to narrow the list.` : ""}</p>}
      </>}
      {busy && <p role="status">Opening chat…</p>}
      <DismissibleError message={archiveError || error || (state.kind === "failed" ? state.error : "")} />
      {archiveError && <button type="button" onClick={() => setArchiveAttempt(value => value + 1)}>Retry</button>}
      {state.kind === "failed" && <button type="button" onClick={() => dispatch({ type: "retry" })}>Retry</button>}
    </section>
    </div>}
  </div>;
});
