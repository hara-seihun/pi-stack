import { useVisualClock } from "./visual-clock";
import { activityTiming, type ThreadStatus } from "./thread-status";
import { StatusIcon, statusDescription } from "./StatusIcon";
import "./status.css";

const quietText = (quiet: string) => `Quiet for ${quiet}`;

/** The full written state, for places that explain a thread rather than list it. */
export function StatusPill({ status }: { status: ThreadStatus }) {
  const timed = (status.busy || status.key === "waiting" || status.key === "queued") && (status.since !== undefined || status.lastActivityAt !== undefined);
  const { ref, now } = useVisualClock<HTMLSpanElement>(timed);
  const timing = activityTiming(status, now);
  return <span ref={ref} className="status-pill" data-status={status.key}>
    <span className="status-primary"><StatusIcon status={status} /><span className="status-label">{statusDescription(status)}</span>
      {timing.elapsed && <span className="status-elapsed">{timing.elapsed}</span>}</span>
    {timing.quiet && <span className="status-quiet">{quietText(timing.quiet)}</span>}
    {(status.key === "error" || status.key === "reporting_error") && status.title && <span className="status-error-detail">{status.title}</span>}
  </span>;
}

/** A stalled busy thread stays visible in dense rows, where the glyph alone cannot say how long it has been silent. Empty until quiet. */
export function StatusQuiet({ status }: { status: ThreadStatus }) {
  const { ref, now } = useVisualClock<HTMLSpanElement>(status.busy && status.lastActivityAt !== undefined);
  const { quiet } = activityTiming(status, now);
  return <span ref={ref} className="status-quiet">{quiet ? quietText(quiet) : null}</span>;
}
