import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { activityColor, partitionThreads, threadDrawerTab, subagentRoot, isActiveAgentRun } from "./src/agent-placement";
import { AgentList } from "./src/agent-list";
import type { AgentRun, Session } from "./src/types";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, name: id, cwd: "/home", workspaceName: "Home", environment: "home", state: "IDLE", activity: "IDLE",
  activeTool: null, provider: "openai", createdAt: "", updatedAt: "", revision: 1, idleUnread: false, lastError: null,
  steeringQueued: 0, followUpQueued: 0, queuedMessages: [], archivedAt: null, ...extra,
});
const parent = session("coordinator");
const child = session("worker", { subagent: { parentSessionId: parent.id, model: "gpt-5.6-luna" }, state: "RUNNING", activity: "WAITING_ON_TOOL", activeTool: "bash" });
const host = { key: "local", label: "Local", name: "This machine", running: 1, updatedAt: null, error: null };
const run: AgentRun = {
  id: "local:child", host: "local", hostName: host.name, hostLabel: host.label, runId: "child", taskId: "repair",
  model: "gpt-5.6-sol", label: "Sol", key: "sol", thinking: "high", provider: "openai-codex",
  status: "waiting", activity: "WAITING", activeTool: null, startedAt: "", finishedAt: null,
  observable: true, error: null, parentRunId: "local:parent",
};

function buttons(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
}

describe("subagent placement", () => {
  test("shows an unread idle completion in green", () => {
    expect(activityColor("IDLE", true)).toBe("var(--success)");
    expect(activityColor("IDLE", false)).toBe("var(--muted)");
    expect(activityColor("WORKING", true)).toBe("var(--accent)");
  });

  test("keeps children out of Interactive across lifecycle updates, including nested and meeting workers", () => {
    for (const state of ["QUEUED", "STARTING", "RUNNING", "IDLE", "STOPPED", "FAILED"]) {
      const worker = { ...child, state };
      const nested = session("nested", { subagent: { parentSessionId: child.id, model: "gpt-6-astra" } });
      const meeting = session("meeting", { environment: "personal" });
      const meetingWorker = session("meeting-worker", { environment: "personal", subagent: { parentSessionId: meeting.id, model: "gpt-5.6-terra" } });
      const partition = partitionThreads([worker, parent, nested, meeting, meetingWorker]);
      expect(partition.interactive).toEqual([parent, meeting]);
      expect(partition.subagents).toEqual(["QUEUED", "STARTING", "RUNNING"].includes(state) ? [worker] : []);
      expect(subagentRoot(nested, [parent, child, nested])).toBe(parent.id);
      expect(threadDrawerTab(worker)).toBe("agents");
      expect(threadDrawerTab(parent)).toBe("threads");
    }
  });

  test("terminal fleet children remain readable but do not count as active cards", () => {
    const completed = { ...run, id: "completed", status: "done" };
    expect(isActiveAgentRun(completed)).toBe(false);
    expect(isActiveAgentRun(run)).toBe(true);
    const panel = AgentList({ runs: [run, completed], hosts: [host], subagents: [], sessions: [],
      selectedRunId: completed.id, selectedSessionId: null, onSelectThread() {}, onSelectRun() {} });
    expect(buttons(panel).filter(button => button.props["aria-label"]?.startsWith("Open transcript:"))).toHaveLength(1);
  });

  test("groups active descendants once under the root and excludes settled workers", () => {
    const nested = { ...child, id: "nested", name: "nested", subagent: { ...child.subagent!, parentSessionId: child.id } };
    const settled = { ...child, id: "settled", name: "settled", state: "STOPPED" };
    const panel = AgentList({ runs: [], hosts: [], subagents: [child, nested, settled], sessions: [parent, child, nested, settled],
      selectedRunId: null, selectedSessionId: null, onSelectThread() {}, onSelectRun() {} });
    const html = renderToStaticMarkup(panel);
    expect((html.match(/aria-label="Subagents of/g) ?? []).length).toBe(1);
    expect(html).toContain("2 active");
    expect(html).not.toContain("Open transcript: settled");
    expect(buttons(panel).filter(button => button.props.className === "agent-parent")).toHaveLength(1);
  });

  test("opens Remote transcripts as sessions and fleet transcripts as host-qualified runs", () => {
    const selectedThreads: string[] = [], selectedRuns: string[] = [];
    const panel = AgentList({ runs: [run], hosts: [host], subagents: [child], sessions: [parent, child],
      selectedRunId: null, selectedSessionId: child.id, onSelectThread: id => selectedThreads.push(id), onSelectRun: id => selectedRuns.push(id) });
    const controls = buttons(panel);
    controls.find(button => button.props["aria-label"] === "Open transcript: worker")!.props.onClick();
    controls.find(button => button.props["aria-label"] === "Open transcript: Sol repair")!.props.onClick();
    controls.filter(button => button.props.className === "agent-parent").forEach(button => button.props.onClick());
    expect(selectedThreads).toEqual([child.id, parent.id]);
    expect(selectedRuns).toEqual([run.id, "local:parent"]);
    const html = renderToStaticMarkup(panel);
    expect(html).toContain(child.subagent!.model);
    expect(html).toContain(run.model);
    expect(html).toContain("WAITING ON BASH");
    expect(html).toContain("WAITING");
    expect(html).toContain("agent-row grouped selected");
  });

  test("retains children when their parent is absent or fleet observation fails", () => {
    const panel = AgentList({ runs: [run], hosts: [{ ...host, error: "Host unavailable" }], subagents: [child], sessions: [child],
      selectedRunId: run.id, selectedSessionId: null, onSelectThread() {}, onSelectRun() {} });
    const controls = buttons(panel);
    expect(controls.find(button => button.props.className === "agent-parent")!.props.disabled).toBe(true);
    expect(controls.filter(button => button.props["aria-label"]?.startsWith("Open transcript:"))).toHaveLength(2);
    expect(renderToStaticMarkup(panel)).toContain(parent.id);
  });
});
