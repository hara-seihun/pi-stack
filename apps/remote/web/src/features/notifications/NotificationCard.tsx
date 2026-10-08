import type { HistoryNotification } from "../../../../server/protocol";
import { formatRoute } from "../../app/routes";
import "./notifications.css";

export function NotificationCard({ item }: { item: HistoryNotification }) {
  return <article className="attention-notification">
    <a className="notification-row" href={formatRoute({ tab: "chats", chat: `ai:${item.sessionId}`, panel: null, ...(item.questionId === undefined ? {} : { questionId: item.questionId }) })}>
      <span className={`notification-symbol ${item.kind}`} aria-hidden="true">{item.kind === "question" ? "?" : "!"}</span>
      <span className="notification-content">
        <span className="notification-heading"><strong>{item.name}</strong><time dateTime={item.time} title={new Date(item.time).toLocaleString()}>{new Date(item.time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></span>
        <span className="notification-kind">{item.kind === "question" ? "Question" : "Update"}</span>
        {item.body && <span className="notification-preview">{item.body}</span>}
        {item.status === "unavailable" && <span className="notification-unavailable">Status unavailable · {item.error}</span>}
      </span>
      <span aria-hidden="true">›</span>
    </a>
  </article>;
}
