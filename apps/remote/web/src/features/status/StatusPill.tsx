import type { ReactNode } from "react";
import type { ThreadStatus } from "./thread-status";
import "./status.css";

export function StatusPill({ status, compact = false, children, className = "" }: { status: ThreadStatus; compact?: boolean; children?: ReactNode; className?: string }) {
  return <span className={`status-pill ${className}`} data-status={status.key} title={status.title}>
    <span className="status-label">{compact ? status.short : status.label}</span>
    {children}
  </span>;
}
