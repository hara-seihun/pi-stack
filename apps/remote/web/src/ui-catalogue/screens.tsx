import { useState } from "react";
import type { Session, ThreadStart } from "../../../server/protocol";
import { validateSession } from "../../../shared/state-validation";
import type { Room } from "../../../shared/rooms";
import { Inbox } from "../features/chats/Inbox";
import { AgentsDirectory, type AgentDirectoryState } from "../features/agents/AgentsScreen";
import { inboxRows, type ChatId } from "../chats";
import type { UiCase } from "./contract";
import { machineFilesCases } from "./machine-files";
import { settingsAuthCases } from "./settings-auth";
import "../chat-picker-trigger.css";

const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();
const long = "Review the deployment · 日本語 Ελληνικά العربية 🧭 ".repeat(6);
const noop = () => {};
const starts: ThreadStart[] = [{ id: "synthetic", label: "Synthetic home", icon: "cloud", models: [{ id: "openai/gpt-6.1-sol", label: "Sol", icon: "openai" }] }];
function session(id: string, changes: Partial<Session> = {}): Session {
  const value: Session = { id, name: `Task ${id}`, parentId: null, hasChildren: false, origin: "person", foreground: true, model: "openai/gpt-6.1-sol", provider: "openai", cwd: "/synthetic", workspaceName: "Home", environment: "synthetic", state: "idle", lifecycle: { kind: "idle" }, activity: "idle", held: false, activeTools: [], createdAt: iso(-86400000), updatedAt: iso(-300000), revision: 1, idleUnread: false, queuedMessages: [], archivedAt: null, ...changes };
  validateSession(value);
  return value;
}
const threads = [
  session("decision", { name: "Choose a delivery window", idleUnread: true, attentionSummary: "Choose before 17:00 UTC." }),
  session("thinking", { name: "Review interface states", state: "running", lifecycle: { kind: "working", phase: "thinking", since: now - 45000 }, activity: "thinking", activitySince: now - 45000, lastActivityAt: now - 20000 }),
  session("waiting", { name: "Wait for delivery receipt", state: "waiting", lifecycle: { kind: "waiting", target: "job", since: now - 60000 }, activity: "awaiting", waitingOnAgents: { kind: "job", jobId: "synthetic-job", since: now - 60000 } }),
  session("quiet", { name: "Finished notes" }),
  session("error", { name: "Transport needs retry", lifecycle: { kind: "failed", reason: "Synthetic connection is offline", control: "none" }, executionError: "Synthetic connection is offline" }),
];
const rooms: Room[] = [{ id: "00000000-0000-4000-8000-000000000001", title: "Synthetic project room", members: [{ user: "synthetic", displayName: "Synthetic person" }, { user: "fixture", displayName: "日本語 🧭" }], state: "idle", lifecycle: { kind: "idle" }, activity: "idle", unreadCount: 12, current: true, updatedAt: now }];
function InboxFixture({ values, error = "", compact = false }: { values: Session[]; error?: string; compact?: boolean }) {
  const [selected, select] = useState<ChatId | null>(values.length ? `ai:${values[0]!.id}` : null);
  const [visible, setVisible] = useState(values);
  const [failure, setFailure] = useState(error);
  return <Inbox rows={inboxRows(visible, starts, values.length ? rooms : [])} selectedId={selected} compactSelected={compact} showPlace error={failure} onDismissError={() => setFailure("")} picker={<button type="button" className="chat-picker-trigger" aria-label="Start a synthetic chat" onClick={() => setVisible(current => [...current, session(`new-${current.length}`)])}>+</button>} onOpen={chat => select(chat.id)} onClose={chat => setVisible(current => current.filter(value => chat.id !== `ai:${value.id}`))} onSearchArchived={query => setFailure(`Synthetic search: ${query}`)} />;
}
const directory = [session("launcher", { name: "Review interface states", hasChildren: true }), ...threads.map(value => session(`agent-${value.id}`, { ...value, id: `agent-${value.id}`, foreground: false, parentId: "launcher" }))];
function agentCase(id: string, state: AgentDirectoryState): UiCase {
  return { id: `agents-${id}`, title: `Agents · ${id}`, component: "AgentsDirectory", contract: "Validated Session directory", boundary: "finite-variant", render: () => <AgentsDirectory directory={state} onRefresh={noop} onOpen={noop} /> };
}
export const screenCases: UiCase[] = [
  { id: "inbox-empty", title: "Inbox · empty", component: "Inbox", contract: "Empty rows", boundary: "content-boundary", render: () => <InboxFixture values={[]} /> },
  { id: "inbox-populated", title: "Inbox · active / quiet / room", component: "Inbox", contract: "Validated threads and room", boundary: "composition", render: () => <InboxFixture values={threads} /> },
  { id: "inbox-long", title: "Inbox · long Unicode", component: "Inbox", contract: "Many long titles", boundary: "content-boundary", render: () => <InboxFixture values={Array.from({ length: 24 }, (_, index) => session(`long-${index}`, { name: long }))} /> },
  { id: "inbox-compact", title: "Inbox · compact", component: "Inbox", contract: "Title-only selected row", boundary: "finite-variant", render: () => <InboxFixture values={threads} compact /> },
  { id: "inbox-error", title: "Inbox · retained rows / error", component: "Inbox", contract: "Visible owned error", boundary: "finite-variant", render: () => <InboxFixture values={threads} error="Synthetic connection unavailable" /> },
  agentCase("empty", { state: "ready", sessions: [] }),
  agentCase("loading", { state: "loading", sessions: [] }),
  agentCase("failed", { state: "failed", sessions: directory, error: "Synthetic source unavailable" }),
  agentCase("populated", { state: "ready", sessions: directory }),
  ...machineFilesCases,
  ...settingsAuthCases,
];
