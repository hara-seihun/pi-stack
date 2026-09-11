import type { AgentHostStatus, AgentRun, Session } from "./types";
import { activityColor, activityLabel, isActiveAgentRun, isActiveSubagent, subagentRoot } from "./agent-placement";

export function AgentList({ runs, hosts, subagents, sessions, selectedRunId, selectedSessionId, onSelectRun, onSelectThread }: {
  runs: AgentRun[];
  hosts: AgentHostStatus[];
  subagents: Session[];
  sessions: Session[];
  selectedRunId: string | null;
  selectedSessionId: string | null;
  onSelectRun(id: string): void;
  onSelectThread(id: string): void;
}) {
  const active = subagents.filter(isActiveSubagent);
  const roots = new Map(active.map(session => [session.id, subagentRoot(session, sessions)]));
  const parents = [...new Set(roots.values())].sort((a, b) => a.localeCompare(b));
  return <div className="agent-list">
    {parents.map(parentId => {
      const parent = sessions.find(session => session.id === parentId);
      const children = active.filter(session => roots.get(session.id) === parentId);
      return <section key={parentId} aria-label={`Subagents of ${parent?.name || parentId}`}>
        <div className="agent-host"><span>{parent?.name || "Thread subagents"}</span><span>{children.length} active</span></div>
        <button type="button" className="agent-parent" disabled={!parent} title={parentId} onClick={() => onSelectThread(parentId)}>Parent: {parent?.name || parentId}</button>
        {children.map(session => <button key={session.id} type="button" className={`agent-row grouped${!selectedRunId && selectedSessionId === session.id ? " selected" : ""}`} onClick={() => onSelectThread(session.id)} aria-label={`Open transcript: ${session.name}`}>
          <span className="agent-row-title"><span className="agent-row-task">{session.name}</span></span>
          <span className="agent-row-meta" title={session.subagent!.model}>{session.subagent!.model}</span>
          <span className="agent-row-meta" style={{ color: activityColor(session.activity) }}>{activityLabel(session.activity, session.activeTool ?? "")}</span>
          {session.lastError && <span className="agent-row-error">{session.lastError}</span>}
        </button>)}
      </section>;
    })}
    {hosts.map(host => {
      const owned = runs.filter(run => run.host === host.key && isActiveAgentRun(run));
      return <section key={host.key} aria-label={host.name}>
        <div className={`agent-host${host.error ? " failed" : ""}`}><span>{host.name}</span><span>{host.error ? "unreachable" : host.running}</span></div>
        {host.error && <div className="agent-empty">{host.error}</div>}
        {!host.error && !owned.length && <div className="agent-empty">No agents working</div>}
        {owned.map(run => <div key={run.id}>
          {run.parentRunId && <button type="button" className="agent-parent" onClick={() => onSelectRun(run.parentRunId!)}>Parent: {runs.find(parent => parent.id === run.parentRunId)?.taskId || run.parentRunId}</button>}
          <button type="button" className={`agent-row${run.parentRunId ? " grouped" : ""}${selectedRunId === run.id ? " selected" : ""}`} onClick={() => onSelectRun(run.id)} aria-label={`Open transcript: ${run.label} ${run.taskId}`}>
            <span className="agent-row-title"><span className="agent-row-label">{run.label}</span><span className="agent-row-task">{run.taskId}</span></span>
            <span className="agent-row-meta" title={run.model}>{run.model}{run.thinking && ` · ${run.thinking}`}</span>
            <span className="agent-row-meta" style={{ color: activityColor(run.status === "running" ? run.activity : run.status) }}>{activityLabel(run.status === "running" ? run.activity : run.status, run.activeTool ?? "")}</span>
            {run.error && <span className="agent-row-error">{run.error}</span>}
          </button>
        </div>)}
      </section>;
    })}
    {!active.length && !hosts.length && <div className="agent-empty">No agents</div>}
  </div>;
}
