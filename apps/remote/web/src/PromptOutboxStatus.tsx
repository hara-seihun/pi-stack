import { useState } from "react";
import type { PromptOutboxEntry } from "./prompt-outbox";
import type { PromptStorageState } from "./prompt-storage";
import "./prompt-outbox-status.css";

export function PromptOutboxStatus({ entries, busyRequestId, onRetry, onDiscard, storage }: {
  entries: readonly PromptOutboxEntry[];
  busyRequestId: string | null;
  onRetry: (requestId: string) => void;
  onDiscard: (requestId: string) => void;
  storage?: { state: PromptStorageState<unknown>; retry: () => void };
}) {
  const [copyError, setCopyError] = useState<{ requestId: string; message: string } | null>(null);
  const copyText = async (requestId: string, text: string) => {
    const result = await copySavedPromptText(text, navigator.clipboard);
    setCopyError(result.ok ? null : { requestId, message: result.error });
  };
  const visible = entries.filter(entry => entry.outcome.kind !== "accepted"
    && !(entry.outcome.kind === "pending" && entry.outcome.reason === "saved" && entry.requestId === busyRequestId));
  const initialization = storage?.state;
  if (!visible.length && (!initialization || initialization.kind === "ready" || initialization.kind === "closed")) return null;
  return <div className="prompt-outbox-status" aria-label="Saved prompt submissions">
    {initialization?.kind === "loading" && <div className="prompt-outbox-status-item" role="status">Opening saved prompt storage… Your draft stays here until it is saved.</div>}
    {initialization?.kind === "failed" && <div className="prompt-outbox-status-item" role="alert">
      <strong>Could not open saved prompts</strong><div>{initialization.error.message}</div>
      <div>Your draft is retained. Retry storage or press Send to try again.</div>
      <button type="button" onClick={storage!.retry}>Retry storage</button>
    </div>}
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
          <button type="button" onClick={() => { void copyText(entry.requestId, body.text); }}>Copy saved text</button>
          <button type="button" disabled={busy} onClick={() => onDiscard(entry.requestId)}>Dismiss saved prompt</button>
        </div>
        {copyError?.requestId === entry.requestId && <div role="alert">{copyError.message}</div>}
        <SavedPromptText text={body.text} />
        {outcome.kind === "pending" && <small>Dismiss stops retrying on this device. It does not cancel a prompt the server already accepted.</small>}
      </div>;
    })}
  </div>;
}

export async function copySavedPromptText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!clipboard?.writeText) return { ok: false, error: "Clipboard is unavailable. Open Full saved text to select it." };
  try { await clipboard.writeText(text); return { ok: true }; }
  catch (error) { return { ok: false, error: `Could not copy saved text: ${error instanceof Error ? error.message : String(error)}` }; }
}

function SavedPromptText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Full saved text</summary>
    {open && <pre className="prompt-outbox-status-full">{text}</pre>}
  </details>;
}
