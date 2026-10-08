import { useState, type ReactNode } from "react";
import type { Session, HistoryNotification, ThreadStart } from "../../../server/protocol";
import type { CalendarEvent, CalendarSnapshot } from "../../../server/calendar-protocol";
import type { NeedsYouItem, NeedsYouProjection } from "../../../shared/needs-you";
import { validateSession } from "../../../shared/state-validation";
import type { Room } from "../../../shared/rooms";
import { Inbox } from "../features/chats/Inbox";
import { AgentsDirectory, type AgentDirectoryState } from "../features/agents/AgentsScreen";
import { inboxRows, type ChatId } from "../chats";
import { AttentionScreen } from "../attention";
import { CalendarScreen, EventEditor, type CalendarDraft } from "../calendar";
import { NeedsYouCard, NeedsYouDetails } from "../needs-you";
import { configureFixtureTransport } from "./transport";
import type { UiCase } from "./contract";
import { machineFilesCases } from "./machine-files";
import { settingsAuthCases } from "./settings-auth";
import "../chat-picker-trigger.css";

const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();
const long = "Review the deployment and internationalisation report · 日本語 Ελληνικά العربية 🧭 ";
const unbroken = "synthetic_workspace_".repeat(14);
const noop = () => {};
const starts: ThreadStart[] = [{ id: "synthetic", label: "Synthetic home", icon: "cloud", models: [{ id: "openai/gpt-6.1-sol", label: "Sol", icon: "openai" }] }];
function session(id: string, changes: Partial<Session> = {}): Session {
  const value: Session = { id, name: `Task ${id}`, agentName: `Agent ${id}`, parentId: null, hasChildren: false, origin: "person", foreground: true, model: "openai/gpt-6.1-sol", provider: "openai", cwd: "/synthetic", workspaceName: "Home", environment: "synthetic", state: "idle", activity: "idle", held: false, activeTools: [], createdAt: iso(-86400000), updatedAt: iso(-300000), revision: 1, idleUnread: false, queuedMessages: [], archivedAt: null, ...changes };
  validateSession(value);
  return value;
}
const threads = [
  session("decision", { name: "Choose the next delivery window", idleUnread: true, attentionSummary: "Please choose the appointment time before 17:00 UTC.", color: "orange" }),
  session("thinking", { name: "Review interface states", state: "running", activity: "thinking", activitySince: now - 45000, lastActivityAt: now - 20000, color: "blue" }),
  session("tool", { name: "Read synthetic documents", state: "running", activity: "waiting_on_tool", activeTools: ["functions.read", "functions.bash"], lastActivityAt: now - 17000 }),
  session("waiting", { name: "Wait for the delivery receipt", state: "waiting", activity: "awaiting", waitingOnAgents: { kind: "job", jobId: "synthetic-job", reason: "Build owns the delivery receipt", since: now - 60000 } }),
  session("quiet", { name: "Finished notes", color: "green" }),
  session("error", { name: "Transport needs a retry", executionError: "Synthetic connection is offline; reconnect before sending." }),
  session("held", { name: "Paused revision", held: true, queuedMessages: [{ id: "queued", text: "Resume the review", state: "queued", delivery: "queue", canSteer: true, canHardSteer: true, canCancel: true, createdAt: iso(-30000) }] }),
];
const rooms: Room[] = [{ id: "00000000-0000-4000-8000-000000000001", title: "Synthetic project room", members: [{ user: "synthetic", displayName: "Synthetic person" }, { user: "fixture", displayName: "日本語 🧭" }], state: "idle", activity: "idle", unreadCount: 12, current: true, updatedAt: now }];
function InboxFixture({ values, error = "", compact = false }: { values: Session[]; error?: string; compact?: boolean }) {
  const [selected, select] = useState<ChatId | null>(values.length ? `ai:${values[0]!.id}` : null);
  const [visible, setVisible] = useState(values);
  const [failure, setFailure] = useState(error);
  return <Inbox rows={inboxRows(visible, starts, values.length ? rooms : [])} selectedId={selected} compactSelected={compact} showPlace error={failure} onDismissError={() => setFailure("")} picker={<button type="button" className="chat-picker-trigger" aria-label="Start a synthetic chat" onClick={() => setVisible(current => [...current, session(`new-${current.length}`, { name: "New synthetic thread" })])}>+</button>} onOpen={chat => select(chat.id)} onClose={chat => setVisible(current => current.filter(value => chat.id !== `ai:${value.id}`))} onSearchArchived={query => setFailure(`Synthetic archived search: ${query}`)} />;
}
const directory = [session("launcher", { name: "Review every supported interface state", hasChildren: true }), ...threads.map(value => session(`agent-${value.id}`, { ...value, id: `agent-${value.id}`, foreground: false, parentId: "launcher", taskDescription: "Make supported screen states readable and actionable on every device." })), session("system", { foreground: false, origin: "fleet", state: "running", activity: "responding", name: "Scheduled synthetic watch" }), session("detached", { foreground: false, name: "Independent synthetic task" })];
function agentCase(id: string, state: AgentDirectoryState): UiCase {
  return { id: `agents-${id}`, title: `Agents · ${id}`, component: "AgentsDirectory", contract: "AgentDirectoryState; Session fixtures validated by validateSession", boundary: "finite-variant", render: () => <AgentsDirectory directory={state} onRefresh={noop} onOpen={noop} /> };
}
const needs: NeedsYouItem[] = (["question", "decision", "missing-fact", "person-only-action", "commitment"] as const).map((kind, index) => ({ id: `need-${kind}`, kind, title: kind === "question" ? "**Which delivery window works?**\n\n- Morning · 09:00 UTC\n- Afternoon · 14:00 UTC" : `${kind}: ${long}`, consequence: "The next delivery depends on this choice. No private information is used in this fixture.", deadline: index % 2 ? { at: iso(86400000), timeZone: "Europe/London" } : null, recommendation: "Choose the afternoon window.", nextAction: kind === "commitment" ? "Prepare the synthetic delivery notes." : null, commitmentId: kind === "commitment" ? "synthetic-commitment" : null, location: { threadId: "synthetic-source", questionId: kind === "question" ? "synthetic-question" : null }, dismissal: kind === "question" ? { kind: "question", threadId: "synthetic-source", questionId: "synthetic-question" } : { kind: kind === "commitment" ? "commitment" : "life", id: `need-${kind}`, revision: 1 } }));
function projection(items: NeedsYouItem[], failed = false): NeedsYouProjection {
  return { readAt: iso(0), items, life: failed ? { state: "failed", error: "Synthetic life source unavailable" } : { state: "ready", value: { coverage: [] } }, policy: { state: "ready", value: null }, questions: failed ? { state: "partial", errors: ["Synthetic question owner is offline", unbroken] } : { state: "complete" }, watch: failed ? { state: "failed", error: "Synthetic scheduler unavailable" } : { state: "ready", value: { count: 0, nextDueAt: null, lastActualCheck: null } } };
}
const events: CalendarEvent[] = [
  { id: "event-current", title: "Current review · 日本語 🧭", start: iso(-1800000), end: iso(1800000), zone: "UTC", allDay: false, location: "Synthetic studio", notes: long.repeat(3), updated: iso(0) },
  { id: "event-next", title: long.repeat(3), start: iso(86400000), end: iso(90000000), zone: "Asia/Tokyo", allDay: false, location: unbroken, notes: "Read-only imported event\nSecond line", source: "Synthetic subscription", readOnly: true, updated: iso(0) },
  { id: "event-all-day", title: "All-day planning", start: iso(0).slice(0, 10), end: iso(172800000).slice(0, 10), zone: "UTC", allDay: true, location: "", notes: "", updated: iso(0) },
  { id: "event-series", title: "Weekly synthetic review", start: iso(172800000), end: iso(176400000), zone: "Europe/London", allDay: false, location: "Synthetic room", notes: "Occurrence and series actions have distinct scopes.", repeat: "weekly", repeatUntil: iso(2592000000).slice(0, 10), seriesId: "synthetic-series", occurrenceStart: iso(172800000), updated: iso(0) },
];
const updates: HistoryNotification[] = [
  { seq: 1, sessionId: "synthetic-source", name: "Delivery review", time: iso(-300000), kind: "attention", body: "Synthetic update: the next action is to choose a delivery time.", status: "needs-you" },
  { seq: 2, sessionId: "synthetic-source", name: long, time: iso(-600000), kind: "question", body: "**Which route?**\n\n[Open the synthetic notes](https://example.invalid/synthetic) then choose.", questionId: "other-question", status: "unavailable", error: "Synthetic question owner is offline" },
  { seq: 3, sessionId: "synthetic-source", name: "Past delivery", time: iso(-86400000), kind: "idle", body: "Completed synthetic delivery.", status: "history" },
];
type FixtureMode = "empty" | "populated" | "failed" | "loading" | "partial";
function response(mode: FixtureMode, body: unknown): Response | Promise<Response> {
  switch (mode) {
    case "loading": return new Promise<Response>(() => {});
    case "failed": return Response.json({ error: "Synthetic source offline" }, { status: 503 });
    case "empty": case "populated": case "partial": return Response.json(body);
  }
}
function calendarMatch(url: URL) {
  return url.pathname === "/v1/calendar" && [...url.searchParams.keys()].every(key => key === "from" || key === "to") && ["from", "to"].every(key => { const value = url.searchParams.get(key); return value !== null && Number.isFinite(Date.parse(value)); });
}
function ApiFixture({ mode, children }: { mode: FixtureMode; children: ReactNode }) {
  const populated = mode === "populated" || mode === "partial";
  const snapshot: CalendarSnapshot = { zone: "UTC", events: populated ? events : [], subscriptions: [] };
  configureFixtureTransport([
    { method: "GET", path: "/v1/environments", reply: () => Response.json({ environments: [{ id: "synthetic", name: "Synthetic environment", baseUrl: "" }] }) },
    { method: "GET", path: "/v1/health", reply: () => Response.json({ environmentId: "synthetic" }) },
    { method: "POST", path: "/v1/diagnostics/requests", reply: () => Response.json({ ok: true }) },
    { method: "GET", path: "/v1/needs-you", reply: () => response(mode, projection(populated ? needs : [], mode === "partial")) },
    { method: "GET", path: "/v1/notifications?history=1", reply: () => response(mode, { notifications: populated ? updates : [], before: null }) },
    { method: "GET", match: calendarMatch, reply: () => response(mode, snapshot) },
    { method: "POST", path: "/v1/needs-you/dismiss", reply: () => Response.json({ ok: false, error: "question-failed", message: "Synthetic owner is offline; dismissal was not applied." }, { status: 503 }) },
  ]);
  return children;
}
function NeedsFixture({ busy = false }: { busy?: boolean }) {
  return <section className="attention-screen"><ol className="attention-feed">{needs.map(item => <li key={item.id}><NeedsYouCard item={item} busy={busy} onDismiss={noop} /></li>)}</ol><NeedsYouDetails view={projection([], true)} /></section>;
}
const draft: CalendarDraft = { title: "Synthetic calendar review", start: "2026-10-10T09:00", end: "2026-10-10T10:00", zone: "UTC", allDay: false, location: "Synthetic studio", notes: "Review the valid interface states." };
const editorDrafts: Record<string, CalendarDraft> = {
  new: { ...draft, title: "", location: "", notes: "" },
  timed: { ...draft, id: "synthetic-event" },
  "all-day": { ...draft, id: "synthetic-event", allDay: true, start: "2026-10-10", end: "2026-10-12", title: long },
  occurrence: { ...draft, id: "synthetic-occurrence", scope: "occurrence", repeat: "weekly" },
  series: { ...draft, id: "synthetic-series", scope: "series", repeat: "weekly", repeatUntil: "2027-01-01", title: long.repeat(3), notes: unbroken + "\n" + long.repeat(4), location: unbroken },
};
function SavingEditor({ mode }: { mode: "pending" | "failed" }) {
  return <EventEditor draft={draft} onClose={noop} onSave={() => mode === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("Synthetic calendar owner is offline. The event has not been saved."))} />;
}
export const screenCases: UiCase[] = [
  { id: "inbox-empty", title: "Inbox · empty", component: "Inbox", contract: "InboxRow[] empty, selectedId null", boundary: "content-boundary", render: () => <InboxFixture values={[]} /> },
  { id: "inbox-populated", title: "Inbox · attention / active / quiet / room", component: "Inbox", contract: "Validated person sessions and synthetic room state", boundary: "composition", render: () => <InboxFixture values={threads} /> },
  { id: "inbox-long", title: "Inbox · long Unicode and many rows", component: "Inbox", contract: "Validated sessions; long title, attention summary, model and workspace", boundary: "content-boundary", render: () => <InboxFixture values={Array.from({ length: 24 }, (_, index) => session(`long-${index}`, { name: long.repeat(3) + unbroken, workspaceName: unbroken, attentionSummary: index % 2 ? long.repeat(2) : undefined, idleUnread: index % 2 === 1, model: "synthetic/" + unbroken, environment: index % 2 ? "synthetic-remote" : "synthetic" }))} /> },
  { id: "inbox-compact", title: "Inbox · compact selected", component: "Inbox", contract: "Selected row title-only; other rows retain metadata", boundary: "finite-variant", render: () => <InboxFixture values={threads} compact /> },
  { id: "inbox-error", title: "Inbox · retryable error with retained rows", component: "Inbox", contract: "Owned dismissible error alongside valid retained rows", boundary: "finite-variant", render: () => <InboxFixture values={threads} error={"Synthetic connection unavailable · " + unbroken} /> },
  agentCase("empty", { state: "ready", sessions: [] }),
  agentCase("loading", { state: "loading", sessions: [] }),
  agentCase("refreshing", { state: "loading", sessions: directory }),
  agentCase("failed", { state: "failed", sessions: directory, error: "Synthetic source unavailable · " + unbroken }),
  agentCase("populated", { state: "ready", sessions: directory }),
  agentCase("long", { state: "ready", sessions: [session("long-launcher", { name: unbroken, hasChildren: true }), ...Array.from({ length: 24 }, (_, index) => session(`long-agent-${index}`, { foreground: false, parentId: "long-launcher", name: long.repeat(2), state: "running", activity: "thinking", agentName: long, activityDetail: unbroken, taskDescription: long.repeat(2).slice(0, 240) }))] }),
  ...(["empty", "populated", "failed", "loading", "partial"] as const).map((mode): UiCase => ({ id: `attention-${mode}`, title: `Attention · ${mode}`, component: "AttentionScreen", contract: "NeedsYouProjection + NotificationHistory + CalendarSnapshot isolated synthetic routes", boundary: "composition", render: () => <ApiFixture mode={mode}><AttentionScreen version={1} /></ApiFixture> })),
  ...(["empty", "populated", "failed", "loading"] as const).map((mode): UiCase => ({ id: `calendar-${mode}`, title: `Calendar · ${mode}`, component: "CalendarScreen", contract: "CalendarSnapshot explicit UTC zone; timed/all-day/read-only/repeating fixtures", boundary: "finite-variant", render: () => <ApiFixture mode={mode}><CalendarScreen /></ApiFixture> })),
  { id: "needs-kinds", title: "Needs you · all kinds and source failures", component: "NeedsYouCard / NeedsYouDetails", contract: "NeedsYouItem kind union; deadline set/unset; typed dismissal; failed source coverage", boundary: "finite-variant", render: () => <NeedsFixture /> },
  { id: "needs-busy", title: "Needs you · dismissal pending", component: "NeedsYouCard", contract: "Busy dismissal disables actions without hiding content", boundary: "finite-variant", render: () => <NeedsFixture busy /> },
  ...Object.entries(editorDrafts).map(([kind, value]): UiCase => ({ id: `calendar-editor-${kind}`, title: `Calendar editor · ${kind}`, component: "EventEditor", contract: "CalendarDraft new/timed/all-day/occurrence/series; synthetic modal editor", boundary: "finite-variant", render: () => <EventEditor draft={value} onClose={noop} onSave={async () => {}} /> })),
  ...(["pending", "failed"] as const).map((mode): UiCase => ({ id: `calendar-editor-save-${mode}`, title: `Calendar editor · save ${mode}`, component: "EventEditor", contract: "After Save: owned pending promise or explicit rejected synthetic save; entered draft retained", boundary: "finite-variant", render: () => <SavingEditor mode={mode} /> })),
  ...machineFilesCases,
  ...settingsAuthCases,
];
