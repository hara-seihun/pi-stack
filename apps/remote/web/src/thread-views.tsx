import type { Session } from "./types";
import { activityColor, activityLabel, activeThread, orchestratorThreads } from "./thread-state";

function ThreadViewRow({ session, selected, onOpen }: { session: Session; selected: boolean; onOpen(session: Session): void }) {
  const status = activityLabel(session.activity, session.activeTool ?? "");
  const kind = session.origin === "fleet" && !session.parentId ? "Fleet" : "Child";
  return <button type="button" className={`thread-view-row${selected ? " selected" : ""}`} aria-label={`Open thread: ${session.name}`} onClick={() => onOpen(session)}>
    <span className="thread-view-title"><span>{session.name || "Agent"}</span><span className="thread-view-kind">{kind}</span></span>
    <span className="thread-view-meta"><span style={{ color: activityColor(session.activity, session.idleUnread) }}>{status}</span>{session.archivedAt && <span>Archived</span>}{session.model && <span>{session.model}</span>}</span>
    {session.lastError && <span className="thread-view-error">{session.lastError}</span>}
  </button>;
}

export function ThreadViewSections({ sessions, selectedId, onOpen, empty = "No child or fleet threads", inactiveLabel = "Inactive threads" }: { sessions: Session[]; selectedId: string | null; onOpen(session: Session): void; empty?: string; inactiveLabel?: string }) {
  const active = sessions.filter(activeThread);
  const inactive = sessions.filter(session => !activeThread(session));
  if (!sessions.length) return <div className="thread-empty">{empty}</div>;
  return <>
    <div className="thread-view-list" aria-label="Active children and fleet threads">
      {active.length ? active.map(session => <ThreadViewRow key={session.id} session={session} selected={session.id === selectedId} onOpen={onOpen} />) : <div className="thread-empty">No active threads</div>}
    </div>
    {inactive.length > 0 && <details className="inactive-threads"><summary>{inactiveLabel} <span>{inactive.length}</span></summary><div className="thread-view-list">{inactive.map(session => <ThreadViewRow key={session.id} session={session} selected={session.id === selectedId} onOpen={onOpen} />)}</div></details>}
  </>;
}

export function OrchestratorThreadList({ sessions, selectedId, onOpen }: { sessions: Session[]; selectedId: string | null; onOpen(session: Session): void }) {
  return <div className="orchestrator-list"><ThreadViewSections sessions={orchestratorThreads(sessions)} selectedId={selectedId} onOpen={onOpen} /></div>;
}

export function ChildThreadList({ children, loading, error, onOpen }: { children: Session[]; loading: boolean; error: string; onOpen(session: Session): void }) {
  return <section className="setting-card child-thread-card">
    <div className="setting-heading"><div><h3>Children</h3><p>Direct children of this thread</p></div>{loading && <span className="setting-saving">Loading</span>}</div>
    {error && <p className="setting-unavailable" role="alert">{error}</p>}
    <ThreadViewSections sessions={children} selectedId={null} onOpen={onOpen} empty={loading || error ? "" : "No children"} inactiveLabel="Inactive children" />
  </section>;
}
