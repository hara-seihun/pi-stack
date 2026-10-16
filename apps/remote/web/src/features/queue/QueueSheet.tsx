import { useState } from "react";
import { Sheet } from "../../app/Sheet";
import { CopyButton } from "../../chat-message";
import type { QueuedMessage } from "../../types";
import { DELIVERY_LABELS, type QueueAction } from "./delivery";
import "./queue.css";
import { assertNever, requireState } from "../../../../shared/explicit-state";

export type { QueueAction };

function deliveryLabel(delivery: string) { return DELIVERY_LABELS[requireState(delivery, { queue: true, steer: true, hardSteer: true }, "Queue delivery")]!.label; }

export function queueMessageStatus(message: Pick<QueuedMessage, "state" | "delivery" | "acknowledgement">, held: boolean): string {
  const delivery = requireState(message.delivery, { queue: true, steer: true, hardSteer: true }, "Queue delivery");
  switch (message.state) {
    case "dispatched":
      switch (message.acknowledgement) {
        case "unconfirmed": return "Acknowledgement unconfirmed — not resent";
        case "pending": return "Awaiting agent acknowledgement";
        case undefined: return "Sent to agent";
      }
      return assertNever(message.acknowledgement, "Queue acknowledgement");
    case "queued":
      if (held) return "Held until resumed";
      switch (delivery) {
        case "steer": return "Steering after current tool calls";
        case "hardSteer": return "Interrupting current work";
        case "queue": return "Queued for after completion";
      }
      return assertNever(delivery, "Queue delivery");
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
