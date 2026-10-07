import type { ReactNode } from "react";
import { assertNever } from "../../../../shared/explicit-state";
import { statusGlyph, type StatusGlyph, type ThreadStatus } from "./thread-status";
import "./status.css";

function glyphPaths(glyph: StatusGlyph): ReactNode {
  switch (glyph) {
    case "working": return <><circle className="status-icon-track" cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 8 8" /></>;
    case "agents": return <><circle cx="12" cy="5.5" r="2.5" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /><path d="M12 8v4m0 0-5 4.5m5-4.5 5 4.5" /></>;
    case "job": return <path d="M6 3.5h12M6 20.5h12M8 3.5V7l4 5 4-5V3.5M8 20.5V17l4-5 4 5v3.5" />;
    case "deployment": return <path d="M12 16V4m-5 5 5-5 5 5M5 20h14" />;
    case "message": return <path d="M4 5h16v11H10l-6 4z" />;
    case "held": return <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>;
    case "stopping": return <rect className="status-icon-solid" x="6.5" y="6.5" width="11" height="11" rx="2" />;
    case "done": return <path d="m5 12.5 4.5 4.5L19 7.5" />;
    case "unread": return <circle className="status-icon-solid" cx="12" cy="12" r="5.5" />;
    case "error": return <path d="M12 3.5 21.5 20h-19zM12 10v4m0 3v.01" />;
    case "archived": return <path d="M3.5 5h17v4h-17zM5 9v10h14V9m-9 4h4" />;
    case "offline": return <><circle cx="12" cy="12" r="8.5" /><path d="m6 18 12-12" /></>;
  }
  return assertNever(glyph, "Status glyph");
}

export function statusDescription(status: ThreadStatus): string {
  return statusGlyph(status) === "unread" ? `${status.label}, unread` : status.label;
}

/** The thread's state as one glyph; the words travel as its accessible name and tooltip. */
export function StatusIcon({ status, className = "" }: { status: ThreadStatus; className?: string }) {
  const glyph = statusGlyph(status);
  const label = statusDescription(status);
  return <span className={`status-icon ${className}`} data-status={status.key} data-glyph={glyph} role="img" aria-label={label} title={[label, status.title].filter(Boolean).join(" — ")}>
    <svg viewBox="0 0 24 24" aria-hidden="true">{glyphPaths(glyph)}</svg>
  </span>;
}
