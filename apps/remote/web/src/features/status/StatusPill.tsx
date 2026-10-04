import { useSyncExternalStore, type ReactNode } from "react";
import { activityTiming, type ThreadStatus } from "./thread-status";
import "./status.css";

const listeners = new Set<() => void>();
let clock = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => clock;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!timer) {
    clock = Date.now();
    timer = setInterval(() => { clock = Date.now(); for (const notify of listeners) notify(); }, 1_000);
  }
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
};
const noClock = () => () => {};

export function StatusPill({ status, compact = false, children, className = "" }: { status: ThreadStatus; compact?: boolean; children?: ReactNode; className?: string }) {
  const timed = status.busy && Boolean(status.since || status.lastActivityAt);
  const now = useSyncExternalStore(timed ? subscribe : noClock, snapshot, Date.now);
  const timing = activityTiming(status, now);
  const title = [status.title, timing.quiet].filter(Boolean).join(" · ") || undefined;
  return <span className={`status-pill${compact ? " compact" : ""} ${className}`} data-status={status.key} title={title}>
    <span className="status-primary"><span className="status-label">{compact ? status.short : status.label}</span>
      {timing.elapsed && !(compact && timing.quiet) && <span className="status-elapsed">{timing.elapsed}</span>}{children}</span>
    {timing.quiet && <span className="status-quiet">{timing.quiet}</span>}
    {!compact && (status.key === "error" || status.key === "reporting_error") && status.title && <span className="status-error-detail">{status.title}</span>}
  </span>;
}
