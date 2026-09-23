import type { StreamSnapshot, StreamSubscription } from "../server/protocol.js";

export function streamResource(snapshot: StreamSnapshot): string {
  return "sessionId" in snapshot ? `${snapshot.type}:${snapshot.sessionId}` : snapshot.type;
}

export function streamWants(subscription: StreamSubscription): string[] {
  const wants = ["bootstrap", "state", "messaging"];
  if (subscription.dashboard) wants.push("dashboard");
  if (subscription.session) {
    wants.push(`live:${subscription.session}`);
    if (subscription.viewing) wants.push(`transcript:${subscription.session}`, `images:${subscription.session}`);
  }
  return wants;
}

export function isStreamSnapshot(resource: string, value: unknown): value is StreamSnapshot {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return false;
  const snapshot = value as { type: string; sessionId?: unknown };
  if (!["bootstrap", "state", "messaging", "dashboard", "transcript", "live", "images"].includes(snapshot.type)) return false;
  return resource === (typeof snapshot.sessionId === "string" ? `${snapshot.type}:${snapshot.sessionId}` : snapshot.type);
}
