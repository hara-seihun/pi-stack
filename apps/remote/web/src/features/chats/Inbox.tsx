import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThreadColor } from "../../../../server/protocol";
import { ThreadColorButton, threadColorStyle } from "./ThreadColorButton";
import { useVisibleSelection } from "../../app/use-visible-selection";
import { ChatAvatar } from "../../chat-row";
import { INBOX_SECTIONS, type Chat, type ChatId, type InboxRow } from "../../chats";
import { DismissibleError } from "../../dismissible-error";
import { StatusPill } from "../status/StatusPill";
import { modelShortName } from "../status/model-glyph";
import "./inbox.css";

function relativeTime(at: number, now = Date.now()) {
  if (!at) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

export const InboxRowView = memo(function InboxRowView({ row, selected, compactSelected, place, onOpen, onPrefetch, onClose }: { row: InboxRow; selected: boolean; compactSelected: boolean; place: string; onOpen(chat: Chat): void; onPrefetch?(chat: Chat): void; onClose(chat: Chat): void }) {
  const { chat, status } = row;
  const session = chat.kind === "ai" ? chat.session : null;
  const conversation = chat.kind === "human" ? chat.conversation : null;
  const [color, setColor] = useState<ThreadColor | null>(session?.color ?? null);
  useEffect(() => setColor(session?.color ?? null), [session?.color]);
  const titleOnly = selected && compactSelected;
  const showStatusLine = !titleOnly && Boolean(session || conversation?.unread || status);
  const closeTitle = chat.kind === "ai" ? `Close ${chat.title}: stops it and its workers, keeps history` : `Close ${chat.title}: keeps history, returns on a new message`;
  return <div className={`inbox-row${selected ? " selected" : ""}${titleOnly ? " title-only" : ""}${session ? " has-color-control" : ""}${color ? " has-thread-color" : ""}`} data-section={row.section} style={threadColorStyle(color)}>
    {/* The press starts before the tap lands: that is when this thread's
        newest window is worth asking for. */}
    <button type="button" className="inbox-open" onClick={() => onOpen(chat)} onPointerDown={() => onPrefetch?.(chat)} aria-current={selected || undefined}>
      <span className="inbox-glyph"><ChatAvatar avatar={chat.kind === "human" ? chat.avatar : undefined} icon={chat.icon} /></span>
      <span className="inbox-main">
        <span className="inbox-title-line"><span className="inbox-title">{chat.title}</span>{session?.idleUnread && <span className="inbox-unread-dot" aria-label="Unread" title="Unread" />}{!titleOnly && <time className="inbox-time">{relativeTime(row.updatedAt)}</time>}</span>
        {showStatusLine && <span className="inbox-status-line">
          {/* Every state has a word, "Working" included: a row whose state was left
              to the section header read as "· Fable", a blank where the state goes. */}
          {status ? <StatusPill status={status} compact /> : conversation?.unread ? <span className="inbox-unread">{conversation.unread} unread</span> : null}
          {session && <span className="inbox-meta">{modelShortName(session.model)}</span>}
          {place && <span className="inbox-meta">{place}</span>}
          {session && session.queuedMessages.length > 0 && !session.held && <span className="inbox-chip">{session.queuedMessages.length} queued</span>}
        </span>}
      </span>
    </button>
    {session && <ThreadColorButton id={session.id} name={chat.title} color={session.color} onPreview={setColor} />}
    <button type="button" className="inbox-close" aria-label={closeTitle} title={closeTitle} onClick={() => onClose(chat)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
  </div>;
});

// Memoized with its rows and handlers: typing in the composer, a live frame or
// a dashboard tick must not walk this list again.
export const Inbox = memo(function Inbox({ rows, selectedId, showPlace, compactSelected = false, error, picker, onOpen, onPrefetch, onClose, onSearchArchived, onSelectedVisibleChange }: {
  rows: InboxRow[];
  selectedId: ChatId | null;
  showPlace: boolean;
  compactSelected?: boolean;
  error: string;
  picker: ReactNode;
  onOpen(chat: Chat): void;
  onPrefetch?(chat: Chat): void;
  onClose(chat: Chat): void;
  onSearchArchived(query: string): void;
  onSelectedVisibleChange?(visible: boolean): void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter(row => row.chat.title.toLowerCase().includes(needle) || (row.chat.kind === "ai" && row.chat.session.model.toLowerCase().includes(needle))) : rows;
  }, [rows, query]);
  const defaultPlace = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) if (row.chat.kind === "ai") {
      const place = [row.chat.session.environment, row.chat.session.workspaceName].filter(Boolean).join(" · ");
      if (place) counts.set(place, (counts.get(place) ?? 0) + 1);
    }
    return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
  }, [rows]);
  const selectionRoot = useVisibleSelection(".inbox-row.selected .inbox-title", filtered, onSelectedVisibleChange);
  return <section ref={selectionRoot} className="inbox" aria-label="Chats">
    <header className="inbox-header">
      <div className="inbox-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        <input type="search" aria-label="Search chats" title="Search chats" value={query} onChange={event => setQuery(event.target.value)} enterKeyHint="search" />
      </div>
      {picker}
    </header>
    <DismissibleError message={error} />
    <div className="inbox-list">
      {INBOX_SECTIONS.map(section => {
        const items = filtered.filter(row => row.section === section.id);
        if (!items.length) return null;
        return <div key={section.id} className="inbox-section" data-section={section.id}>
          <h2 className="inbox-section-title">{section.label} <span>{items.length}</span></h2>
          {items.map(row => {
            const place = row.chat.kind === "ai" ? [row.chat.session.environment, row.chat.session.workspaceName].filter(Boolean).join(" · ") : "";
            return <InboxRowView key={row.chat.id} row={row} selected={row.chat.id === selectedId} compactSelected={compactSelected} place={showPlace && place !== defaultPlace ? place : ""} onOpen={onOpen} onPrefetch={onPrefetch} onClose={onClose} />;
          })}
        </div>;
      })}
      {!filtered.length && <div className={`inbox-empty${query ? " search-empty" : ""}`}>{query ? "No current chats match." : "No current chats."}{!query && <span>Use + to start one or reopen an archived chat.</span>}</div>}
      {query.trim() && <button type="button" className="inbox-archived" onClick={() => onSearchArchived(query.trim())}>Search archived chats for “{query.trim()}”</button>}
    </div>
  </section>;
});
