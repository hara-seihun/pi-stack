import type { Activity } from "./types";
import { activityLabel } from "./thread-state";

export function LiveActivity({ activity, tool, offline }: { activity: Activity; tool?: string | null; offline?: string | null }) {
  if (activity === "idle" || activity === "stopped") return null;
  return <div className={`live-activity${offline ? " disconnected" : ""}`} role="status">
    <span className="live-activity-dot" aria-hidden="true" />
    {offline ? "Disconnected. Reconnecting to live progress…" : activityLabel(activity, tool ?? "")}
  </div>;
}
