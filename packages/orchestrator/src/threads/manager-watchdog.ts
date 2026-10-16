import type { Thread } from "./contracts.js";

export const MANAGER_INACTIVITY_MS = 5 * 60_000;
export const MANAGER_WATCHDOG_PREFIX = "thread-wake:manager-inactivity:";
export type ManagerWorkSummary = { activeWork: boolean; lastHumanMessageAt: number | null };
export type ManagerWatchObservation = ManagerWorkSummary & { managerThreadId: string | null };

export function validateManagerWorkSummary(value: unknown): value is ManagerWorkSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return Object.keys(summary).length === 2 && typeof summary.activeWork === "boolean"
    && (summary.lastHumanMessageAt === null || Number.isSafeInteger(summary.lastHumanMessageAt) && (summary.lastHumanMessageAt as number) >= 0);
}

export function hasManagedWork(thread: Pick<Thread, "lifecycle" | "metadata">): boolean {
  switch (thread.lifecycle.kind) {
    case "working": case "waiting": case "cancelling": return true;
    case "failed": return thread.lifecycle.control !== "none";
    case "idle": case "archived": return false;
  }
}

export function combineManagerWork(summaries: readonly ManagerWorkSummary[]): ManagerWorkSummary {
  const times = summaries.flatMap(summary => summary.lastHumanMessageAt === null ? [] : [summary.lastHumanMessageAt]);
  return { activeWork: summaries.some(summary => summary.activeWork), lastHumanMessageAt: times.length ? Math.max(...times) : null };
}
