import { useState } from "react";
import "./dismissible-error.css";

export interface DismissibleErrorProps {
  message: string | null | undefined;
  resetKey?: string | number;
  className?: string;
  dismissLabel?: string;
  role?: "alert" | "status";
}

export function DismissibleError({ message, resetKey, ...props }: DismissibleErrorProps) {
  return message ? <ErrorFeedback key={JSON.stringify([message, resetKey])} message={message} {...props} /> : null;
}

function ErrorFeedback({ message, className = "", dismissLabel = "Dismiss error", role = "alert" }: Omit<DismissibleErrorProps, "resetKey">) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return <div className={`dismissible-error ${className}`}>
    <div className="dismissible-error-message" role={role}>{message}</div>
    <button className="dismissible-error-dismiss" type="button" aria-label={dismissLabel} title={dismissLabel} onClick={() => setDismissed(true)}>
      <span aria-hidden="true">×</span>
    </button>
  </div>;
}
