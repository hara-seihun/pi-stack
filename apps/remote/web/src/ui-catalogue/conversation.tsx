import { useState, type ReactNode } from "react";
import type { UiCase } from "./contract";
import { configureFixtureTransport } from "./transport";
import { validateSession, ACTIVITIES } from "../../../shared/state-validation";
import type { Activity, ContextEntry, QueuedMessage, Session } from "../types";
import { Composer, type ComposerAttachment } from "../Composer";
import { ConversationScreen } from "../features/conversation/ConversationScreen";
import { ChatMessage, type ChatAttachment } from "../chat-message";
import { Markdown } from "../context";
import type { ReplyTarget } from "../message-reply";
import { ChatPicker } from "../thread-start-menu";
import { useChatDrawing } from "../chat-drawing";
import { DrawingCanvas } from "../DrawingCanvas";
import { DrawingColourPicker } from "../DrawingColourPicker";
import { PasteTextDialog } from "../PasteTextDialog";
import { SpeechBarControls } from "../SpeechBar";
import type { SpeechState } from "../speech";
import { PromptOutboxStatus } from "../PromptOutboxStatus";
import type { PromptOutboxEntry, PromptOutboxOutcome } from "../prompt-outbox";
import type { PromptStorageState } from "../prompt-storage";
import { InspectorSheet } from "../features/inspector/InspectorSheet";
import { QueueSheet } from "../features/queue/QueueSheet";
import { StatusPill } from "../features/status/StatusPill";
import { OFFLINE_STATUS, threadStatus } from "../features/status/thread-status";

const noop = () => {};
const epoch = Date.parse("2026-10-09T12:00:00Z");
const unicode = "日本語 · العربية · e\u0301 · 👩🏽‍💻 · Nebulani kēna";
const longToken = "very-long-unbroken-content-".repeat(20);
const prose = `A readable message with ${unicode}.\n\n${"This paragraph remains selectable, and wraps at the viewport boundary. ".repeat(8)}`;
const markdown = `# Review notes\n\n**Ready**: ${unicode}.\n\n- Preserve the draft\n- Keep actions visible\n\n| State | Action |\n|---|---|\n| Saved | Retry the same request |\n| Held | Resume |\n\n\`\`\`typescript\nconst identifier = "${longToken}";\n\`\`\`\n\n[Long link](https://example.test/${longToken})\n\n${prose}`;
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#83c5be"/><circle cx="320" cy="180" r="100" fill="#006d77"/><text x="320" y="190" text-anchor="middle" fill="white" font-size="28">Synthetic image</text></svg>')}`;

type Observation = { kind: "idle" } | { kind: "held" } | { kind: "cancelling" } | { kind: "archived" }
  | { kind: "error"; message: string } | { kind: "reporting-error" }
  | { kind: "running"; phase: Exclude<Activity, "idle" | "awaiting" | "status_error" | "waiting_on_agents" | "waiting_on_tool"> }
  | { kind: "tools"; tools: [string, ...string[]] } | { kind: "agent-tool" }
  | { kind: "dependency"; wait: NonNullable<Session["waitingOnAgents"]> };
type ObservationKeys = "state" | "held" | "activity" | "activeTools" | "archivedAt" | "executionError" | "waitingOnAgents";
function observationFields(observation: Observation): Pick<Session, "state" | "held" | "activity" | "activeTools" | "archivedAt"> & Partial<Pick<Session, "executionError" | "waitingOnAgents">> {
  const idle = { state: "idle", held: false, activity: "idle", activeTools: [], archivedAt: null } satisfies Pick<Session, "state" | "held" | "activity" | "activeTools" | "archivedAt">;
  switch (observation.kind) {
    case "idle": return idle;
    case "held": return { ...idle, held: true };
    case "archived": return { ...idle, archivedAt: new Date(epoch).toISOString() };
    case "error": return { ...idle, executionError: observation.message };
    case "reporting-error": return { ...idle, state: "running", activity: "status_error" };
    case "cancelling": return { ...idle, state: "running", held: true, activity: "cancelling" };
    case "running": return { ...idle, state: "running", activity: observation.phase };
    case "tools": return { ...idle, state: "running", activity: "waiting_on_tool", activeTools: observation.tools };
    case "agent-tool": return { ...idle, state: "running", activity: "waiting_on_agents", activeTools: ["functions.thread_await"] };
    case "dependency": return { ...idle, state: "waiting", activity: "awaiting", waitingOnAgents: observation.wait };
  }
}
export function conversationSession(patch: Partial<Omit<Session, ObservationKeys>> & { observation?: Observation } = {}): Session {
  const { observation = { kind: "idle" }, ...display } = patch;
  const value: Session = {
    id: "catalogue-session", parentId: null, hasChildren: false, origin: "person", foreground: true,
    model: "openai/gpt-6.1-sol", name: "Visual review", agentName: "Kenan", cwd: "/home/catalogue/project",
    workspaceName: "Catalogue", environment: "Synthetic local", provider: "openai", createdAt: new Date(epoch).toISOString(), updatedAt: new Date(epoch).toISOString(),
    revision: 1, idleUnread: false, queuedMessages: [], ...display, ...observationFields(observation),
  };
  validateSession(value);
  return value;
}
const session = conversationSession;
function entry(kind: ContextEntry["kind"], text: string, key: string): ContextEntry {
  return { key, signature: key, kind, text, label: kind, time: epoch, messageTimestamp: epoch };
}
const messages = [entry("user", `Please review this. ${unicode}`, "user"), entry("assistant", markdown, "answer")];
const toolEntries: ContextEntry[] = [
  entry("system", "You are Kenan. Use the explicit valid state contract.", "system"),
  entry("tool", '{"name":"read","description":"Read an existing file"}', "schema"),
  entry("thinking", "I will examine the finite variants and the content boundaries.", "thinking"),
  { ...entry("toolCall", "", "tool-success"), toolCall: { name: "functions.read", arguments: { path: "/home/catalogue/project/README.md" } }, toolResult: { preview: "File contents are readable.", timestamp: epoch + 1000, size: 27, isError: false } },
  { ...entry("toolCall", "", "tool-failure"), toolCall: { name: "functions.bash", arguments: { command: longToken, timeout: 55 } }, toolResult: { preview: `Permission denied: ${longToken}`, timestamp: epoch + 2000, size: 400, isError: true } },
  entry("notice", "The requested operation failed. Your draft is retained.", "notice"),
];
function Frame({ children }: { children: ReactNode }) { return <div style={{ padding: 16, minWidth: 0 }}>{children}</div>; }
function ScreenFixture({ mode }: { mode: "empty" | "history" | "working" | "held" | "offline" | "syncing" | "expanded" | "slash" | "errors" | "reply" | "long-header" }) {
  const [prompt, setPrompt] = useState(mode === "working" ? `Follow up: ${unicode}` : mode === "slash" ? "/" : "");
  const [reply, setReply] = useState<ReplyTarget | null>(mode === "reply" ? { identity: { id: "pi/catalogue-session/original", timestamp: epoch, sender: { id: "person", name: "A very long original sender name" } }, text: prose } : null);
  const drawing = useChatDrawing("ai:catalogue-session", async () => ({ ok: true }));
  const busy = mode === "working";
  const current = session({
    ...(busy ? { observation: { kind: "running", phase: "thinking" } as const } : {}),
    ...(mode === "held" ? { observation: { kind: "held" } as const, queuedMessages: [queueMessage("held", "queue", "queued")] } : {}),
    ...(mode === "long-header" ? { name: `${unicode} ${longToken}`, model: `provider/${longToken}`, contextUsage: { tokens: 180000, contextWindow: 200000, percent: 90 } } : {}),
  });
  return <div style={{ height: "100dvh" }}><ConversationScreen session={current} ancestors={mode === "long-header" ? [session({ id: "parent", agentName: unicode })] : []}
    entries={mode === "empty" ? [] : mode === "expanded" ? [...messages.slice(0, 1), ...toolEntries, ...messages.slice(1)] : messages}
    liveText={busy ? "Streaming **response** with an unfinished list:\n- first item\n- " : ""} liveThinking={busy ? "Inspecting the available states…" : ""} thinkingActive={busy}
    autoCollapse={mode !== "expanded"} images={null} offline={mode === "offline" ? "Connection lost" : ""} syncing={mode === "syncing"} pending={false}
    home="/home/catalogue" prompt={prompt} attachments={[]} slashCommands={[{ name: "kelana", description: prose, source: "skill" }, { name: "software-engineering", description: "Valid states and explicit errors", source: "skill" }]}
    drawing={drawing} uploadError={mode === "errors" ? prose : ""} controlError={mode === "errors" ? "Cancel failed: runtime did not acknowledge." : ""}
    earlierAvailable={mode === "history"} loadingEarlier={false} earlierError={mode === "history" ? "Earlier messages unavailable. Retry loading." : ""} onShowEarlier={noop}
    newerAvailable={mode === "history"} onShowNewer={noop} onJumpLatest={noop} onThinkingOpen={noop} showBack onBack={noop} onOpenInspector={noop} onOpenAncestor={noop} onOpenQueue={noop}
    questions={[]} onQuestionAccepted={noop} onEdit={noop} reply={reply} onReply={setReply} onCancelReply={() => setReply(null)} onPrompt={setPrompt} onSend={noop} onStop={noop} onResume={noop} onReconnect={noop}
    onRemoveAttachment={noop} onUpload={noop} onPaste={noop} onDraw={() => drawing.open()} onDismissControlError={noop} /></div>;
}
function ComposerFixture({ mode }: { mode: "empty" | "long" | "uploading" | "many" | "readonly" | "stop" | "resume" | "hidden" }) {
  const [value, setValue] = useState(mode === "long" ? `${prose}\n${longToken}` : mode === "empty" || mode === "stop" || mode === "resume" ? "" : unicode);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(mode === "many" ? Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `${unicode}-${longToken}-${i}.txt` })) : mode === "uploading" ? [{ id: "upload", name: `${longToken}.png`, uploading: true }] : []);
  return <Frame><Composer value={value} onChange={setValue} onSend={noop} placeholder="Message Kenan" disabled={mode === "empty" || mode === "uploading" || mode === "readonly"} readOnly={mode === "readonly"}
    attachments={attachments} onRemove={id => setAttachments(items => items.filter(item => item.id !== id))} onUpload={noop} onPaste={noop} onDraw={noop} hideAttachments={mode === "hidden"} action={mode === "stop" ? "stop" : mode === "resume" ? "resume" : "send"} /></Frame>;
}
function queueMessage(id: string, delivery: QueuedMessage["delivery"], state: QueuedMessage["state"], acknowledgement?: QueuedMessage["acknowledgement"]): QueuedMessage {
  return { id, text: `${id}: ${unicode}`, delivery, state, acknowledgement, canSteer: state === "queued" && delivery === "queue", canHardSteer: state === "queued" && delivery !== "hardSteer", canCancel: state === "queued", createdAt: new Date(epoch).toISOString() };
}
const queueVariants: QueuedMessage[] = [
  queueMessage("queued", "queue", "queued"), queueMessage("steering", "steer", "queued"), queueMessage("interrupting", "hardSteer", "queued"),
  queueMessage("sent", "queue", "dispatched"), queueMessage("pending", "steer", "dispatched", "pending"), queueMessage("unconfirmed", "hardSteer", "dispatched", "unconfirmed"),
];
function QueueFixture({ mode }: { mode: "empty" | "variants" | "held" | "pending" | "long" }) {
  const [open, setOpen] = useState(true);
  const rows = mode === "empty" ? [] : mode === "long" ? queueVariants.map(item => ({ ...item, text: `${prose}\n${longToken}` })) : queueVariants;
  validateSession(session({ queuedMessages: rows }));
  return <QueueSheet open={open} messages={rows} held={mode === "held"} pending={mode === "pending"} onClose={() => setOpen(false)} onAction={noop} />;
}
function InspectorFixture({ mode }: { mode: "idle" | "archived" | "agents" | "job" | "deployment" | "message" | "error" | "children" }) {
  const [open, setOpen] = useState(true);
  const wait: Session["waitingOnAgents"] = mode === "agents" ? { kind: "agents", threadIds: ["peer"], after: {}, since: epoch, reason: prose }
    : mode === "job" ? { kind: "job", jobId: longToken, since: epoch, reason: "Waiting for job completion" }
    : mode === "deployment" ? { kind: "deployment", publicationId: longToken, since: epoch, reason: "Waiting for publication" }
    : mode === "message" ? { kind: "message", fromThreadId: "peer", since: epoch, reason: "Waiting for a collaborator" } : undefined;
  const current = session({ observation: wait ? { kind: "dependency", wait } : mode === "archived" ? { kind: "archived" } : mode === "error" ? { kind: "error", message: prose } : { kind: "idle" }, cwd: `/home/catalogue/${longToken}` });
  const children = mode === "children" ? Array.from({ length: 8 }, (_, i) => session({ id: `child-${i}`, parentId: current.id, agentName: `${unicode}-${i}`, name: prose })) : [];
  configureFixtureTransport([
    { method: "GET", match: url => url.pathname === `/v1/sessions/${current.id}/children`, reply: () => Response.json({ children }) },
    { method: "GET", match: url => url.pathname === `/v1/sessions/${current.id}/events`, reply: () => Response.json({ events: [{ seq: 1, time: new Date(epoch).toISOString(), type: "execution.started", phase: "thinking" }, { seq: 2, time: new Date(epoch).toISOString(), type: "tool.finished", detail: longToken, result: { ok: true } }] }) },
  ]);
  return <InspectorSheet session={current} sessions={[current, session({ id: "peer", name: unicode }), ...children]} open={open} pending={false} onClose={() => setOpen(false)} onOpenThread={noop} onOpenThreadId={noop} onArchive={noop} onRestore={noop} onBackground={noop} />;
}
function StatusMatrix() {
  const phases = Object.keys(ACTIVITIES) as Activity[];
  const rows = phases.map(activity => session({ observation: activity === "idle" ? { kind: "idle" }
    : activity === "awaiting" ? { kind: "dependency", wait: { kind: "job", jobId: "job-1", reason: "Waiting for the external job", since: epoch } }
    : activity === "status_error" ? { kind: "reporting-error" }
    : activity === "waiting_on_agents" ? { kind: "agent-tool" }
    : activity === "waiting_on_tool" ? { kind: "tools", tools: ["functions.read"] }
    : { kind: "running", phase: activity } }));
  rows.push(session({ observation: { kind: "held" } }), session({ observation: { kind: "cancelling" } }), session({ observation: { kind: "error", message: "Execution failed. Your input is retained." } }), session({ idleUnread: true }), session({ observation: { kind: "archived" } }), session({ observation: { kind: "tools", tools: ["functions.read", "functions.bash"] } }), session({ observation: { kind: "tools", tools: ["functions.read", "functions.bash", "functions.agent_browser"] } }));
  return <Frame><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 16 }}>{rows.map((row, i) => <div key={i}><small>{row.activity}{row.held ? " · held" : ""}</small><div><StatusPill status={threadStatus(row)} /></div></div>)}<StatusPill status={OFFLINE_STATUS} /></div></Frame>;
}
function PasteFixture({ mode }: { mode: "empty" | "long" | "failure" | "pending" }) {
  const [name, setName] = useState(mode === "empty" ? "" : `${unicode}-${longToken}`);
  const [content, setContent] = useState(mode === "empty" ? "" : `${prose}\n${longToken}`);
  const [open, setOpen] = useState(true);
  return open ? <PasteTextDialog name={name} content={content} onNameChange={setName} onContentChange={setContent} onClose={() => setOpen(false)} onAttach={async () => mode === "pending" ? new Promise(() => {}) : mode === "failure" ? { ok: false, error: prose } : { ok: true }} /> : <Frame>Document attached.</Frame>;
}
function DrawingFixture({ mode }: { mode: "blank" | "image" | "failure" }) {
  return <div className="conversation is-drawing" style={{ height: "100dvh" }}><div className="drawing-slot"><DrawingCanvas background={mode === "blank" ? undefined : { src: mode === "failure" ? "data:image/png;base64,broken" : image, alt: "Synthetic annotated image", name: `${unicode}.png` }} onAttach={async () => ({ ok: false, error: "Could not attach the drawing. It is retained." })} onClose={noop} /></div></div>;
}
function ColourFixture() {
  const [color, setColor] = useState("#006d77");
  return <Frame><DrawingColourPicker color={color} onChange={setColor} /><DrawingColourPicker color="#fff" onChange={noop} disabled /></Frame>;
}
function SpeechFixture({ status }: { status: SpeechState["status"] }) {
  const [state, setState] = useState<SpeechState>({ catalog: { engines: [{ id: "synthetic", name: "Synthetic speech", defaultVoice: "voice-1" }] }, status, error: status === "error" ? prose : "", title: prose, rate: 1.25, engine: "synthetic", voice: "voice-1", voices: [{ id: "voice-1", name: `${unicode} ${longToken}` }, { id: "voice-2", name: "Second voice" }], voicesError: "", position: 7384 });
  return <Frame><SpeechBarControls state={state} onToggle={() => setState(current => ({ ...current, status: current.status === "playing" ? "paused" : "playing" }))} onVoice={voice => setState(current => ({ ...current, voice }))} onRate={() => setState(current => ({ ...current, rate: 1.5 }))} onStop={() => setState(current => ({ ...current, status: "idle" }))} /></Frame>;
}
function OutboxFixture({ mode }: { mode: "variants" | "storage-loading" | "storage-failed" }) {
  const outcomes: PromptOutboxOutcome[] = [
    { kind: "pending", reason: "saved", message: "Saved before sending." }, { kind: "pending", reason: "transport", message: "Connection lost; acceptance not confirmed." },
    { kind: "pending", reason: "authentication", message: "Sign in to check acceptance." }, { kind: "pending", reason: "unconfirmed", message: "Acknowledgement not received; not resent." },
    { kind: "rejected", message: prose }, { kind: "accepted", workId: "work-1" },
  ];
  const entries: PromptOutboxEntry[] = outcomes.map((outcome, i) => ({ requestId: `request-${i}`, sessionId: "catalogue-session", bodyJson: JSON.stringify({ requestId: `request-${i}`, text: `${prose}\n${longToken}`, delivery: i % 2 ? "steer" : "queue" }), createdAt: epoch, outcome }));
  const storage: PromptStorageState<unknown> = mode === "storage-loading" ? { kind: "loading" } : mode === "storage-failed" ? { kind: "failed", error: { kind: "unavailable", message: prose } } : { kind: "ready", owner: {} };
  return <Frame><PromptOutboxStatus entries={mode === "variants" ? entries : []} busyRequestId="request-1" onRetry={noop} onDiscard={noop} storage={{ state: storage, retry: noop }} /></Frame>;
}
function MessageFixture({ mode }: { mode: "literal" | "markdown" | "media" | "reply" }) {
  const attachments: ChatAttachment[] = mode === "media" ? [
    { id: "image", name: unicode, url: image, size: 4096, kind: "image" },
    { id: "audio", name: "Synthetic unavailable audio", url: "data:audio/wav;base64,broken", size: 1024, kind: "audio" },
    { id: "video", name: "Synthetic unavailable video", url: "data:video/mp4;base64,broken", size: 1024, kind: "video" },
    { id: "file", name: `${longToken}.txt`, url: "data:text/plain,example", size: 8192, kind: "file" },
  ] : [];
  const [target, setTarget] = useState<string | null>(null);
  return <Frame><ChatMessage kind="user" label={unicode} text={mode === "literal" ? `${prose}\n${longToken}` : markdown} contentFormat="markdown" renderMarkdown={text => mode === "literal" ? <div className="message-text">{text}</div> : <Markdown source={text} sessionId="catalogue-session" />}
    timestamp={epoch} identity={{ id: "pi/catalogue-session/message", timestamp: epoch, sender: { id: "person", name: unicode, own: true } }}
    reply={mode === "reply" ? { messageId: null, sender: { id: "peer", name: unicode }, text: `${prose}\n${longToken}` } : undefined}
    reactions={mode === "reply" ? [{ emoji: "👍", timestamp: epoch, sender: { id: "peer", name: "Peer" } }, { emoji: "👩🏽‍💻", timestamp: epoch, sender: { id: "person", own: true }, own: true }] : []}
    onReply={reply => setTarget(reply.text)} attachments={attachments} delivery={mode === "reply" ? { status: "failed", error: "The message was not delivered." } : undefined}
    responseMetrics={{ ttftMs: 1400, generationMs: 4000, outputTokens: 300, tokensPerSecond: 75 }} />{target && <p role="status">Reply selected: {target}</p>}</Frame>;
}
function PickerFixture({ mode }: { mode: "root" | "empty" | "many" | "loading" | "failure" }) {
  const archived = mode === "many" ? Array.from({ length: 20 }, (_, i) => session({ id: `archived-${i}`, name: `${unicode} ${prose}`, observation: { kind: "archived" } })) : [];
  configureFixtureTransport([
    { method: "GET", match: url => url.pathname === "/v1/sessions/archived", reply: () => mode === "loading" ? new Promise(() => {}) : mode === "failure" ? Response.json({ error: "synthetic_unavailable", message: prose }, { status: 503 }) : Response.json({ sessions: archived, total: mode === "many" ? 80 : 0 }) },
    { method: "GET", match: url => url.pathname === "/v1/sessions", reply: () => Response.json({ sessions: [session({ id: "background", foreground: false, name: prose })] }) },
  ]);
  return <Frame><div className="inbox-header"><ChatPicker starts={[{ id: "personal", label: "Personal", icon: "personal", models: Array.from({ length: 12 }, (_, i) => ({ id: `openai/synthetic-model-${i}`, label: `Synthetic model ${i} ${unicode}`, icon: "openai" })), contexts: [{ name: "notes.md", label: prose, tokens: 12000, bytes: 40000 }, { name: "unicode.md", label: unicode, tokens: 2400, bytes: 6000 }] }]} initialEntry={{ kind: mode === "root" ? "root" : "archived" }} onSelect={async () => {}} onCreated={noop} onSettled={noop} /></div></Frame>;
}
function ui(id: string, component: string, contract: string, render: () => ReactNode, boundary: UiCase["boundary"] = "finite-variant"): UiCase {
  return { id: `conversation-${id}`, title: id.replaceAll("-", " "), component, contract, boundary, render };
}
export const conversationCases: UiCase[] = [
  ...(["root", "empty", "many", "loading", "failure"] as const).map(mode => ui(`picker-${mode}`, "ChatPicker", "Root and archived empty/many/loading/failure; model/context and agent navigation via real controls", () => <PickerFixture mode={mode} />)),
  ...(["empty", "history", "working", "held", "offline", "syncing", "expanded", "slash", "errors", "reply", "long-header"] as const).map(mode => ui(`screen-${mode}`, "ConversationScreen", `Valid session and ${mode} conversation composition`, () => <ScreenFixture mode={mode} />, "composition")),
  ...(["empty", "long", "uploading", "many", "readonly", "stop", "resume", "hidden"] as const).map(mode => ui(`composer-${mode}`, "Composer", `${mode} prompt, attachment and action state`, () => <ComposerFixture mode={mode} />, mode === "long" || mode === "many" ? "content-boundary" : "finite-variant")),
  ui("status-matrix", "StatusPill / StatusIcon", "All Activity variants plus held, cancellation, error, unread, archived, offline and 1/2/many tools; every fixture validates", () => <StatusMatrix />),
  ...(["empty", "variants", "held", "pending", "long"] as const).map(mode => ui(`queue-${mode}`, "QueueSheet", "All deliveries and queued/dispatched acknowledgement variants; held and pending action availability", () => <QueueFixture mode={mode} />)),
  ...(["idle", "archived", "agents", "job", "deployment", "message", "error", "children"] as const).map(mode => ui(`inspector-${mode}`, "InspectorSheet", "Valid thread lifecycle and typed dependency waits; exact synthetic children/events routes", () => <InspectorFixture mode={mode} />)),
  ...(["empty", "long", "failure", "pending"] as const).map(mode => ui(`paste-${mode}`, "PasteTextDialog", "Empty/long document and submitted pending/failure states", () => <PasteFixture mode={mode} />)),
  ...(["blank", "image", "failure"] as const).map(mode => ui(`drawing-${mode}`, "DrawingCanvas", "Blank paper, decoded background and failed background; pointer/zoom/export controls", () => <DrawingFixture mode={mode} />)),
  ui("drawing-colour", "DrawingColourPicker", "Enabled/disabled and opened HSV picker interaction", () => <ColourFixture />),
  ...(["idle", "loading", "playing", "paused", "error"] as const).map(status => ui(`speech-${status}`, "SpeechBarControls", "All speech statuses; long voice/title and multi-hour position", () => <SpeechFixture status={status} />)),
  ...(["variants", "storage-loading", "storage-failed"] as const).map(mode => ui(`outbox-${mode}`, "PromptOutboxStatus", "All pending reasons, rejection and accepted hiding; storage initialization variants", () => <OutboxFixture mode={mode} />)),
  ...(["literal", "markdown", "media", "reply"] as const).map(mode => ui(`message-${mode}`, "ChatMessage / Markdown", "Literal/markdown, media types, reply quote/reactions, failed delivery and response metrics", () => <MessageFixture mode={mode} />, "content-boundary")),
];
