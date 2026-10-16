import type { HistoryNotification } from "../../../../server/protocol";
import { formatRoute } from "../../app/routes";
import { QuestionText } from "../conversation/question-content";
import "./notifications.css";

export function NotificationCard({ item }: { item: HistoryNotification }) {
  const href = formatRoute({ tab: "chats", chat: `ai:${item.sessionId}`, panel: null, ...(item.questionId === undefined ? {} : { questionId: item.questionId }) });
  const metadata = <span className="attention-card-meta"><span>{item.name}</span><time dateTime={item.time} title={new Date(item.time).toLocaleString()}>{new Date(item.time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></span>;
  const unavailable = item.status === "unavailable" && <span className="notification-unavailable">Status unavailable · {item.error}</span>;
  if (item.kind === "question") return <article className="attention-notification">
    <div className="notification-row"><div className="notification-content">
      {metadata}
      {item.body && <QuestionText source={item.body} className="question-prompt" />}
      {unavailable}
      <a className="needs-you-open" href={href} aria-label="Open question in original conversation">{item.status === "needs-you" ? "Answer" : "Open conversation"}</a>
    </div></div>
  </article>;
  return <article className="attention-notification">
    <a className="notification-row" href={href}>
      <span className="notification-content">
        {metadata}
        {item.body && <span className="notification-preview">{item.body}</span>}
        {unavailable}
      </span>
      <span aria-hidden="true">›</span>
    </a>
  </article>;
}
