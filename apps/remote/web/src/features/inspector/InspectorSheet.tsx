import { useEffect, useRef, useState, type ReactNode } from "react";
import { API } from "../../../../server/api";
import type { SessionEvent } from "../../../../server/protocol";
import { api } from "../../client";
import { DismissibleError } from "../../dismissible-error";
import { optimisticThreadSettings, SettingsFields } from "../../thread-settings";
import type { Session, ThreadSettings } from "../../types";
import { Sheet } from "../../app/Sheet";
import { StatusPill } from "../status/StatusPill";
import { threadStatus } from "../status/thread-status";
import { WorkersTree } from "../workers/WorkersTree";
import "./inspector.css";

export type InspectorTab = "thread" | "settings" | "timeline";

function formatTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : value || "—";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="inspector-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function InspectorSheet({ session, sessions, open, pending, onClose, onOpenThread, onArchive, onRestore, debug }: {
  session: Session;
  sessions: Session[];
  open: boolean;
  pending: boolean;
  onClose(): void;
  onOpenThread(session: Session): void;
  onArchive(): void;
  onRestore(): void;
  /** Voice and Meet controls, kept for debugging. */
  debug?: ReactNode;
}) {
  const [tab, setTab] = useState<InspectorTab>("thread");
  const childrenVersion = sessions.filter(child => child.parentId === session.id).map(child => `${child.id}:${child.revision}`).join(",");
  const [settingsSnapshot, setSettingsSnapshot] = useState<{ sessionId: string; value: ThreadSettings } | null>(null);
  const authoritativeSettings = useRef<{ sessionId: string; value: ThreadSettings } | null>(null);
  const settingsRequest = useRef(0);
  const settingsSaving = useRef(false);
  const currentSessionId = useRef(session.id);
  currentSessionId.current = session.id;
  const settings = settingsSnapshot?.sessionId === session.id ? settingsSnapshot.value : null;
  const [children, setChildren] = useState<Session[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [childrenFailure, setChildrenFailure] = useState("");
  const [saving, setSaving] = useState("");
  const [loadFailure, setLoadFailure] = useState("");
  const [saveFailure, setSaveFailure] = useState("");
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [eventsFailure, setEventsFailure] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    settingsRequest.current += 1;
    settingsSaving.current = false;
    authoritativeSettings.current = null;
    setSettingsSnapshot(null);
    setSaving("");
    setLoadFailure("");
    setSaveFailure("");
  }, [session.id]);
  useEffect(() => {
    if (!open || tab !== "settings" || settingsSaving.current) return;
    let active = true;
    const sessionId = session.id;
    const request = ++settingsRequest.current;
    setLoadFailure("");
    api(API.sessionSettings.method, API.sessionSettings.path({ sessionId }))
      .then(result => {
        if (!active || request !== settingsRequest.current || settingsSaving.current || currentSessionId.current !== sessionId) return;
        const snapshot = { sessionId, value: result.settings };
        authoritativeSettings.current = snapshot;
        setSettingsSnapshot(snapshot);
      })
      .catch(error => {
        if (active && request === settingsRequest.current && !settingsSaving.current && currentSessionId.current === sessionId) setLoadFailure(error?.message || String(error));
      });
    return () => { active = false; };
  }, [open, tab, session.id, session.revision, attempt]);
  useEffect(() => {
    if (!open || tab !== "thread") return;
    let active = true;
    setChildrenLoading(true);
    setChildrenFailure("");
    api(API.sessionChildren.method, API.sessionChildren.path({ sessionId: session.id }))
      .then(result => { if (active) setChildren(result.children ?? []); })
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
  const update = async (field: string, body: Record<string, string | number>) => {
    const previous = authoritativeSettings.current;
    if (settingsSaving.current || !previous || previous.sessionId !== session.id) return;
    const sessionId = session.id;
    const request = ++settingsRequest.current;
    settingsSaving.current = true;
    setSaving(field);
    setSaveFailure("");
    setSettingsSnapshot({ sessionId, value: optimisticThreadSettings(previous.value, body) });
    try {
      const result = await api(API.updateSessionSettings.method, API.updateSessionSettings.path({ sessionId }), body);
      if (request !== settingsRequest.current || currentSessionId.current !== sessionId) return;
      const snapshot = { sessionId, value: result.settings };
      authoritativeSettings.current = snapshot;
      setSettingsSnapshot(snapshot);
    } catch (error: any) {
      if (request !== settingsRequest.current || currentSessionId.current !== sessionId) return;
      setSettingsSnapshot(previous);
      setSaveFailure(error?.message || String(error));
      retry(value => value + 1);
    } finally {
      if (request === settingsRequest.current && currentSessionId.current === sessionId) {
        settingsSaving.current = false;
        setSaving("");
      }
    }
  };
  const status = threadStatus(session);
  const parent = session.parentId ? sessions.find(item => item.id === session.parentId) ?? null : null;
  const tabs: { id: InspectorTab; label: string }[] = [{ id: "thread", label: "Thread" }, { id: "settings", label: "Settings" }, { id: "timeline", label: "Timeline" }];
  return <Sheet open={open} title={session.name || "Thread"} onClose={onClose} labelledBy="inspector-title" variant="sidebar">
    <div className="inspector-tabs" role="tablist">{tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    {tab === "thread" && <div className="inspector-panel">
      <div className="inspector-controls">
        {session.archivedAt ? <button type="button" disabled={pending} onClick={onRestore}>Restore</button> : <button type="button" disabled={pending} onClick={onArchive}>Close chat</button>}
      </div>
      <dl className="inspector-facts">
        <Row label="Status"><StatusPill status={status} /></Row>
        <Row label="Model">{session.model}</Row>
        {!session.model.includes("/") && <Row label="Provider">{session.provider}</Row>}
        <Row label="Environment">{session.environment}</Row>
        <Row label="Workspace">{session.workspaceName || "—"}</Row>
        <Row label="Directory"><code>{session.cwd}</code></Row>
        <Row label="Owner">{session.origin === "fleet" ? "Fleet" : "You"}</Row>
        <Row label="Created">{formatTime(session.createdAt)}</Row>
        <Row label="Updated">{formatTime(session.updatedAt)}</Row>
        {session.archivedAt && <Row label="Archived">{formatTime(session.archivedAt)}</Row>}
        <Row label="Thread ID"><code className="inspector-id">{session.id}</code></Row>
      </dl>
      {parent && <section className="inspector-section"><h3>Parent</h3><button type="button" className="inspector-link" onClick={() => onOpenThread(parent)}>{parent.name || parent.id}</button></section>}
      <section className="inspector-section">
        <h3>Workers {childrenLoading && <span className="muted">loading</span>}</h3>
        <DismissibleError message={childrenFailure} resetKey={attempt} />
        {children.length ? <WorkersTree sessions={children} selectedId={null} filter="all" onFilter={() => {}} onOpen={onOpenThread} compact /> : !childrenLoading && !childrenFailure && <p className="muted">No workers spawned by this thread.</p>}
      </section>
      {debug && <section className="inspector-section"><h3>Debug</h3>{debug}</section>}
    </div>}
    {tab === "settings" && <div className="inspector-panel">
      <DismissibleError message={loadFailure} resetKey={attempt} />
      {loadFailure && <button type="button" disabled={Boolean(saving)} onClick={() => retry(value => value + 1)}>Retry loading settings</button>}
      <DismissibleError message={saveFailure} />
      {settings ? <SettingsFields session={session} settings={settings} saving={saving} onUpdate={(field, body) => void update(field, body)} />
        : !loadFailure && <div className="settings-loading" aria-label="Loading thread settings"><span /><span /><span /></div>}
    </div>}
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
