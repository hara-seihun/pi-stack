import type { StreamSnapshot, StreamSubscription } from "../server/protocol.js";
import { validateStreamSnapshot } from "./state-validation.js";

export function streamResource(snapshot: StreamSnapshot): string {
  return "sessionId" in snapshot ? `${snapshot.type}:${snapshot.sessionId}` : snapshot.type;
}

export function streamWants(subscription: StreamSubscription): string[] {
  const wants = ["bootstrap", "state"];
  if (subscription.dashboard) wants.push("dashboard");
  if (subscription.workers) wants.push("workers");
  if (subscription.session) {
    wants.push(`live:${subscription.session}`);
    if (subscription.viewing) wants.push(`transcript:${subscription.session}`, `images:${subscription.session}`, `questions:${subscription.session}`);
  }
  return wants;
}

export function isStreamSnapshot(resource: string, value: unknown): value is StreamSnapshot {
  try { validateStreamSnapshot(resource, value); return true; }
  catch { return false; }
}
