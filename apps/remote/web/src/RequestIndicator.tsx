import { useSyncExternalStore } from "react";
import { inFlight } from "./in-flight";
import "./request-indicator.css";

/**
 * Page and section readiness shares this bar with user-initiated actions.
 * Nested item and media loading belongs to its own component.
 */
export function RequestIndicator() {
  const count = useSyncExternalStore(inFlight.subscribe, inFlight.count, () => 0);
  if (!count) return null;
  return <div className="request-indicator" role="progressbar" aria-label="Loading page or action" data-requests={count} />;
}
