import type { ReactNode } from "react";
import { useVisualClock } from "./visual-clock";
import { activityTiming, type ThreadStatus } from "./thread-status";
import "./status.css";

export function StatusPill({ status, compact = false, children, className = "" }: { status: ThreadStatus; compact?: boolean; children?: ReactNode; className?: string }) {
  const timed = status.busy && Boolean(status.since || status.lastActivityAt);
  const { ref, now } = useVisualClock<HTMLSpanElement>(timed);
  const timing = activityTiming(status, now);
  const title = [status.title, timing.quiet].filter(Boolean).join(" · ") || undefined;
  return <span ref={ref} className={`status-pill${compact ? " compact" : ""} ${className}`} data-status={status.key} title={title}>
    <span className="status-primary"><span className="status-label">{compact ? status.short : status.label}</span>
      {timing.elapsed && !(compact && timing.quiet) && <span className="status-elapsed">{timing.elapsed}</span>}{children}</span>
    {timing.quiet && <span className="status-quiet">{timing.quiet}</span>}
    {!compact && (status.key === "error" || status.key === "reporting_error") && status.title && <span className="status-error-detail">{status.title}</span>}
  </span>;
}
