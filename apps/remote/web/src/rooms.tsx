import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, piFetch } from "./client";
import type { Room, RoomMember, RoomSnapshot } from "../../shared/rooms";
import { ChatMessage, agentAvatar } from "./chat-message";
import { Composer } from "./Composer";
import { ConversationView } from "./ConversationView";
import { ConversationHeader } from "./features/conversation/ConversationScreen";
import { StatusPill } from "./features/status/StatusPill";
import { roomThreadStatus } from "./features/status/thread-status";
import { QuestionDrafts, answerIsValid, toggleSuggestion } from "./features/conversation/question-drafts";
import { Markdown } from "./context";
import { DismissibleError } from "./dismissible-error";
import { appStorageKey } from "./app-path";
import "./features/conversation/questions.css";
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
  return useMemo(() => ({ rooms, people, error, refresh }), [rooms, people, error, refresh]);
}

function MemberPicker({ people, selected, onChange }: { people: RoomMember[]; selected: string[]; onChange(value: string[]): void }) {
  return <fieldset className="room-member-picker"><legend>People</legend>{people.map(person => <label key={person.user}>
    <input type="checkbox" checked={selected.includes(person.user)} onChange={event => onChange(event.target.checked ? [...selected, person.user] : selected.filter(user => user !== person.user))} /> {person.displayName}
  </label>)}</fieldset>;
}

export function RoomCreator({ people, onCreated, onRefresh }: {
  people: RoomMember[]; onCreated(id: string): void; onRefresh(): Promise<void>;
}) {
  const receiptKey = appStorageKey(`pi-remote-room-create:${window.PiRemotePerson.get()}`);
  const [saved] = useState(() => {
    try {
      const raw = localStorage.getItem(receiptKey);
      if (!raw) return { title: "", members: [] as string[], receipt: null as string | null, error: "" };
      const value = JSON.parse(raw);
      if (typeof value.title !== "string" || !Array.isArray(value.members) || !value.members.every((member: unknown) => typeof member === "string") || typeof value.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.requestId)) throw new Error("Invalid saved room creation");
      return { title: value.title as string, members: value.members as string[], receipt: value.requestId as string | null, error: "" };
    } catch (cause) { return { title: "", members: [] as string[], receipt: null as string | null, error: `Could not restore room creation: ${String(cause)}` }; }
  });
  const [title, setTitle] = useState(saved.title);
  const [members, setMembers] = useState<string[]>(saved.members);
  const [failure, setFailure] = useState(saved.error);
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(saved.receipt);
  const create = async () => {
    if (pending || !title.trim()) return;
    setPending(true); setFailure("");
    const requestId = receipt ?? crypto.randomUUID();
    try {
      const request = { requestId, title, members };
      localStorage.setItem(receiptKey, JSON.stringify(request)); setReceipt(requestId);
      const response = await api("POST", "/v1/rooms", request);
      localStorage.removeItem(receiptKey);
      setTitle(""); setMembers([]); setReceipt(null);
      onCreated(response.room.id);
      await onRefresh();
    } catch (cause) { setFailure(String(cause)); } finally { setPending(false); }
  };
  return <section className="room-creator" aria-label="Create room">
    {failure && <p role="alert">{failure}</p>}
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <input aria-label="Room name" placeholder="Room name" maxLength={120} value={title} disabled={pending || !!receipt} onChange={event => setTitle(event.target.value)} />
      {!receipt && <MemberPicker people={people.filter(person => person.user !== window.PiRemotePerson.get())} selected={members} onChange={setMembers} />}
      <button disabled={pending || !title.trim()}>{pending ? "Creating…" : receipt ? "Retry creation" : "Create room"}</button>
    </form>
  </section>;
}

function RoomQuestion({ question, roomId, onAnswered }: { question: NonNullable<RoomSnapshot["questions"]>[number]; roomId: string; onAnswered(): Promise<void> }) {
  const drafts = new QuestionDrafts(localStorage, window.PiRemotePerson.get());
  const [draft, setDraft] = useState(() => drafts.load(roomId, question.id));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const change = (next: typeof draft) => { setDraft(next); drafts.save(roomId, question.id, next); };
  const answer = async (dismissed = false) => {
    if (pending || !dismissed && !answerIsValid(draft)) return;
    setPending(true); setError("");
    try {
      await api("POST", `/v1/rooms/${roomId}/questions/${encodeURIComponent(question.id)}/answer`, dismissed ? { selectedSuggestionIds: [], text: "", dismissed: true } : draft);
      drafts.clear(roomId, question.id);
      await onAnswered();
    } catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  return <div className="question-form">
    <Composer id="room-question-answer" value={draft.text} onChange={text => change({ ...draft, text })} onSend={() => void answer()}
      placeholder="Your answer or additional context" sendLabel="Submit answer" layoutKey={question.id}
      disabled={pending || !answerIsValid(draft)} readOnly={pending} hideAttachments
      attachments={[]} onRemove={() => {}} onUpload={() => {}} onPaste={() => {}} onDraw={() => {}}
      before={<><h3>{question.question}</h3>{error && <p role="alert" className="question-error">{error}</p>}</>}
      afterPrompt={question.suggestions.length > 0 && <fieldset disabled={pending}><legend>Suggested answers (choose any)</legend>
        {question.suggestions.map(suggestion => <label key={suggestion.id} className="question-option">
          <input type="checkbox" checked={draft.selectedSuggestionIds.includes(suggestion.id)} onChange={() => change(toggleSuggestion(draft, suggestion.id))} />
          <span>{suggestion.text}{question.recommendedSuggestionId === suggestion.id && <span className="question-recommended">Recommended</span>}</span>
        </label>)}
      </fieldset>}
      actions={<button type="button" className="question-dismiss" disabled={pending} onClick={() => void answer(true)}>{pending ? "Sending…" : "Dismiss question"}</button>} />
  </div>;
}

export function RoomConversation({ id, people, onBack, onRefresh, showBack = true, showIdentity = true }: { id: string; people: RoomMember[]; onBack(): void; onRefresh(): Promise<void>; showBack?: boolean; showIdentity?: boolean }) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const draftKey = appStorageKey(`pi-remote-room-draft:${window.PiRemotePerson.get()}:${id}`);
  const [saved] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return { text: "", receipt: null as string | null, error: "" };
      const value = JSON.parse(raw);
      if (typeof value.text !== "string" || value.receipt !== null && (typeof value.receipt !== "string" || !/^[0-9a-f-]{36}$/i.test(value.receipt))) throw new Error("Invalid saved room draft");
      return { text: value.text as string, receipt: value.receipt as string | null, error: "" };
    } catch (cause) { return { text: "", receipt: null as string | null, error: `Could not restore room draft: ${String(cause)}` }; }
  });
  const [text, setText] = useState(saved.text);
  const [error, setError] = useState(saved.error);
  const [details, setDetails] = useState(false);
  const readMarker = useRef<string | null>(null);
  const directoryRefresh = useRef(onRefresh);
  directoryRefresh.current = onRefresh;
  const [pending, setPending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<string | null>(saved.receipt);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await piFetch(`/v1/rooms/${encodeURIComponent(id)}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Room returned HTTP ${response.status}`);
    const value = await response.json() as RoomSnapshot;
    if (signal?.aborted) return;
    setSnapshot(value);
    const marker = value.messages.at(-1)?.id ?? "empty";
    if (document.visibilityState === "visible" && readMarker.current !== marker) {
      await api("POST", `/v1/rooms/${id}/read`, {});
      if (signal?.aborted) return;
      readMarker.current = marker;
      await directoryRefresh.current();
    }
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
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  const changeText = (value: string) => {
    if (pending || receipt) return;
    setText(value);
    try { localStorage.setItem(draftKey, JSON.stringify({ text: value, receipt: null })); }
    catch (cause) { setError(`Could not save room draft: ${String(cause)}`); }
  };
  const send = async () => {
    if (pending || !text.trim()) return;
    if (text.length > 100_000) { setError("Messages can contain up to 100,000 characters. Shorten this draft before sending."); return; }
    setPending(true); setError("");
    const requestId = receipt ?? crypto.randomUUID();
    try {
      localStorage.setItem(draftKey, JSON.stringify({ text, receipt: requestId }));
      setReceipt(requestId);
      await api("POST", `/v1/rooms/${id}/prompt`, { requestId, text });
      setText(""); setReceipt(null);
      localStorage.removeItem(draftKey);
      await Promise.all([load(), directoryRefresh.current()]);
    } catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  const stop = async () => {
    if (pending) return;
    setPending(true); setError("");
    try { await api("POST", `/v1/rooms/${id}/abort`, {}); await load(); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  const add = async () => {
    setPending(true); setError("");
    try { await api("POST", `/v1/rooms/${id}/members`, { members }); setAdding(false); setMembers([]); await Promise.all([load(), onRefresh()]); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  const running = snapshot?.state === "running";
  const question = snapshot?.questions?.[0];
  const action = running && !text.trim() ? "stop" : "send";
  return <section className="conversation-screen room-conversation" aria-label={snapshot?.room.title ?? "Room"}>
    <ConversationHeader title={snapshot?.room.title ?? "Opening room…"} showIdentity={showIdentity} onBack={showBack ? onBack : null} onOpenInspector={() => setDetails(value => !value)}
      meta={<span className="conversation-meta">{snapshot?.room.members.map(member => member.displayName).join(", ")}{snapshot ? " · Kenan" : ""}</span>}
      status={snapshot ? <StatusPill status={roomThreadStatus(snapshot)} /> : <span className="conversation-syncing" role="status">Loading room status…</span>}
      trailing={running && (question || text.trim()) ? <button type="button" className="header-action" disabled={pending} onClick={() => void stop()}>Stop thread</button> : null} />
    {details && <section className="room-details" aria-label="Conversation details">
      <div className="room-details-heading"><strong>People</strong><button type="button" className="header-chip" disabled={!snapshot || running || pending} onClick={() => setAdding(value => !value)}>Add people</button></div>
      <p>{snapshot?.room.members.map(member => member.displayName).join(", ")} · Kenan</p>
      {adding && <form className="room-add-members" onSubmit={event => { event.preventDefault(); void add(); }}>
        <p>New members can read this conversation's history, thinking and work.</p>
        <MemberPicker people={people.filter(person => !snapshot?.room.members.some(member => member.user === person.user))} selected={members} onChange={setMembers} />
        <button type="submit" className="header-action" disabled={running || pending || !members.length}>Add to conversation</button>
      </form>}
      <p className="room-discretion">Everyone here can see this conversation, including Kenan's thinking and work. Private work goes to root Kenan; only his chosen reply comes back.</p>
      {snapshot?.context != null && <details className="room-context"><summary>Context</summary><pre>{JSON.stringify(snapshot.context, null, 2)}</pre></details>}
    </section>}
    <ConversationView active label={`Chat with ${snapshot?.room.title ?? "Kenan"}`} editImages={false}
      drawing={{ isOpen: false, open() {}, editImage() {}, editors: [] }}
      transcript={<div className="transcript conversation-transcript">
        {snapshot?.messages.map(message => message.sender.user === "assistant"
          ? <ChatMessage key={message.id} kind="assistant" label={message.sender.displayName} avatar={agentAvatar()} timestamp={message.time}
              text={message.text} contentFormat="markdown" renderMarkdown={source => <Markdown source={source} sessionId={id} assistant sessionMedia={false} />} />
          : <ChatMessage key={message.id} kind="user" label={message.sender.displayName} timestamp={message.time} text={message.text} contentFormat="literal" />)}
        {(snapshot?.work?.length || snapshot?.thinking) ? <details className="room-work work-card"><summary>Thinking and work</summary>
          <div className="work-steps">{snapshot.work?.map(item => <details className="conversation-step" key={item.id}>
            <summary><span className="step-summary">{item.kind}{item.name ? ` · ${item.name}` : ""}</span></summary>
            <div className="step-detail"><pre>{item.text}</pre></div>
          </details>)}
          {snapshot.thinking && <details className="conversation-step thinking-step" open><summary><span className="step-summary">Thinking now</span></summary><div className="step-detail"><pre>{snapshot.thinking}</pre></div></details>}</div>
        </details> : null}
        {snapshot?.live && <div className="live-answer"><ChatMessage kind="assistant" label="Kenan" avatar={agentAvatar()} text={snapshot.live} contentFormat="markdown" renderMarkdown={source => <Markdown source={source} sessionId={id} streaming assistant sessionMedia={false} />} /></div>}
      </div>}>
      <DismissibleError className="conversation-error" message={snapshot?.error || (snapshot?.held ? "Kenan is stopped in this room." : "") || error} resetKey={id} dismissLabel="Dismiss conversation error" />
      {question ? <section className="questions-composer" aria-label="Questions to answer">
        <div className="questions-heading" role="status">{snapshot!.questions!.length === 1 ? "Question to answer" : `${snapshot!.questions!.length} questions to answer`}<span>Answer or dismiss to return to messaging</span></div>
        <RoomQuestion key={question.id} question={question} roomId={id} onAnswered={load} />
      </section> : <Composer id="room-prompt" value={text} onChange={changeText} onSend={() => void (action === "stop" ? stop() : send())}
        placeholder={`Message ${snapshot?.room.title ?? "Kenan"}`} sendLabel={receipt ? "Retry send" : "Send message"} action={action}
        disabled={!snapshot || pending || action === "send" && !text.trim()} readOnly={pending || !!receipt} layoutKey={id} hideAttachments
        attachments={[]} onRemove={() => {}} onUpload={() => {}} onPaste={() => {}} onDraw={() => {}}
        before={receipt && <span className="room-retry" role="status">{pending ? "Sending…" : "Send unconfirmed. Retry sends the same message once."}</span>} />}
    </ConversationView>
  </section>;
}
