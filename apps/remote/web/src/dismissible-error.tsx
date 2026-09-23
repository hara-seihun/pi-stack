import { useState } from "react";
import "./dismissible-error.css";

export interface DismissibleErrorProps {
  message: string | null | undefined;
  resetKey?: string | number;
  className?: string;
  dismissLabel?: string;
  role?: "alert" | "status";
  onDismiss?: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function DismissibleError({ message, resetKey, ...props }: DismissibleErrorProps) {
  return message ? <ErrorFeedback key={JSON.stringify([message, resetKey])} message={message} {...props} /> : null;
}

function ErrorFeedback({ message, className = "", dismissLabel = "Dismiss error", role = "alert", onDismiss }: Omit<DismissibleErrorProps, "resetKey">) {
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const dismiss = async () => {
    if (pending) return;
    if (!onDismiss) { setDismissed(true); return; }
    setPending(true);
    setFailure("");
    const result = await onDismiss();
    setPending(false);
    if (result.ok) setDismissed(true);
    else setFailure(`Could not dismiss error: ${result.error}`);
  };
  if (dismissed) return null;
  return <div className={`dismissible-error ${className}`}>
    <div className="dismissible-error-message" role={role}>{message}</div>
    {failure && <div role="alert">{failure}</div>}
    <button className="dismissible-error-dismiss" type="button" aria-label={dismissLabel} title={dismissLabel} disabled={pending} onClick={() => void dismiss()}>
      <span aria-hidden="true">×</span>
    </button>
  </div>;
}
