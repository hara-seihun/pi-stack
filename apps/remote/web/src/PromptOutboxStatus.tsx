import type { PromptOutboxEntry } from "./prompt-outbox";
import "./prompt-outbox-status.css";

export function PromptOutboxStatus({ entries, busyRequestId, onRetry, onDiscard }: {
  entries: readonly PromptOutboxEntry[];
  busyRequestId: string | null;
  onRetry: (requestId: string) => void;
  onDiscard: (requestId: string) => void;
}) {
  const visible = entries.filter(entry => entry.outcome.kind !== "accepted"
    && !(entry.outcome.kind === "pending" && entry.outcome.reason === "saved" && entry.requestId === busyRequestId));
  if (!visible.length) return null;
  return <div className="prompt-outbox-status" aria-label="Saved prompt submissions">
    {visible.map(entry => {
      const body = JSON.parse(entry.bodyJson) as { text: string; delivery: string };
      const busy = entry.requestId === busyRequestId;
      const outcome = entry.outcome;
      if (outcome.kind === "accepted") return null;
      return <div className="prompt-outbox-status-item" key={entry.requestId} data-request-id={entry.requestId} role="status">
        <div><strong>{outcome.kind === "rejected" ? "Prompt rejected" : busy ? "Checking prompt acceptance…" : "Prompt acceptance unconfirmed"}</strong>
          <span className="prompt-outbox-status-delivery">{body.delivery}</span></div>
        <div className="prompt-outbox-status-preview">{body.text.length > 160 ? `${body.text.slice(0, 160)}…` : body.text}</div>
        <div>{outcome.message}</div>
        <div className="prompt-outbox-status-actions">
          {outcome.kind === "pending" && <button type="button" disabled={busy} onClick={() => onRetry(entry.requestId)}>Retry same request</button>}
          <button type="button" disabled={busy} onClick={() => onDiscard(entry.requestId)}>Dismiss saved prompt</button>
        </div>
        {outcome.kind === "pending" && <small>Dismiss stops retrying on this device. It does not cancel a prompt the server already accepted.</small>}
      </div>;
    })}
  </div>;
}
