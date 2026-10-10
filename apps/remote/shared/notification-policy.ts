import type { ManagerNotificationPolicy } from "pi-orchestrator/api";

export const CLASSIC_NOTIFICATION_POLICY: ManagerNotificationPolicy = { view: "classic" };

export function humanNotification(policy: ManagerNotificationPolicy | null, threadId: string, kind: "idle" | "question" | "attention" | undefined): boolean {
  if (policy === null) return false;
  switch (policy.view) {
    case "classic": return true;
    case "mono": return kind === "attention" && threadId === policy.managerThreadId;
  }
}
