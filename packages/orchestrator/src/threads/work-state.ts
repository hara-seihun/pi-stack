import type { Thread } from "./contracts.js";

/** A quiet native turn is not evidence that its assignment has finished. */
export function threadHasOutstandingWork(thread: Thread): boolean {
  return thread.state !== "idle" || thread.pendingMessages > 0
    || !!thread.waitingOnAgents || !!thread.wakeSchedule
    || !!thread.dependencies?.length;
}
