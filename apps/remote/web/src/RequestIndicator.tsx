import { useSyncExternalStore } from "react";
import { inFlight } from "./in-flight";
import "./request-indicator.css";

/**
 * The page-level half of the in-flight guarantee: present whenever a request
 * a person caused is still with the server, whichever control started it.
 */
export function RequestIndicator() {
  const count = useSyncExternalStore(inFlight.subscribe, inFlight.count, () => 0);
  if (!count) return null;
  return <div className="request-indicator" role="progressbar" aria-label="Waiting for the server" data-requests={count} />;
}
