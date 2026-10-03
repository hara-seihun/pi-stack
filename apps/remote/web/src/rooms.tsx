import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, piFetch } from "./client";
import type { Room, RoomMember, RoomSnapshot } from "../../shared/rooms";
import { ChatMessage, agentAvatar } from "./chat-message";
import "./rooms.css";

export function useRooms(enabled: boolean) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [people, setPeople] = useState<RoomMember[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    const response = await piFetch("/v1/rooms", { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Rooms returned HTTP ${response.status}`);
    const value = await response.json() as { rooms: Room[]; people: RoomMember[] };
    setRooms(value.rooms); setPeople(value.people); setError("");
  }, [enabled]);
  useEffect(() => {
    if (!enabled) { setRooms([]); setPeople([]); return; }
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try { await refresh(controller.signal); } catch (cause) { if (!controller.signal.aborted) setError(String(cause)); }
      finally { running = false; }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 2_000);
    window.addEventListener("focus", load);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", load); };
  }, [enabled, refresh]);
  return { rooms, people, error, refresh };
}

function MemberPicker({ people, selected, onChange }: { people: RoomMember[]; selected: string[]; onChange(value: string[]): void }) {
  return <fieldset className="room-member-picker"><legend>People</legend>{people.map(person => <label key={person.user}>
    <input type="checkbox" checked={selected.includes(person.user)} onChange={event => onChange(event.target.checked ? [...selected, person.user] : selected.filter(user => user !== person.user))} /> {person.displayName}
  </label>)}</fieldset>;
}

export function RoomInbox({ rooms, people, selected, error, onOpen, onRefresh }: {
  rooms: Room[]; people: RoomMember[]; selected: string | null; error: string; onOpen(id: string): void; onRefresh(): Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const create = async () => {
    setPending(true); setFailure("");
    const requestId = receipt ?? crypto.randomUUID(); setReceipt(requestId);
    try {
      const response = await api("POST", "/v1/rooms", { requestId, title, members });
      setCreating(false); setTitle(""); setMembers([]); setReceipt(null);
      await onRefresh(); onOpen(response.room.id);
    } catch (cause) { setFailure(String(cause)); } finally { setPending(false); }
  };
  return <section className="room-inbox" aria-label="Rooms">
    <header><strong>Rooms</strong><button type="button" onClick={() => { setCreating(!creating); setReceipt(null); }}>New room</button></header>
    {(error || failure) && <p role="alert">{error || failure}</p>}
    {creating && <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <input aria-label="Room name" placeholder="Room name" maxLength={120} value={title} disabled={pending || !!receipt} onChange={event => setTitle(event.target.value)} />
      {!receipt && <MemberPicker people={people.filter(person => person.user !== window.PiRemotePerson.get())} selected={members} onChange={setMembers} />}
      <button disabled={pending || !title.trim()}>{pending ? "Creating…" : receipt ? "Retry creation" : "Create room"}</button>
    </form>}
    {rooms.map(room => <button type="button" key={room.id} className={`room-row${selected === room.id ? " selected" : ""}`} onClick={() => onOpen(room.id)}>
      <strong>{room.title}</strong><span>{room.members.map(member => member.displayName).join(", ")} · Kenan</span>
    </button>)}
  </section>;
}

function RoomQuestion({ question, roomId, onAnswered }: { question: NonNullable<RoomSnapshot["questions"]>[number]; roomId: string; onAnswered(): Promise<void> }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const answer = async (dismissed = false) => {
    setPending(true); setError("");
    try { await api("POST", `/v1/rooms/${roomId}/questions/${encodeURIComponent(question.id)}/answer`, { selectedSuggestionIds: dismissed ? [] : selected, text: dismissed ? "" : text, ...(dismissed ? { dismissed: true } : {}) }); await onAnswered(); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  return <form className="room-question" onSubmit={event => { event.preventDefault(); void answer(); }}>
    <strong>{question.question}</strong>
    {question.suggestions.map(suggestion => <label key={suggestion.id}><input type="checkbox" checked={selected.includes(suggestion.id)} onChange={event => setSelected(event.target.checked ? [...selected, suggestion.id] : selected.filter(id => id !== suggestion.id))} />{suggestion.text}</label>)}
    <textarea aria-label="Answer Kenan's question" value={text} onChange={event => setText(event.target.value)} disabled={pending} />
    {error && <p role="alert">{error}</p>}
    <button disabled={pending || !selected.length && !text.trim()}>Answer</button><button type="button" disabled={pending} onClick={() => void answer(true)}>Skip</button>
  </form>;
}

export function RoomConversation({ id, people, onBack, onRefresh }: { id: string; people: RoomMember[]; onBack(): void; onRefresh(): Promise<void> }) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const scrollback = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => { if (follow.current && scrollback.current) scrollback.current.scrollTop = scrollback.current.scrollHeight; }, [snapshot]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await piFetch(`/v1/rooms/${encodeURIComponent(id)}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Room returned HTTP ${response.status}`);
    setSnapshot(await response.json());
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try { await load(controller.signal); } catch (cause) { if (!controller.signal.aborted) setError(String(cause)); }
      finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 1_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);
  const send = async () => {
    if (pending || !text.trim()) return;
    const requestId = receipt ?? crypto.randomUUID(); setReceipt(requestId);
    setPending(true); setError("");
    try { await api("POST", `/v1/rooms/${id}/prompt`, { requestId, text }); setText(""); setReceipt(null); await load(); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  const add = async () => {
    setPending(true); setError("");
    try { await api("POST", `/v1/rooms/${id}/members`, { members }); setAdding(false); setMembers([]); await Promise.all([load(), onRefresh()]); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  return <section className="room-conversation" aria-label={snapshot?.room.title ?? "Room"}>
    <header><button type="button" onClick={onBack}>Back</button><div><strong>{snapshot?.room.title ?? "Opening room…"}</strong>
      <p>{snapshot?.room.members.map(member => member.displayName).join(", ")} · Kenan</p></div>
      <button type="button" disabled={snapshot?.state === "running" || pending} onClick={() => setAdding(!adding)}>Add people</button></header>
    {adding && <form onSubmit={event => { event.preventDefault(); void add(); }}><p>New members can read the room's existing conversation.</p>
      <MemberPicker people={people.filter(person => !snapshot?.room.members.some(member => member.user === person.user))} selected={members} onChange={setMembers} />
      <button disabled={pending || !members.length}>Add to room</button></form>}
    <div className="room-history" ref={scrollback} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80; }}>{snapshot?.messages.map(message => <ChatMessage key={message.id} kind={message.sender.user === "assistant" ? "assistant" : "user"}
      label={message.sender.displayName} avatar={message.sender.user === "assistant" ? agentAvatar() : undefined} timestamp={message.time}
      text={message.text} contentFormat="literal" />)}
      {snapshot?.live && <ChatMessage kind="assistant" label="Kenan" avatar={agentAvatar()} text={snapshot.live} contentFormat="literal" />}
      {(snapshot?.work?.length || snapshot?.thinking) ? <details className="room-work"><summary>Room thinking and work</summary>
        {snapshot.work?.map(item => <details key={item.id}><summary>{item.kind}{item.name ? ` · ${item.name}` : ""}</summary><pre>{item.text}</pre></details>)}
        {snapshot.thinking && <details open><summary>Thinking now</summary><pre>{snapshot.thinking}</pre></details>}
      </details> : null}
      {snapshot?.context != null && <details className="room-work"><summary>Room context</summary><pre>{JSON.stringify(snapshot.context, null, 2)}</pre></details>}
    </div>
    {snapshot?.questions?.map(question => <RoomQuestion key={question.id} question={question} roomId={id} onAnswered={load} />)}
    <p className="room-discretion">Room thinking and work are visible to everyone here. Private work goes to root Kenan; only his chosen reply comes back.</p>
    {error && <p role="alert">{error}</p>}
    <form className="room-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="Message the room" placeholder="Message the room" value={text} disabled={pending || !!receipt} onChange={event => setText(event.target.value)} />
      <button disabled={pending || !text.trim()}>{pending ? "Sending…" : receipt ? "Retry send" : "Send"}</button>
      {snapshot?.state === "running" && <><span role="status">Kenan is replying</span><button type="button" onClick={async () => { try { await api("POST", `/v1/rooms/${id}/abort`, {}); await load(); } catch (cause) { setError(String(cause)); } }}>Stop Kenan</button></>}
    </form>
  </section>;
}
