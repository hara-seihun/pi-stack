import { Sheet } from "../../app/Sheet";
import { CopyButton } from "../../chat-message";
import type { QueuedMessage } from "../../types";
import { assertNever } from "../../../../shared/explicit-state";
import "./queue.css";

export type QueueAction = "edit" | "cancel";

export function queueMessageStatus(message: Pick<QueuedMessage, "state" | "acknowledgement">, held: boolean): string {
  switch (message.state) {
    case "dispatched":
      switch (message.acknowledgement) {
        case "unconfirmed": return "Acknowledgement unconfirmed — not resent";
        case "pending": return "Awaiting agent acknowledgement";
        case undefined: return "Sent to agent";
      }
      return assertNever(message.acknowledgement, "Queue acknowledgement");
    case "queued": return held ? "Held until resumed" : "Waiting for the next output boundary";
  }
  return assertNever(message.state, "Queue state");
}

export function QueueSheet({ open, messages, held, pending, onClose, onAction }: {
  open: boolean;
  messages: QueuedMessage[];
  held: boolean;
  pending: boolean;
  onClose(): void;
  onAction(message: QueuedMessage, action: QueueAction): void;
}) {
  return <Sheet open={open} title={!messages.length ? "Queue" : `${messages.length} messages waiting`} onClose={onClose} labelledBy="queue-title">
    {!messages.length && <p className="muted">Nothing is waiting.</p>}
    <ol className="queue-list">{messages.map(message => <li key={message.id} className="queue-item" data-state={message.state}>
      <header className="queue-item-header"><span className="queue-state">{queueMessageStatus(message, held)}</span><CopyButton text={message.text} className="queue-copy" /></header>
      <p className="queue-text">{message.text || "Attached files"}</p>
      {message.state === "queued" && message.canCancel && <div className="queue-actions">
        <button type="button" disabled={pending} onClick={() => onAction(message, "edit")}>Edit</button>
        <button type="button" className="queue-remove" disabled={pending} onClick={() => onAction(message, "cancel")}>Remove</button>
      </div>}
    </li>)}</ol>
  </Sheet>;
}
