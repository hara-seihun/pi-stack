import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "./src/types";
import { backgroundAgents, countAgents, groupAgents, mergeAgentDirectory } from "./src/features/agents/agent-directory";
import { AgentsDirectory } from "./src/features/agents/AgentsScreen";

const session = (id: string, changes: Partial<Session> = {}): Session => ({
  id, agentName: `Name ${id}`, name: `Task ${id}`, parentId: null, hasChildren: false,
  origin: "person", foreground: false, model: "test", provider: "test", cwd: "/fixture", workspaceName: "Home", environment: "test",
  state: "idle", lifecycle: { kind: "idle" }, humanAttention: true, activity: "idle", held: false, activeTools: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  revision: 1, idleUnread: false, queuedMessages: [], archivedAt: null, ...changes,
});
const directory = [
  session("launcher", { foreground: true, agentName: "Renian", name: "Publish release" }),
  session("quiet", { parentId: "launcher" }),
  session("active", { parentId: "launcher", state: "running", lifecycle: { kind: "working", phase: "thinking", since: 1 }, activity: "thinking" }),
  session("waiting", { parentId: "active", state: "waiting", lifecycle: { kind: "waiting", target: "job", since: 1 }, activity: "awaiting", waitingOnAgents: { kind: "job", jobId: "compile", since: 1 } }),
  session("system", { origin: "fleet" }), session("watch", { watchList: true }), session("detached"),
  session("gone-parent", { parentId: "archived-launcher" }), session("closed", { archivedAt: "2026-01-02T00:00:00Z" }),
];

test("complete background directory keeps old idle agents and groups immediate launch provenance without a tree", () => {
  const groups = groupAgents(directory, "", "all");
  expect(backgroundAgents(directory).map(agent => agent.id)).toEqual(["quiet", "active", "waiting", "system", "watch", "detached", "gone-parent"]);
  expect(groups.find(group => group.id === "launcher:launcher")?.agents.map(agent => agent.id)).toEqual(["active", "quiet"]);
  expect(groups.find(group => group.id === "launcher:active")?.agents.map(agent => agent.id)).toEqual(["waiting"]);
  expect(groups.find(group => group.id === "system")?.agents.map(agent => agent.id)).toEqual(["system", "watch"]);
  expect(groups.find(group => group.id === "detached")?.agents.map(agent => agent.id)).toEqual(["detached"]);
  expect(groups.find(group => group.id === "launcher:archived-launcher")?.agents.map(agent => agent.id)).toEqual(["gone-parent"]);
  expect(countAgents(backgroundAgents(directory))).toEqual({ total: 7, active: 1, waiting: 1, idle: 5 });
});

test("search includes launcher name and task; state filters do not hide waiting under idle", () => {
  expect(groupAgents(directory, "Renian", "all").flatMap(group => group.agents.map(agent => agent.id))).toEqual(["active", "quiet"]);
  expect(groupAgents(directory, "Publish release", "idle").flatMap(group => group.agents.map(agent => agent.id))).toEqual(["quiet"]);
  expect(groupAgents(directory, "", "waiting").flatMap(group => group.agents.map(agent => agent.id))).toEqual(["waiting"]);
  expect(groupAgents(directory, "", "active").flatMap(group => group.agents.map(agent => agent.id))).toEqual(["active"]);
});

test("live placement and archive changes remove rows but a sparse stream cannot erase quiet directory members", () => {
  const updated = mergeAgentDirectory(directory, [session("quiet", { foreground: true, revision: 2 }), session("active", { archivedAt: "2026-01-02T00:00:00Z", revision: 2 })]);
  expect(backgroundAgents(updated).map(agent => agent.id)).not.toContain("quiet");
  expect(backgroundAgents(updated).map(agent => agent.id)).not.toContain("active");
  expect(backgroundAgents(updated).map(agent => agent.id)).toContain("detached");
  expect(mergeAgentDirectory(updated, [session("quiet", { revision: 1 })]).find(agent => agent.id === "quiet")?.foreground).toBe(true);
});

test("resource failure keeps a visibly stale usable directory, never a successful empty state", () => {
  const html = renderToStaticMarkup(<AgentsDirectory directory={{ state: "failed", sessions: directory, error: "Owner unavailable" }} onRefresh={() => {}} onOpen={() => {}} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Owner unavailable");
  expect(html).toContain("Task quiet");
  expect(html).toContain('class="agent-group" open=""');
  expect(html).toContain('data-status="waiting"');
  expect(html).toContain("Waiting for job");
  expect(html).not.toContain("No background agents.");
});

test("task purpose and owned activity are readable without agent identity or opening a transcript", () => {
  const agents = [session("unnamed-task", { name: "Publish new release", agentName: undefined,
    state: "waiting", lifecycle: { kind: "waiting", target: "deployment", since: 1 }, activity: "awaiting",
    waitingOnAgents: { kind: "deployment", publicationId: "PUB-test", since: 1 } }),
    session("named-task", { name: "Fix account routing", agentName: "Renian", state: "running", lifecycle: { kind: "working", phase: "waiting_on_tool", since: 1, detail: "Running read" }, activity: "waiting_on_tool", activeTools: ["functions.read"] })];
  const html = renderToStaticMarkup(<AgentsDirectory directory={{ state: "ready", sessions: agents }} onRefresh={() => {}} onOpen={() => {}} />);
  expect(html).toContain("Publish new release");
  expect(html).toContain("Waiting for deployment");
  expect(html).toContain(">Working<");
  expect(html).not.toContain("Unnamed agent");
  expect(html.indexOf("Fix account routing")).toBeLessThan(html.indexOf("Renian"));
  expect(groupAgents(agents, "new release", "all").flatMap(group => group.agents.map(agent => agent.id))).toEqual(["unnamed-task"]);
});
