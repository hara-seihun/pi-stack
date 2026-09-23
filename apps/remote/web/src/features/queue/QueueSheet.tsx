import { useState } from "react";
import { Sheet } from "../../app/Sheet";
import { CopyButton } from "../../chat-message";
import type { QueuedMessage } from "../../types";
import { DELIVERY_LABELS, type QueueAction } from "./delivery";
import "./queue.css";

export type { QueueAction };

function deliveryLabel(delivery: string) { return DELIVERY_LABELS[delivery]?.label ?? delivery; }

export function queueMessageStatus(message: Pick<QueuedMessage, "state" | "delivery">, held: boolean): string {
  if (message.state === "dispatched") return "Sent to agent";
  if (held) return "Held until resumed";
  if (message.delivery === "steer") return "Steering after current tool calls";
  if (message.delivery === "hardSteer") return "Interrupting current work";
  return "Queued for after completion";
}

export function QueueSheet({ open, messages, held, pending, onClose, onAction }: {
  open: boolean;
  messages: QueuedMessage[];
  held: boolean;
  pending: boolean;
  onClose(): void;
  onAction(message: QueuedMessage, action: QueueAction): void;
}) {
  const [confirmHard, setConfirmHard] = useState<string | null>(null);
  return <Sheet open={open} title={!messages.length ? "Queue" : messages.length === 1 ? "1 message waiting" : `${messages.length} messages waiting`} onClose={onClose} labelledBy="queue-title">
    {!messages.length && <p className="muted">Nothing is waiting. Messages you send while the agent works appear here.</p>}
    <ol className="queue-list">{messages.map(message => {
      const queued = message.state === "queued";
      const canCancel = queued && message.canCancel;
      const canSteer = queued && !held && message.canSteer;
      const canHardSteer = queued && !held && message.canHardSteer;
      const heldDelivery = held && queued ? deliveryLabel(message.delivery) : "";
      return <li key={message.id} className="queue-item" data-state={message.state}>
        <header className="queue-item-header">
          <span className="queue-state">{queueMessageStatus(message, held)}</span>
          {heldDelivery && <span className="queue-mode">{heldDelivery}</span>}
          <CopyButton text={message.text} className="queue-copy" />
        </header>
        <p className="queue-text">{message.text || "Attached files"}</p>
        <div className="queue-actions">
          {canCancel && <button type="button" disabled={pending} onClick={() => onAction(message, "edit")}>Edit</button>}
          {canSteer && <button type="button" disabled={pending} title={DELIVERY_LABELS.steer.detail} onClick={() => onAction(message, "steer")}>Make it steer</button>}
          {canHardSteer && (confirmHard === message.id
            ? <button type="button" className="queue-danger" disabled={pending} onClick={() => { setConfirmHard(null); onAction(message, "hardSteer"); }}>Stop current work and send now</button>
            : <button type="button" className="queue-danger-outline" disabled={pending} title={DELIVERY_LABELS.hardSteer.detail} onClick={() => setConfirmHard(message.id)}>Hard steer…</button>)}
          {canCancel && <button type="button" className="queue-remove" disabled={pending} onClick={() => onAction(message, "cancel")}>Remove</button>}
        </div>
      </li>;
    })}</ol>
  </Sheet>;
}
