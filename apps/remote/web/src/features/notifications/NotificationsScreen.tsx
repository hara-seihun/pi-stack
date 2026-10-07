import { useEffect, useState } from "react";
import { API } from "../../../../server/api";
import type { HistoryNotification, NotificationHistory } from "../../../../server/protocol";
import { api } from "../../client";
import "./notifications.css";

type HistoryState =
  | { state: "loading"; notifications: HistoryNotification[]; before: number | null }
  | { state: "ready"; notifications: HistoryNotification[]; before: number | null }
  | { state: "failed"; notifications: HistoryNotification[]; before: number | null; error: string };

export function NotificationsScreen({ version, onOpen }: { version: number; onOpen(id: string): void }) {
  const [history, setHistory] = useState<HistoryState>({ state: "loading", notifications: [], before: null });
  const [attempt, retry] = useState(0);
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
  const rows = (items: HistoryNotification[]) => <ol>{items.map(item => <li key={item.seq}><button type="button" onClick={() => onOpen(item.sessionId)}>
    <span className="notification-heading"><strong>{item.name}</strong><span>{item.kind === "question" ? "Question" : "Attention"}</span></span>
    {item.body && <p>{item.body}</p>}{item.status === "unavailable" && <p className="muted">Current status unavailable: {item.error}</p>}<time dateTime={item.time}>{new Date(item.time).toLocaleString()}</time>
  </button></li>)}</ol>;
  const active = history.notifications.filter(item => item.status !== "history");
  const past = history.notifications.filter(item => item.status === "history");
  return <section className="notifications-screen" aria-label="Notifications">
    <header><h1>Notifications</h1><button type="button" onClick={() => retry(value => value + 1)}>Refresh</button></header>
    <p className="muted">Questions and attention from your agents. Opening an agent brings it into Chats.</p>
    {history.state === "loading" && <p role="status">Loading notifications…{history.notifications.length > 0 && " Showing saved history."}</p>}
    {history.state === "failed" && <div role="alert"><p>Could not load notifications: {history.error}{history.notifications.length > 0 && " Showing saved history."}</p><button type="button" onClick={() => retry(value => value + 1)}>Retry</button></div>}
    {history.state === "ready" && !history.notifications.length && <p>No questions or attention yet.</p>}
    {!!active.length && <section aria-label="Needs you"><h2>Needs you</h2>{rows(active)}</section>}
    {!!past.length && <section aria-label="Notification history"><h2>History</h2>{rows(past)}</section>}
    {history.before && <button type="button" disabled={history.state === "loading"} onClick={() => void earlier()}>Earlier notifications</button>}
  </section>;
}
