import { useEffect, useState, type ReactNode } from "react";
import { API } from "../../../../server/api";
import type { SessionEvent } from "../../../../server/protocol";
import { api } from "../../client";
import { DismissibleError } from "../../dismissible-error";
import type { Session } from "../../types";
import { Sheet } from "../../app/Sheet";
import { StatusPill } from "../status/StatusPill";
import { StatusIcon } from "../status/StatusIcon";
import { agentName } from "../../agent-name";
import { threadStatus } from "../status/thread-status";
import "./inspector.css";
import { assertNever } from "../../../../shared/explicit-state";
import { validateSession, stateArray } from "../../../../shared/state-validation";

export type InspectorTab = "thread" | "settings" | "timeline";

function formatTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : value || "—";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="inspector-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function WaitReference({ wait, sessions, onOpen }: { wait: NonNullable<Session["waitingOnAgents"]>; sessions: Session[]; onOpen(id: string): void }) {
  if (!Object.hasOwn(wait, "kind")) return <Row label="Wait error">Wait type missing</Row>;
  switch (wait.kind) {
    case "agents": return <Row label="Waiting for">{wait.threadIds.map(id => <button className="inspector-link" type="button" key={id} onClick={() => onOpen(id)}>{sessions.find(item => item.id === id)?.name ?? id}</button>)}</Row>;
    case "job": return <Row label="Job"><code>{wait.jobId}</code></Row>;
    case "deployment": return <Row label="Publication"><code>{wait.publicationId}</code></Row>;
    case "message": return <Row label="Message from"><button className="inspector-link" type="button" onClick={() => onOpen(wait.fromThreadId)}>{sessions.find(item => item.id === wait.fromThreadId)?.name ?? wait.fromThreadId}</button></Row>;
  }
  return assertNever(wait, "Inspector dependency");
}

export function InspectorSheet({ session, sessions, open, pending, onClose, onOpenSettings, onOpenThread, onOpenThreadId, onArchive, onRestore, onBackground, debug }: {
  session: Session;
  sessions: Session[];
  open: boolean;
  pending: boolean;
  onClose(): void;
  onOpenSettings(): void;
  onOpenThread(session: Session): void;
  onOpenThreadId(id: string): void;
  onArchive(): void;
  onRestore(): void;
  onBackground?(): void;
  /** Voice and Meet controls, kept for debugging. */
  debug?: ReactNode;
}) {
  const [tab, setTab] = useState<InspectorTab>("thread");
  const childrenVersion = sessions.filter(child => child.parentId === session.id).map(child => `${child.id}:${child.revision}`).join(",");
  const [children, setChildren] = useState<Session[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [childrenFailure, setChildrenFailure] = useState("");
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [eventsFailure, setEventsFailure] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!open || tab !== "thread") return;
    let active = true;
    setChildrenLoading(true);
    setChildrenFailure("");
    api(API.sessionChildren.method, API.sessionChildren.path({ sessionId: session.id }))
      .then(result => {
        if (!active) return;
        stateArray(result.children, "Child directory").forEach(validateSession);
        setChildren(result.children);
      })
      .catch(error => { if (active) setChildrenFailure(error?.message || String(error)); })
      .finally(() => { if (active) setChildrenLoading(false); });
    return () => { active = false; };
  }, [open, tab, session.id, childrenVersion, attempt]);
  useEffect(() => {
    if (!open || tab !== "timeline") return;
    let active = true;
    setEventsFailure("");
    api(API.sessionEvents.method, API.sessionEvents.path({ sessionId: session.id }, { limit: 200 }))
      .then(result => { if (active) setEvents(Array.isArray(result?.events) ? result.events : []); })
      .catch(error => { if (active) setEventsFailure(error?.message || String(error)); });
    return () => { active = false; };
  }, [open, tab, session.id, session.revision, attempt]);
  const status = threadStatus(session);
  const name = agentName(session);
  const parent = session.parentId ? sessions.find(item => item.id === session.parentId) ?? null : null;
  const tabs: { id: InspectorTab; label: string }[] = [{ id: "thread", label: "Thread" }, { id: "settings", label: "Settings" }, { id: "timeline", label: "Timeline" }];
  return <Sheet open={open} title={session.name || "Thread"} onClose={onClose} labelledBy="inspector-title" variant="sidebar">
    <div className="inspector-tabs" role="tablist">{tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {tab === "thread" && <div className="inspector-panel">
      {!session.manager && <div className="inspector-controls">
        {session.archivedAt ? <button type="button" disabled={pending} onClick={onRestore}>Restore</button> : <button type="button" disabled={pending} onClick={onArchive}>Close agent</button>}
        {!session.archivedAt && session.foreground && onBackground && <button type="button" disabled={pending} onClick={onBackground}>Move to background</button>}
      </div>}
      <dl className="inspector-facts">
        <Row label="Activity"><StatusPill status={status} /></Row>
        {!session.manager && !session.archivedAt && <Row label="Close">{pending ? "Unavailable while an action is finishing" : "Available"}</Row>}
        {session.state === "running" && <>
          {status.title && <Row label="Phase evidence">{status.title}</Row>}
          <Row label="Phase started">{session.activitySince ? formatTime(new Date(session.activitySince).toISOString()) : "Not reported"}</Row>
          <Row label="Last activity">{session.lastActivityAt ? formatTime(new Date(session.lastActivityAt).toISOString()) : "Not reported"}</Row>
        </>}
        {status.key === "waiting" && <>
          {status.title && <Row label="Reason">{status.title}</Row>}
          {session.waitingOnAgents ? <WaitReference wait={session.waitingOnAgents} sessions={sessions} onOpen={onOpenThreadId} />
            : !!session.dependencies?.length && <Row label="Waiting for">{session.dependencies.map(id => <button type="button" className="inspector-link" key={id} onClick={() => onOpenThreadId(id)}>{sessions.find(item => item.id === id)?.name ?? id}</button>)}</Row>}
        </>}
        {session.wakeSchedule && <>
          <Row label="Wake check">{session.wakeSchedule.reason}</Row>
          <Row label="Check interval">{session.wakeSchedule.cadenceMs / 60000} minutes</Row>
          <Row label="Next check">{formatTime(new Date(session.wakeSchedule.nextDueAt).toISOString())}</Row>
        </>}
        <Row label="Model">{session.model}</Row>
        {!session.model.includes("/") && <Row label="Provider">{session.provider}</Row>}
        <Row label="Environment">{session.environment}</Row>
        <Row label="Workspace">{session.workspaceName || "—"}</Row>
        <Row label="Directory"><code>{session.cwd}</code></Row>
        <Row label="Placement">{session.foreground ? "Foreground" : "Background"}</Row>
        {name && <Row label="Agent">{name}</Row>}
        <Row label="Task">{session.name}</Row>
        <Row label="Created">{formatTime(session.createdAt)}</Row>
        <Row label="Updated">{formatTime(session.updatedAt)}</Row>
        {session.archivedAt && <Row label="Archived">{formatTime(session.archivedAt)}</Row>}
        <Row label="Thread ID"><code className="inspector-id">{session.id}</code></Row>
      </dl>
      {parent && <section className="inspector-section"><h3>Launched by</h3><button type="button" className="inspector-link" onClick={() => onOpenThread(parent)}>{agentName(parent) && <strong>{agentName(parent)} </strong>}{parent.name || parent.id}</button></section>}
      <section className="inspector-section">
        <h3>Agents launched {childrenLoading && <span className="muted">loading</span>}</h3>
        <DismissibleError message={childrenFailure} resetKey={attempt} />
        {children.length ? <ul className="launched-agents">{children.map(child => <li key={child.id}><button type="button" className="inspector-link launched-agent" onClick={() => onOpenThread(child)}><StatusIcon status={threadStatus(child)} /><span className="launched-agent-text">{agentName(child) && <strong>{agentName(child)}</strong>} <span>{child.name}</span> <span className="muted">{child.foreground ? "Foreground" : "Background"}{child.archivedAt ? " · Archived" : ""}</span></span></button></li>)}</ul> : !childrenLoading && !childrenFailure && <p className="muted">No agents launched.</p>}
      </section>
      {debug && <section className="inspector-section"><h3>Debug</h3>{debug}</section>}
    </div>}
    {tab === "settings" && <div className="inspector-panel"><button type="button" onClick={onOpenSettings}>Open Settings</button><p>Model, execution and display choices live in the central Settings area.</p></div>}
    {tab === "timeline" && <div className="inspector-panel">
      <p className="muted inspector-hint">Execution events recorded by the supervisor. This is operational metadata, not part of what the agent sees.</p>
      <DismissibleError message={eventsFailure} resetKey={attempt} />
      {eventsFailure && <button type="button" onClick={() => retry(value => value + 1)}>Retry</button>}
      {events && !events.length && <p className="muted">No events recorded yet.</p>}
      {events && events.length > 0 && <ol className="inspector-timeline">{[...events].reverse().map(event => {
        const { seq, time, type, ...rest } = event;
        const detail = Object.entries(rest).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ");
        return <li key={seq}><time>{formatTime(time)}</time><strong>{type}</strong>{detail && <span>{detail}</span>}</li>;
      })}</ol>}
    </div>}
  </Sheet>;
}
