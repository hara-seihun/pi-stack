import type { Session } from "../../types";
import { assertNever } from "../../../../shared/explicit-state";
import { conversationThreads } from "../../thread-state";
import { attentionRank, threadStatus } from "../status/thread-status";

export type AgentFilter = "all" | "active" | "waiting" | "idle";
export interface AgentCounts { total: number; active: number; waiting: number; idle: number }
export interface AgentGroup {
  id: string;
  label: string;
  task: string | null;
  agents: Session[];
  counts: AgentCounts;
}

export function countAgents(agents: Session[]): AgentCounts {
  return agents.reduce((counts, agent) => {
    counts.total++;
    switch (agent.state) {
      case "running": counts.active++; return counts;
      case "waiting": counts.waiting++; return counts;
      case "idle": counts.idle++; return counts;
    }
    return assertNever(agent.state, "Agent directory count");
  }, { total: 0, active: 0, waiting: 0, idle: 0 });
}

export function backgroundAgents(sessions: Session[]): Session[] {
  const foreground = new Set(conversationThreads(sessions).map(agent => agent.id));
  return sessions.filter(agent => !agent.archivedAt && !foreground.has(agent.id));
}

export function mergeAgentDirectory(complete: Session[], live: Session[]): Session[] {
  const agents = new Map(complete.map(agent => [agent.id, agent]));
  for (const agent of live) {
    const held = agents.get(agent.id);
    if (!held || agent.revision >= held.revision) agents.set(agent.id, agent);
  }
  return [...agents.values()];
}

export function groupAgents(sessions: Session[], query: string, filter: AgentFilter): AgentGroup[] {
  const byId = new Map(sessions.map(agent => [agent.id, agent]));
  const groups = new Map<string, AgentGroup>();
  const search = query.trim().toLocaleLowerCase();
  for (const agent of backgroundAgents(sessions)) {
    const launcher = agent.parentId ? byId.get(agent.parentId) : undefined;
    const id = agent.parentId ? `launcher:${agent.parentId}` : agent.watchList || agent.origin === "fleet" ? "system" : "detached";
    const label = agent.parentId ? launcher?.agentName || `Launcher ${agent.parentId.slice(0, 8)}` : id === "system" ? "Scheduled & system" : "No launcher";
    const task = launcher?.name ?? null;
    if (filter === "active" && agent.state !== "running" || filter === "waiting" && agent.state !== "waiting" || filter === "idle" && agent.state !== "idle") continue;
    if (search && ![agent.agentName, agent.name, agent.id, label, task].some(value => value?.toLocaleLowerCase().includes(search))) continue;
    let group = groups.get(id);
    if (!group) { group = { id, label, task, agents: [], counts: { total: 0, active: 0, waiting: 0, idle: 0 } }; groups.set(id, group); }
    group.agents.push(agent);
  }
  for (const group of groups.values()) {
    group.agents.sort((a, b) => attentionRank(threadStatus(a)) - attentionRank(threadStatus(b)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    group.counts = countAgents(group.agents);
  }
  return [...groups.values()].sort((a, b) => Number(b.counts.active + b.counts.waiting > 0) - Number(a.counts.active + a.counts.waiting > 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
