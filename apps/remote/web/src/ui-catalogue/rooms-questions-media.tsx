import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { UiCase } from "./contract";
import { configureFixtureTransport, type FixtureRoute } from "./transport";
import { RoomConversation, RoomCreator } from "../rooms";
import type { RoomMember, RoomSnapshot } from "../../../shared/rooms";
import { readRoomPaging, roomMetadata, roomMembers } from "../../../shared/rooms";
import { revisionOf, type ReconcileFrame } from "../../../shared/reconcile";
import { readRoomRevisions, type RoomRevisions } from "../../../shared/room-sync";
import { validateThreadObservation } from "../../../shared/state-validation";
import type { ThreadQuestion } from "../../../server/protocol";
import { API } from "../../../server/api";
import { appStorageKey } from "../app-path";
import { QuestionsComposer } from "../features/conversation/questions";
import { QuestionContent } from "../features/conversation/question-content";
import { QuestionDrafts } from "../features/conversation/question-drafts";
import { InlineImagesContext, Markdown } from "../context";
import type { InlineImage } from "../../../server/inline-image-contract";
import { CachedImage, ClientCacheContext } from "../cached-media";
import { ClientCache } from "../client-cache";
import { AgentDisclosure, AgentRoute, type RouteEnd } from "../features/conversation/agent-message";
import { ThreadChips, ThreadDirectoryProvider, type ThreadDirectory } from "../features/conversation/thread-chips";
import "../features/conversation/conversation.css";

const roomId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const peerId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const epoch = Date.parse("2026-10-09T12:00:00Z");
const unicode = "日本語 · العربية · e\u0301 · 👩🏽‍💻";
const token = "unbroken-synthetic-name-".repeat(18);
const noop = () => {};
const resolved = async () => {};
const pending = (): Promise<Response> => new Promise(() => {});
const fail = () => Response.json({ error: "Synthetic service unavailable. Your answer is retained; retry when connected." }, { status: 503 });
const people: RoomMember[] = [{ user: "ui-fixture", displayName: "Synthetic person" }, { user: "member_a", displayName: "Member A" }, { user: "member_b", displayName: "Member B" }, { user: "member_c", displayName: unicode }];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#83c5be"/><circle cx="320" cy="180" r="100" fill="#006d77"/><text x="320" y="190" text-anchor="middle" fill="white" font-size="28">Synthetic image</text></svg>';
function Frame({ children }: { children: ReactNode }) { return <div style={{ padding: 16, minWidth: 0 }}>{children}</div>; }

function question(id = "question-1", kind: "options" | "free" | "markdown" | "long" = "options"): ThreadQuestion {
  const value: ThreadQuestion = { id, threadId: sessionId, createdAt: epoch,
    question: kind === "markdown" ? "**Which route should we take?**\n\n| Route | Cost |\n|---|---|\n| Local | One hour |\n| Remote | Two hours |\n\nKeep the draft and [read the notes](https://example.test/notes)." : kind === "long" ? `Which route should we take? ${unicode}\n\n${token}\n\n${"Explain any context that changes the choice. ".repeat(12)}` : "Which route should we take?",
    suggestions: kind === "free" ? [] : [{ id: "local", text: kind === "long" ? `Local route: ${token}` : "Use the **local route**" }, { id: "remote", text: kind === "markdown" ? "Use the remote route\n\n- Keep the existing work\n- [Read details](https://example.test/remote)" : "Use the remote route" }],
    ...(kind === "free" ? {} : { recommendedSuggestionId: "local" }),
  };
  if (!value.question.trim() || value.suggestions.some(option => !option.id || !option.text.trim()) || value.recommendedSuggestionId !== undefined && !value.suggestions.some(option => option.id === value.recommendedSuggestionId)) throw new Error("Invalid synthetic question");
  return value;
}

const largeRoster: RoomMember[] = [people[0]!, ...Array.from({ length: 63 }, (_, index) => ({ user: `member_${index + 1}`, displayName: `Member ${index + 1} · ${unicode} · ${"boundary-name".repeat(12)}`.slice(0, 120) }))];
if (!roomMembers(largeRoster)) throw new Error("Invalid synthetic large roster");
const boundaryRoomTitle = "Synthetic planning room · ".repeat(5).slice(0, 120);

type CreatorMode = "empty" | "members" | "retry" | "corrupt" | "pending" | "failure" | "large-roster";
function CreatorFixture({ mode }: { mode: CreatorMode }) {
  const [created, setCreated] = useState<string | null>(null);
  useMemo(() => {
    const key = appStorageKey(`pi-remote-room-create:${window.PiRemotePerson.get()}`);
    localStorage.removeItem(key);
    if (mode === "retry" || mode === "pending" || mode === "failure") localStorage.setItem(key, JSON.stringify({ title: "Synthetic planning room", members: ["member_a"], requestId }));
    if (mode === "corrupt") localStorage.setItem(key, "{");
    configureFixtureTransport([{ method: "POST", path: "/v1/rooms", reply: mode === "pending" ? pending : mode === "failure" ? fail : () => Response.json({ room: roomSnapshot("empty").room }, { status: 201 }) }]);
  }, [mode]);
  return <Frame>{created ? <p role="status">Created synthetic room.</p> : <RoomCreator people={mode === "large-roster" ? largeRoster : mode === "members" ? [...people, { user: "member_long", displayName: token }] : people} onCreated={setCreated} onRefresh={resolved} />}</Frame>;
}

type QuestionMode = "free" | "options" | "selected" | "multiple" | "markdown" | "long" | "pending" | "failure" | "empty";
function QuestionsFixture({ mode }: { mode: QuestionMode }) {
  const questions = useMemo(() => {
    const first = question("question-1", mode === "free" ? "free" : mode === "markdown" ? "markdown" : mode === "long" ? "long" : "options");
    const drafts = new QuestionDrafts(localStorage, window.PiRemotePerson.get());
    drafts.clear(sessionId, first.id);
    if (mode === "selected" || mode === "pending" || mode === "failure") drafts.save(sessionId, first.id, { text: `Additional context: ${unicode}`, selectedSuggestionIds: ["local", "remote"] });
    configureFixtureTransport([{ method: "POST", path: API.sessionQuestionAnswer.path({ sessionId, questionId: first.id }), reply: mode === "pending" ? pending : mode === "failure" ? fail : () => Response.json({ accepted: true, questionId: first.id }) }]);
    return mode === "empty" ? [] : mode === "multiple" ? [first, question("question-2", "free"), question("question-3")] : [first];
  }, [mode]);
  const [accepted, setAccepted] = useState<string[]>([]);
  return <Frame><QuestionsComposer sessionId={sessionId} questions={questions.filter(item => !accepted.includes(item.id))} onAccepted={id => setAccepted(items => [...items, id])} /></Frame>;
}
function ContentFixture({ disabled }: { disabled: boolean }) {
  const [selected, setSelected] = useState(["local"]);
  return <Frame><QuestionContent question={question("content", "markdown")} selected={selected} disabled={disabled} onToggle={id => setSelected(items => items.includes(id) ? items.filter(value => value !== id) : [...items, id])} /></Frame>;
}

type RoomMode = "loading" | "denied" | "empty" | "history" | "running" | "held" | "error" | "question" | "question-pending" | "question-failure" | "details" | "add" | "retry" | "older" | "waiting" | "running-draft" | "questions-multiple" | "no-back" | "no-identity";
function roomSnapshot(mode: RoomMode): RoomSnapshot {
  const running = mode === "running" || mode === "running-draft";
  const answering = mode.startsWith("question");
  const observation: Pick<RoomSnapshot, "state" | "activity" | "activityDetail" | "waitingOnAgents"> = mode === "waiting" ? { state: "waiting", activity: "awaiting", activityDetail: "Waiting for the synthetic route worker to finish.", waitingOnAgents: { kind: "agents", threadIds: [peerId], after: {}, since: epoch } } : running ? { state: "running", activity: "thinking" } : { state: "idle", activity: "idle" };
  const value: RoomSnapshot = { room: { id: roomId, title: "Synthetic planning room", members: people.slice(0, 3), ...observation, unreadCount: 0, readThrough: 0 },
    ...observation, held: mode === "held", activeTools: [],
    messages: mode === "empty" ? [] : [{ id: "message-1", sender: people[1]!, text: `Let's plan together. ${unicode}`, time: epoch }, { id: "message-2", sender: { user: "assistant", displayName: "Kenan" }, text: "The **local route** is ready.\n\n- Preserve the draft\n- Keep everyone informed", time: epoch + 1000 }],
    paging: { revision: "synthetic-history-v1", total: mode === "empty" ? 0 : mode === "older" ? 8 : 2, start: mode === "older" ? 6 : 0, end: mode === "empty" ? 0 : mode === "older" ? 8 : 2, hasOlder: mode === "older", nextBefore: mode === "older" ? 6 : null },
    live: running ? "I am checking the available **routes**…" : "", thinking: running ? "Compare the choices and preserve everyone's visible context." : "", notificationId: null,
    work: mode === "history" || running ? [{ id: "work-1", kind: "toolCall", name: "functions.read", text: `Synthetic route notes\n${token}` }] : [],
    questions: answering ? (mode === "questions-multiple" ? [question(), question("question-2", "free"), question("question-3", "markdown")] : [question()]).map(item => ({ ...item, threadId: roomId })) : [],
    ...(mode === "error" ? { error: `Synthetic operation failed. Draft retained. ${token}` } : {}),
  };
  if (!roomMetadata(value.room) || !readRoomPaging(value.paging)) throw new Error("Invalid synthetic room");
  validateThreadObservation(value); validateThreadObservation(value.room);
  return value;
}
function RoomFixture({ mode }: { mode: RoomMode }) {
  useMemo(() => {
    const snapshot = roomSnapshot(mode);
    const draftKey = appStorageKey(`pi-remote-room-draft:${window.PiRemotePerson.get()}:${roomId}`);
    localStorage.removeItem(draftKey);
    if (mode === "retry" || mode === "running-draft") localStorage.setItem(draftKey, JSON.stringify({ text: mode === "running-draft" ? "Keep the local route and preserve this draft." : "Synthetic message awaiting acknowledgement", receipt: mode === "running-draft" ? null : requestId }));
    const drafts = new QuestionDrafts(localStorage, window.PiRemotePerson.get());
    drafts.clear(roomId, "question-1");
    if (mode === "question-pending" || mode === "question-failure") drafts.save(roomId, "question-1", { text: "Synthetic answer", selectedSuggestionIds: ["local"] });
    const revisions: RoomRevisions = { cursor: "synthetic-cursor", directory: "synthetic-directory", rooms: { [roomId]: "synthetic-revision" } };
    readRoomRevisions(revisions);
    const resource = `/v1/rooms/${roomId}`;
    const frame: ReconcileFrame = { resource, revision: revisionOf(snapshot), base: null, kind: "full", value: snapshot };
    const routes: FixtureRoute[] = [
      { method: "GET", match: url => url.pathname === "/v1/rooms/changes", reply: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(revisions)}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } }) },
      { method: "GET", match: url => url.pathname === resource && url.searchParams.has("sync"), reply: mode === "loading" ? pending : mode === "denied" ? () => Response.json({ error: "forbidden" }, { status: 403 }) : () => Response.json(frame) },
      { method: "GET", match: url => url.pathname === resource && url.searchParams.has("before"), reply: () => Response.json({ ...snapshot, paging: { ...snapshot.paging, start: 4, end: 6, hasOlder: true, nextBefore: 4 } } satisfies RoomSnapshot) },
      { method: "POST", path: `${resource}/questions/question-1/answer`, reply: mode === "question-pending" ? pending : mode === "question-failure" ? fail : () => Response.json({ accepted: true, questionId: "question-1" }) },
      ...["read", "prompt", "abort", "members"].map(path => ({ method: "POST" as const, path: `${resource}/${path}`, reply: () => Response.json({ accepted: true }) })),
    ];
    configureFixtureTransport(routes);
  }, [mode]);
  return <div style={{ height: "100dvh" }}><RoomConversation id={roomId} people={[...people, { user: "member_long", displayName: token }]} onBack={noop} onRefresh={resolved} showBack={mode !== "no-back"} showIdentity={mode !== "no-identity"} /></div>;
}

type ImageMode = "queued" | "dependencies" | "generating" | "complete" | "error" | "conflict" | "missing" | "registration" | "partial" | "load-failure";
function InlineFixture({ mode }: { mode: ImageMode }) {
  const images = useMemo(() => {
    configureFixtureTransport([{ method: "GET", match: url => url.pathname === API.sessionFiles.path({ sessionId }), reply: () => new Response(mode === "load-failure" ? "" : svg, { status: mode === "load-failure" ? 404 : 200, headers: { "content-type": "image/svg+xml" } }) }]);
    if (mode === "registration" || mode === "partial") return null;
    if (mode === "missing") return new Map<string, InlineImage>();
    const state: InlineImage["state"] = mode === "dependencies" ? "queued" : mode === "conflict" || mode === "load-failure" ? "complete" : mode;
    const path = state === "complete" ? mode === "load-failure" ? "/synthetic/missing-image.png" : "/synthetic/image.png" : null;
    const image: InlineImage = { id: "synthetic-image", prompt: "A synthetic diagram", refs: [], state, createdAt: new Date(epoch).toISOString(), updatedAt: new Date(epoch).toISOString(), waitingFor: mode === "dependencies" ? ["source-image", "mask-image"] : [], error: state === "error" ? { code: "provider_error", message: `Synthetic provider failure. ${token}` } : null, conflict: mode === "conflict" ? "A later definition differed. The first image is retained." : null, path, paths: path ? [path] : [], model: state === "complete" ? "synthetic-image-model" : null, responseId: state === "complete" ? "synthetic-response" : null };
    return new Map([[image.id, image]]);
  }, [mode]);
  return <Frame><InlineImagesContext.Provider value={images}><Markdown assistant sessionId={sessionId} streaming={mode === "partial"} source={`## Synthetic image\n\n${mode === "partial" ? '<pi-remote-image id="synthetic-image" prompt="A synthetic' : '<pi-remote-image id="synthetic-image" />'}`} /></InlineImagesContext.Provider></Frame>;
}

type CacheMode = "loading" | "ready" | "failure" | "decode-failure";
function CachedFixture({ mode }: { mode: CacheMode }) {
  const cache = useMemo(() => {
    configureFixtureTransport([{ method: "GET", match: url => url.pathname === API.sessionImage.path({ sessionId, hash: "synthetic-image" }), reply: mode === "loading" ? pending : mode === "failure" ? fail : () => new Response(mode === "decode-failure" ? "not an image" : svg, { headers: { "content-type": "image/svg+xml" } }) }]);
    const scope = `synthetic-cache-${mode}-${crypto.randomUUID()}`;
    return new ClientCache(async () => scope);
  }, [mode]);
  useEffect(() => () => cache.dispose(), [cache]);
  return <Frame><ClientCacheContext.Provider value={cache}><CachedImage src={API.sessionImage.path({ sessionId, hash: "synthetic-image" })} alt="Synthetic cached image" style={{ maxWidth: "100%", width: 640 }} fallback={<p role="status">Synthetic image unavailable or still loading.</p>} /></ClientCacheContext.Provider></Frame>;
}

function AgentsFixture({ mode }: { mode: "incoming" | "outgoing" | "new" | "closed" | "chips" }) {
  const [open, setOpen] = useState(mode !== "closed");
  const [opened, setOpened] = useState<string | null>(null);
  const directory: ThreadDirectory = { name: id => id === peerId ? `Synthetic peer ${token}` : null, busy: id => id === peerId, open: setOpened, discover: noop, lookupError: id => id === requestId ? "Synthetic lookup unavailable" : null };
  const self: RouteEnd = { kind: "self", threadId: sessionId };
  const peer: RouteEnd = mode === "new" ? { kind: "new", title: token } : { kind: "peer", threadId: peerId, name: "Peer" };
  return <Frame><div className="conversation-transcript"><ThreadDirectoryProvider value={directory}>{mode === "chips" ? <ThreadChips ids={[peerId, requestId, roomId]} /> : <AgentDisclosure open={open} onOpen={setOpen} route={<AgentRoute from={mode === "incoming" ? peer : self} to={mode === "incoming" ? self : peer} direction={mode === "incoming" ? "incoming" : "outgoing"} />}><Markdown source={`A synthetic agent message. ${unicode}\n\n${token}`} sessionId={sessionId} /></AgentDisclosure>}{opened && <p role="status">Opened synthetic thread {opened}.</p>}</ThreadDirectoryProvider></div></Frame>;
}

const fixtureCase = (id: string, component: string, contract: string, boundary: UiCase["boundary"], render: UiCase["render"]): UiCase => ({ id, title: id.replaceAll("-", " "), component, contract, boundary, render });
export const roomsQuestionsMediaCases: UiCase[] = [
  ...(["empty", "members", "retry", "corrupt", "pending", "failure"] as const).map(mode => fixtureCase(`room-create-${mode}`, "RoomCreator MemberPicker", `Room creation ${mode}; pending/failure are reached by Retry creation.`, mode === "members" ? "content-boundary" : "finite-variant", () => <CreatorFixture mode={mode} />)),
  fixtureCase("room-create-large-roster", "RoomCreator MemberPicker", `64 valid directory members (self excluded by production picker); enter this valid 120-character title: ${boundaryRoomTitle}`, "content-boundary", () => <CreatorFixture mode="large-roster" />),
  ...(["free", "options", "selected", "multiple", "markdown", "long", "pending", "failure", "empty"] as const).map(mode => fixtureCase(`questions-${mode}`, "QuestionsComposer QuestionForm QuestionContent", `Question queue ${mode}; pending/failure are reached by Submit answer.`, mode === "long" || mode === "markdown" ? "content-boundary" : "finite-variant", () => <QuestionsFixture mode={mode} />)),
  ...([false, true] as const).map(disabled => fixtureCase(`question-content-${disabled ? "disabled" : "enabled"}`, "QuestionContent QuestionText", `Markdown question and recommendations; disabled=${disabled}.`, "finite-variant", () => <ContentFixture disabled={disabled} />)),
  ...(["loading", "denied", "empty", "history", "running", "held", "error", "question", "question-pending", "question-failure", "details", "add", "retry", "older", "waiting", "running-draft", "questions-multiple", "no-back", "no-identity"] as const).map(mode => fixtureCase(`room-${mode}`, "RoomConversation RoomQuestion", `Contract-valid room ${mode}; details/add/older and pending/failure reached through production controls.`, "composition", () => <RoomFixture mode={mode} />)),
  ...(["queued", "dependencies", "generating", "complete", "error", "conflict", "missing", "registration", "partial", "load-failure"] as const).map(mode => fixtureCase(`inline-image-${mode}`, "Markdown InlineImagesContext", `InlineImage presentation ${mode}; synthetic file transport, no provider calls.`, "finite-variant", () => <InlineFixture mode={mode} />)),
  ...(["loading", "ready", "failure", "decode-failure"] as const).map(mode => fixtureCase(`cached-image-${mode}`, "CachedImage", `Real ClientCache fetch ${mode}, isolated synthetic disk scope.`, "finite-variant", () => <CachedFixture mode={mode} />)),
  ...(["incoming", "outgoing", "new", "closed", "chips"] as const).map(mode => fixtureCase(`agent-route-${mode}`, "AgentDisclosure AgentRoute ThreadChips", `Agent route ${mode}; name-known/name-unknown/lookup-failed and busy chips.`, mode === "chips" ? "content-boundary" : "finite-variant", () => <AgentsFixture mode={mode} />)),
];
