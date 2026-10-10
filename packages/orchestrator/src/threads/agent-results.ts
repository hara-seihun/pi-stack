import type { AgentWaitRegistration, Result, Thread, ThreadMessage, ThreadSettlement, ThreadWakeSchedule } from "./contracts.js";
import type { WatchResponse } from "./watch-list.js";
import { finalText } from "./message-format.js";

/**
 * What an agent acts on after a thread tool call. The owner API keeps full
 * records for clients; tool results carry only identities, lifecycle and the
 * outcome of the request, never an echo of what the caller just sent.
 */
export type AgentThreadView = Pick<Thread, "id" | "title" | "lifecycle" | "updatedAt">
  & Partial<Pick<Thread, "agentName" | "parentId" | "pendingMessages" | "dependencies">>
  & { wake?: Pick<ThreadWakeSchedule, "reason" | "cadenceMs" | "nextDueAt">; archived?: true };

export function agentThreadView(thread: Thread): AgentThreadView {
  return {
    id: thread.id, title: thread.title,
    ...(thread.agentName ? { agentName: thread.agentName } : {}),
    ...(thread.parentId ? { parentId: thread.parentId } : {}),
    lifecycle: thread.lifecycle,
    ...(thread.pendingMessages ? { pendingMessages: thread.pendingMessages } : {}),
    ...(thread.dependencies?.length ? { dependencies: thread.dependencies } : {}),
    ...(thread.wakeSchedule ? { wake: agentWakeView(thread.wakeSchedule) } : {}),
    ...(thread.metadata?.archived === true ? { archived: true as const } : {}),
    updatedAt: thread.updatedAt,
  };
}

export function agentWakeView(schedule: ThreadWakeSchedule): Pick<ThreadWakeSchedule, "reason" | "cadenceMs" | "nextDueAt"> {
  return { reason: schedule.reason, cadenceMs: schedule.cadenceMs, nextDueAt: schedule.nextDueAt };
}

export function agentMessageView(message: ThreadMessage): Pick<ThreadMessage, "id" | "state"> {
  return { id: message.id, state: message.state };
}

export function agentSettlementView(settlement: ThreadSettlement) {
  return { threadId: settlement.threadId, outcome: settlement.outcome, finalText: finalText(settlement.finalMessage),
    ...(settlement.error ? { error: settlement.error } : {}) };
}

export function agentWaitView(registration: AgentWaitRegistration) {
  switch (registration.status) {
    case "registered": case "cleared": return { status: registration.status };
    case "resumed": return { status: registration.status, messageIds: registration.messageIds };
    case "already_arrived": return { status: registration.status, settlement: agentSettlementView(registration.settlement) };
  }
}

export function agentWatchView(response: WatchResponse) {
  if ("item" in response) return { id: response.item.id, nextDueAt: response.item.nextDueAt };
  return response;
}

export function mapResult<T, U>(value: Result<T>, project: (value: T) => U): Result<U> {
  return value.ok ? { ok: true, value: project(value.value) } : value;
}
