import type { ThreadInputState } from "../../../../../../packages/orchestrator/src/threads/contracts";
import { assertNever } from "../../../../shared/explicit-state";

export function inputPresentation(input: ThreadInputState): { label: string; detail: string; failed: boolean } {
  switch (input.state) {
    case "queued": return { label: "Accepted · queued", detail: input.priority === "human" || input.priority === "manager" ? "High-priority input; waiting for the next admission boundary" : "Waiting for its turn", failed: false };
    case "dispatched":
      if (input.landedAt != null) return { label: "In progress", detail: "This input is in the agent's context; no turn outcome yet", failed: false };
      if (input.insertedAt != null) return { label: "Accepted · queued in runtime", detail: "The runtime accepted this input; waiting for a tool boundary", failed: false };
      return { label: "Dispatching · acceptance unconfirmed", detail: "Do not resend as a new message; the existing receipt is being reconciled", failed: false };
    case "done":
      switch (input.outcome) {
        case "complete": return { label: "Turn finished", detail: "The owner recorded a successful turn for this input", failed: false };
        case "cancelled": return { label: "Cancelled", detail: input.error ?? "The owner recorded cancellation for this input", failed: false };
        case "failed": return { label: "Failed", detail: input.error ?? "The owner recorded failure for this input", failed: true };
        case undefined: return { label: "Outcome unavailable", detail: "The owner has no execution outcome for this historical input", failed: true };
      }
      return assertNever(input.outcome, "Input outcome");
  }
  return assertNever(input.state, "Input state");
}

export function InputStatus({ inputId, input }: { inputId: string; input?: ThreadInputState }) {
  const status = input ? inputPresentation(input) : { label: "Receipt unavailable", detail: "No canonical execution receipt is available for this input", failed: true };
  return <div className={`message-input-status${status.failed ? " message-input-failed" : ""}`} data-input-id={inputId} role="status" title={status.detail}>{status.label}{status.failed && <span className="message-input-detail"> · {status.detail}</span>}</div>;
}
