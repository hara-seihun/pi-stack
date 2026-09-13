import { activityLabel, normalizedActivity } from "./agent-placement";

export function LiveActivity({ activity, tool, offline }: { activity: string; tool?: string | null; offline?: string | null }) {
  const active = ["STARTING", "RUNNING", "WORKING", "THINKING", "COMPACTING", "RETRYING", "RECONNECTING", "QUEUED", "WAITING_ON_TOOL", "ABORTING"];
  if (!active.includes(normalizedActivity(activity))) return null;
  return <div className={`live-activity${offline ? " disconnected" : ""}`} role="status">
    <span className="live-activity-dot" aria-hidden="true" />
    {offline ? "Disconnected. Reconnecting to live progress…" : activityLabel(activity, tool ?? "")}
  </div>;
}
