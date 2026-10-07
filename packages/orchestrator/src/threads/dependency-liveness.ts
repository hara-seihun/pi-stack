import type { Thread } from "./contracts.js";

// A peer dependency exists so a result is not lost: the dependent may not be
// closed while it waits for its target, and the target may not be closed while
// it still owes the dependent a result. Once the target has settled and the
// dependent is not waiting on it, the edge protects nothing. It is inert, does
// not block closing or archiving either endpoint, and is released on close.

/** The target still has unfinished work, so its result has not been delivered. */
export const owesResult = (target: Thread): boolean => target.state !== "idle" || target.pendingMessages > 0;

/** The dependent's current wait names this target. */
export function waitsOn(dependent: Thread, targetId: string): boolean {
  const wait = dependent.metadata?.agentWait as { threadIds?: unknown; fromThreadId?: unknown } | undefined;
  return !!wait && (Array.isArray(wait.threadIds) && wait.threadIds.includes(targetId) || wait.fromThreadId === targetId);
}

/**
 * Whether dependent → target still protects both endpoints.
 * `target: "unknown"` means the target lives in an owner this caller cannot read
 * synchronously; such an edge is treated as live until an authoritative check
 * across owners releases it.
 */
export function liveDependency(dependent: Thread | undefined, targetId: string, target: Thread | "unknown" | undefined): boolean {
  if (!dependent || dependent.held || dependent.metadata?.archived) return false;
  if (waitsOn(dependent, targetId)) return true;
  if (target === "unknown") return true;
  return !!target && !target.held && !target.metadata?.archived && owesResult(target);
}
