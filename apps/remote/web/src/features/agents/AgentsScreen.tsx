import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API } from "../../../../server/api";
import { validateSession } from "../../../../shared/state-validation";
import { api } from "../../client";
import type { Session } from "../../types";
import { StatusPill } from "../status/StatusPill";
import { threadStatus } from "../status/thread-status";
import { backgroundAgents, countAgents, groupAgents, mergeAgentDirectory, type AgentFilter, type AgentGroup } from "./agent-directory";
import "./agents.css";

export type AgentDirectoryState =
  | { state: "loading"; sessions: Session[] }
  | { state: "ready"; sessions: Session[] }
  | { state: "failed"; sessions: Session[]; error: string };

function useAgentDirectory(): [AgentDirectoryState, () => void] {
  const [directory, setDirectory] = useState<AgentDirectoryState>({ state: "loading", sessions: [] });
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const requested = ++generation.current;
    setDirectory(current => ({ state: "loading", sessions: current.sessions }));
    void api(API.sessions.method, `${API.sessions.path()}?allAgents=1`).then((result: { sessions: Session[] }) => {
      if (!Array.isArray(result.sessions)) throw new Error("Agent directory did not return a session list");
      result.sessions.forEach(validateSession);
      if (requested === generation.current) setDirectory({ state: "ready", sessions: result.sessions });
    }).catch(cause => {
      if (requested === generation.current) setDirectory(current => ({ state: "failed", sessions: current.sessions, error: cause instanceof Error ? cause.message : String(cause) }));
    });
  }, []);
  useEffect(() => {
    refresh();
    const returned = () => { if (!document.hidden) refresh(); };
    const interval = window.setInterval(returned, 30_000);
    document.addEventListener("visibilitychange", returned);
    window.addEventListener("online", returned);
    return () => {
      generation.current++;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", returned);
      window.removeEventListener("online", returned);
    };
  }, [refresh]);
  return [directory, refresh];
}

function AgentGroupView({ group, expanded, onToggle, onOpen }: { group: AgentGroup; expanded: boolean; onToggle(open: boolean): void; onOpen(id: string): void }) {
  const { counts } = group;
  const summary = [counts.active > 0 && `${counts.active} active`, counts.waiting > 0 && `${counts.waiting} waiting`, counts.idle > 0 && `${counts.idle} idle`].filter(Boolean).join(" · ");
  return <details className="agent-group" open={expanded} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary>
      <span className="agent-group-chevron" aria-hidden="true">›</span>
      <span className="agent-group-heading"><span className="agent-group-name">{group.label}</span>{group.task && <span className="agent-group-task">{group.task}</span>}<span className="agent-group-counts">{summary}</span></span>
      <span className="agent-group-total" aria-label={`${counts.total} agents`}>{counts.total}</span>
    </summary>
    <ul className="agent-group-list">{group.agents.map(agent => <li key={agent.id}>
      <button className="agent-open" type="button" onClick={() => onOpen(agent.id)} title="Open original agent in Chats">
        <span className="agent-row-name">{agent.agentName || "Unnamed agent"}</span>
        <span className="agent-row-task">{agent.name}</span>
        <span className="agent-row-status"><StatusPill status={threadStatus(agent)} compact />{agent.attentionSummary && <span className="agent-row-attention">{agent.attentionSummary}</span>}</span>
      </button>
    </li>)}</ul>
  </details>;
}

export function AgentsDirectory({ directory, onRefresh, onOpen }: { directory: AgentDirectoryState; onRefresh(): void; onOpen(id: string): void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [expanded, setExpanded] = useState<Map<string, boolean>>(() => new Map());
  const counts = useMemo(() => countAgents(backgroundAgents(directory.sessions)), [directory.sessions]);
  const groups = useMemo(() => groupAgents(directory.sessions, query, filter), [directory.sessions, query, filter]);
  const filters: Array<{ key: AgentFilter; label: string; count: number }> = [
    { key: "all", label: "All", count: counts.total }, { key: "active", label: "Active", count: counts.active },
    { key: "waiting", label: "Waiting", count: counts.waiting }, { key: "idle", label: "Idle", count: counts.idle },
  ];
  return <section className="agents-screen" aria-label="Background agents">
    <header className="agents-header"><div><h1>Agents</h1><p>Background agents, grouped by launcher</p></div><button className="agents-refresh" type="button" disabled={directory.state === "loading"} onClick={onRefresh} aria-label="Refresh agent directory" title="Refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></svg></button></header>
    <div className="agents-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><input type="search" aria-label="Search background agents" placeholder="Search names, tasks or launchers" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="agents-filters" role="group" aria-label="Agent status">{filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label} <span>{item.count}</span></button>)}</div>
    {directory.state === "loading" && <p className="agents-notice" role="status">{directory.sessions.length ? "Refreshing…" : "Loading agents…"}</p>}
    {directory.state === "failed" && <div className="agents-notice agents-error" role="alert"><p>Could not refresh agents: {directory.error}{directory.sessions.length > 0 && " Showing the last directory."}</p><button type="button" onClick={onRefresh}>Retry</button></div>}
    <div className="agents-groups">{groups.map(group => <AgentGroupView key={group.id} group={group} expanded={expanded.get(group.id) ?? (group.counts.active + group.counts.waiting > 0 || !!query || filter !== "all")} onToggle={open => setExpanded(current => current.get(group.id) === open ? current : new Map(current).set(group.id, open))} onOpen={onOpen} />)}
      {directory.state === "ready" && !groups.length && <p className="agents-empty">{counts.total ? "No agents match this search or status." : "No background agents. Open chats are in Chats."}</p>}
    </div>
  </section>;
}

export function AgentsScreen({ liveSessions, fleet, onOpen }: { liveSessions: Session[]; fleet: Session[]; onOpen(id: string): void }) {
  const [directory, refresh] = useAgentDirectory();
  const sessions = useMemo(() => mergeAgentDirectory(directory.sessions, [...liveSessions, ...fleet]), [directory.sessions, liveSessions, fleet]);
  return <AgentsDirectory directory={{ ...directory, sessions }} onRefresh={refresh} onOpen={onOpen} />;
}
