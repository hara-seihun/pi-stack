import { useEffect, useState } from "react";
import { API } from "../../../../server/api";
import type { HistoryNotification, NotificationHistory } from "../../../../server/protocol";
import { api } from "../../client";
import "./notifications.css";

function notificationTime(value: string): string {
  const date = new Date(value);
  const elapsed = Math.max(0, Date.now() - date.getTime());
  if (elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type HistoryState =
  | { state: "loading"; notifications: HistoryNotification[]; before: number | null }
  | { state: "ready"; notifications: HistoryNotification[]; before: number | null }
  | { state: "failed"; notifications: HistoryNotification[]; before: number | null; error: string };

export function NotificationsScreen({ version, onOpen }: { version: number; onOpen(id: string): void }) {
  const [history, setHistory] = useState<HistoryState>({ state: "loading", notifications: [], before: null });
  const [attempt, retry] = useState(0);
  const [tab, setTab] = useState<"needs-you" | "history">("needs-you");
  useEffect(() => {
    const controller = new AbortController();
    setHistory(current => ({ ...current, state: "loading" }));
    void api(API.notifications.method, `${API.notifications.path()}?history=1`).then((value: NotificationHistory) => {
      if (!controller.signal.aborted) setHistory({ ...value, state: "ready" });
    }, error => {
      if (!controller.signal.aborted) setHistory(current => ({ ...current, state: "failed", error: String(error) }));
    });
    return () => controller.abort();
  }, [version, attempt]);
  const earlier = async () => {
    if (!history.before || history.state === "loading") return;
    const before = history.before;
    setHistory({ ...history, state: "loading" });
    try {
      const value: NotificationHistory = await api(API.notifications.method, `${API.notifications.path()}?history=1&before=${before}`);
      setHistory(current => ({ state: "ready", before: value.before, notifications: [...current.notifications, ...value.notifications.filter(item => !current.notifications.some(old => old.seq === item.seq))] }));
    } catch (error) { setHistory(current => ({ ...current, state: "failed", error: String(error) })); }
  };
  const active = history.notifications.filter(item => item.status !== "history");
  const past = history.notifications.filter(item => item.status === "history");
  const items = tab === "needs-you" ? active : past;
  return <section className="notifications-screen" aria-label="Notifications">
    <header className="notifications-header"><div><h1>Notifications</h1><p>Updates from your agents</p></div>
      <button className="notifications-refresh" type="button" aria-label="Refresh notifications" title="Refresh" disabled={history.state === "loading"} onClick={() => retry(value => value + 1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.2 7a7 7 0 0 1 11.5-1L20 9M4 15l2.3 3a7 7 0 0 0 11.5-1" /></svg>
      </button>
    </header>
    <div className="notifications-tabs" role="tablist" aria-label="Notification filter">
      <button type="button" role="tab" id="notifications-needs-you" aria-controls="notifications-list" aria-selected={tab === "needs-you"} onClick={() => setTab("needs-you")}>Needs you{!!active.length && <span>{active.length}</span>}</button>
      <button type="button" role="tab" id="notifications-history" aria-controls="notifications-list" aria-selected={tab === "history"} onClick={() => setTab("history")}>History</button>
    </div>
    {history.state === "loading" && <p className="notifications-resource" role="status">{history.notifications.length ? "Refreshing…" : "Loading notifications…"}</p>}
    {history.state === "failed" && <div className="notifications-error" role="alert"><p>Could not refresh notifications. {history.error}{history.notifications.length > 0 && " Saved notifications are still shown."}</p><button type="button" onClick={() => retry(value => value + 1)}>Retry</button></div>}
    <div id="notifications-list" role="tabpanel" aria-labelledby={`notifications-${tab}`}>
      {history.state === "ready" && !items.length && <div className="notifications-empty"><strong>{tab === "needs-you" ? "You're all caught up" : "No notification history yet"}</strong><p>{tab === "needs-you" ? "Questions and important updates will appear here." : "Earlier updates stay here after you've opened them."}</p></div>}
      <ol className="notification-list">{items.map(item => <li key={item.seq}>
        <button className="notification-row" type="button" onClick={() => onOpen(item.sessionId)}>
          <span className={`notification-symbol ${item.kind}`} aria-hidden="true">{item.kind === "question" ? "?" : <svg viewBox="0 0 24 24"><path d="M12 4v9m0 5v1" /></svg>}</span>
          <span className="notification-content">
            <span className="notification-heading"><strong>{item.name}</strong><time dateTime={item.time} title={new Date(item.time).toLocaleString()}>{notificationTime(item.time)}</time></span>
            <span className="notification-kind">{item.kind === "question" ? "Question" : "Update"}</span>
            {item.body && <span className="notification-preview">{item.body}</span>}
            {item.status === "unavailable" && <span className="notification-unavailable">Status unavailable · {item.error}</span>}
          </span>
          <svg className="notification-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
      </li>)}</ol>
    </div>
    {history.before !== null && <button className="notifications-earlier" type="button" disabled={history.state === "loading"} onClick={() => void earlier()}>Load earlier notifications</button>}
  </section>;
}
