import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { API } from "../../server/api";
import type { MessagingSnapshot } from "../../server/messaging/protocol";
import { api } from "./client";
import { ChatIcon } from "./chat-row";
import { aiChat, humanChat, type Chat } from "./chats";
import { DismissibleError } from "./dismissible-error";
import { messagingClient } from "./messaging-client";
import { groupedModels, modelDisplayIcon } from "./model-groups";
import { linkStage, MessagingLinkController } from "./messaging-link";
import { formatTokens, pickerOptions, recentRecipients, PICKER_RESULT_LIMIT } from "./chat-picker-options";
import { threadStartReducer, threadStartSelection, threadStartStage, type ThreadStartEvent, type ThreadStartState } from "./thread-start-state";
import type { Session, ThreadStart } from "./types";
import "./chat-picker.css";

type Category = { kind: "root" } | { kind: "models" } | { kind: "archived" } | { kind: "backend"; id: string };
type ArchivePage = { query: string; sessions: Session[]; total: number };
export type ChatPickerEntry = { kind: "root" } | { kind: "archived"; query?: string };
export type ChatPickerHandle = { open(entry?: ChatPickerEntry): void };
export type ChatPickerProps = {
  starts: ThreadStart[]; messaging: MessagingSnapshot;
  onSelect(chat: Chat, signal?: AbortSignal): Promise<void>; onCreated(id: string): void; onSettled(): void;
  /** Entry requested while the lazy picker module was loading. */
  initialEntry?: ChatPickerEntry;
};

export const ChatPicker = forwardRef<ChatPickerHandle, ChatPickerProps>(function ChatPicker({ starts, messaging, onSelect, onCreated, onSettled, initialEntry }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(Boolean(initialEntry));
  const [category, setCategory] = useState<Category>(initialEntry?.kind === "archived" ? { kind: "archived" } : { kind: "root" });
  const [query, setQuery] = useState(initialEntry?.kind === "archived" ? initialEntry.query ?? "" : "");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [archivePage, setArchivePage] = useState<ArchivePage | null>(null);
  const [archiveError, setArchiveError] = useState("");
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
  const backend = category.kind === "backend" ? messaging.backends.find(item => item.id === category.id) : null;
  const request = state.kind === "creating" ? state.request : null;
  const busy = opening || state.kind === "creating";
  const models = pickerOptions(chosen?.models ?? [], query, item => `${item.label} ${item.id}`);
  const recipients = pickerOptions(recentRecipients(messaging.conversations, backend?.id ?? ""), query, item => `${item.title} ${item.externalId}`);
  const searchable = category.kind === "archived" || (category.kind === "models" ? models.searchable : category.kind === "backend" && recipients.searchable);
  const title = category.kind === "archived" ? "Archived" : backend?.label || chosen?.label || "New chat";
  const close = useCallback((restoreFocus = false) => {
    setOpen(false); setCategory({ kind: "root" }); setQuery(""); setAddress(""); setError("");
    dispatch({ type: "dismiss" }); operation.current?.abort(); operation.current = null; setOpening(false);
    if (restoreFocus) trigger.current?.focus();
  }, [dispatch]);
  const openAt = useCallback((entry: ChatPickerEntry = { kind: "root" }) => {
    operation.current?.abort(); operation.current = null; setOpening(false);
    setCategory(entry.kind === "archived" ? { kind: "archived" } : { kind: "root" });
    setQuery(entry.kind === "archived" ? entry.query ?? "" : "");
    setAddress(""); setError(""); setArchiveError(""); setArchivePage(null);
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
    if (!open || category.kind !== "archived") return;
    let active = true;
    setArchiveError("");
    const timer = setTimeout(() => {
      void api(API.archivedSessions.method, API.archivedSessions.path({}, { query, conversationsOnly: true, limit: PICKER_RESULT_LIMIT }))
        .then((result: { sessions: Session[]; total: number }) => {
          if (!active) return;
          setArchivePage({ ...result, query });
        }, (cause: unknown) => {
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
    setCategory(next); setQuery(""); setAddress(""); setError(""); setArchiveError("");
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
  const openRecipient = async () => {
    if (!backend || !address.trim() || operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setOpening(true); setError("");
    const result = await messagingClient.open(backend.id, address.trim(), controller.signal);
    if (controller.signal.aborted) return;
    operation.current = null; setOpening(false);
    if (result.ok) await select(humanChat(result.value.conversation, messaging.backends));
    else setError(result.error.message);
    onSettled();
  };
  const archiveReady = archivePage?.query === query;
  const total = category.kind === "archived" ? archivePage?.total ?? 0 : category.kind === "models" ? models.total : recipients.total;
  const destinations = [...(selection?.starts ?? starts)].sort((a, b) => {
    const rank = (id: string) => id === "personal" ? 0 : id === "home" ? 1 : 2;
    return rank(a.id) - rank(b.id);
  });
  const rootIconCounts = [...destinations, ...messaging.backends].reduce((counts, item) => counts.set(item.icon, (counts.get(item.icon) ?? 0) + 1), new Map<string, number>());
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
        <button className="chat-picker-identity" type="button" aria-label="Archived" title="Archived" onClick={() => navigate({ kind: "archived" })}><svg className="chat-picker-archive-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v12H4V8Zm-1-4h18v4H3V4Zm6 9h6" /></svg></button>
        {messaging.backends.map(item => <button className="chat-picker-identity" type="button" key={item.id} aria-label={item.label} title={item.label} onClick={() => navigate({ kind: "backend", id: item.id })}>{showRootIcon(item.icon) ? <ChatIcon icon={item.icon} /> : <span className="chat-picker-identity-label">{item.label}</span>}</button>)}
      </div> : <>
        {backend && backend.status !== "ready" && linkStage(backend) === "hidden" && <p className={`messaging-backend ${backend.status}`} role="status">{backend.detail || backend.status}</p>}
        {backend && <MessagingLinkController key={backend.id} backend={backend} />}
        {category.kind === "models" && contexts.length > 0 && <fieldset className="chat-picker-contexts" disabled={busy || state.kind === "failed"}>
          <legend>Context<span className="chat-picker-contexts-total">{checkedContexts.length ? `${formatTokens(checkedTokens)} tokens chosen` : "none chosen"}</span></legend>
          {contexts.map(context => <label key={context.name} className="chat-picker-context">
            <input type="checkbox" checked={checkedContexts.includes(context.name)} onChange={() => dispatch({ type: "toggleContext", name: context.name })} />
            <span className="chat-picker-context-name">{context.name.replace(/\.md$/i, "")}</span>
            <span className="chat-picker-context-tokens">{formatTokens(context.tokens)} tokens</span>
          </label>)}
        </fieldset>}
        <div className="chat-picker-list">
          {category.kind === "models" && modelGroups.map(group => <section className="chat-picker-model-group" key={group.id} aria-label={[group.title, group.description].filter(Boolean).join(" · ")}>
            <h3>{group.title}{group.description && <small>{group.description}</small>}</h3>
            <div className="chat-picker-identities">{group.models.map(choice => {
              const icon = modelDisplayIcon(choice.id, choice.label, choice.icon);
              return <button className="chat-picker-identity" type="button" key={choice.id} aria-label={choice.label} title={choice.label} disabled={busy || state.kind === "failed"} onClick={() => choose(choice.id)}>{showModelIcon(icon) ? <ChatIcon icon={icon} /> : <span className="chat-picker-identity-label">{choice.label}</span>}</button>;
            })}</div>
          </section>)}
          {category.kind === "backend" && recipients.items.map(item => <button type="button" key={item.id} disabled={busy} onClick={() => void select(humanChat(item, messaging.backends))}><span>{item.title}<small>{item.kind === "group" ? "Group" : item.externalId}</small></span></button>)}
          {category.kind === "archived" && archiveReady && archivePage.sessions.map(item => <button type="button" key={item.id} disabled={busy} onClick={() => void select(aiChat(item, starts))}><ChatIcon icon={aiChat(item, starts).icon} /><span>{item.name || "Agent"}</span></button>)}
        </div>
        {category.kind === "archived" && !archiveReady && !archiveError ? <p role="status">Loading chats…</p> : !archiveError && <p className="chat-picker-count" role="status">{total === 0 ? (query ? "No matches" : "No options yet") : total > PICKER_RESULT_LIMIT ? `Showing ${PICKER_RESULT_LIMIT} of ${total}. Search to narrow the list.` : ""}</p>}
        {backend && backend.status === "ready" && <details className="chat-picker-address"><summary>Open by address</summary><form onSubmit={event => { event.preventDefault(); void openRecipient(); }}><input aria-label="Recipient address or group ID" value={address} onChange={event => setAddress(event.target.value)} placeholder="Address or group ID" /><button type="submit" disabled={busy || !address.trim() || backend.status !== "ready"}>Open recipient</button></form></details>}
      </>}
      {busy && <p role="status">Opening chat…</p>}
      <DismissibleError message={archiveError || error || (state.kind === "failed" ? state.error : "")} />
      {archiveError && <button type="button" onClick={() => setArchiveAttempt(value => value + 1)}>Retry</button>}
      {state.kind === "failed" && <button type="button" onClick={() => dispatch({ type: "retry" })}>Retry</button>}
    </section>
    </div>}
  </div>;
});
