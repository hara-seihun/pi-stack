import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiCommand, PiEvent } from "./contracts.js";
import { inputReceipts } from "./pi-input-receipts.js";
import { checkpointPiSession } from "./pi-session-file.js";

export const FINAL_RESULT_RECOVERY_PROTOCOL = "final-result-recovery-v1";
export type RecoverySession = Pick<AgentSession, "sessionManager" | "sendCustomMessage" | "isIdle" | "isBashRunning">;
export type RecoveryRegistration = { ok: true } | { ok: false; error: string };
export interface FinalResultRecoveryBindings {
  session(): RecoverySession;
  idle(): boolean;
  register(workIds: string[], commandId: string): RecoveryRegistration | Promise<RecoveryRegistration>;
  output(event: PiEvent): void;
  settle(): void;
}

export function finalResultRecovery(session: RecoverySession, commandId?: string) {
  const entry = [...session.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "thread_final_result_recovery"
    && (commandId === undefined || (entry.data as { commandId: string }).commandId === commandId));
  return entry?.type === "custom" ? entry.data as { commandId: string; workIds: string[] } : null;
}

export async function recoverFinalResult(bindings: FinalResultRecoveryBindings, command: PiCommand): Promise<void> {
  const response = (success: boolean, error?: string, data?: unknown) => bindings.output({ type: "response", id: command.id,
    command: command.type, success, ...(error === undefined ? {} : { error }), ...(data === undefined ? {} : { data }) });
  if (command.type !== "recover_final_result" || !command.id || !Array.isArray(command.workIds) || !command.workIds.length
    || command.workIds.some(id => typeof id !== "string" || !id) || new Set(command.workIds).size !== command.workIds.length) {
    response(false, "Final result recovery requires command identity and distinct workIds"); return;
  }
  const workIds = command.workIds as string[], session = bindings.session();
  const prior = finalResultRecovery(session, command.id);
  if (prior) {
    if (JSON.stringify(prior.workIds) !== JSON.stringify(workIds)) response(false, "Final result recovery identity belongs to different work");
    else response(true, undefined, { alreadyAccepted: true });
    return;
  }
  const branch = session.sessionManager.getBranch(), known = inputReceipts(branch);
  if (branch.some(entry => entry.type === "custom" && entry.customType === "thread_final_result_recovery"
    && (entry.data as { workIds: string[] }).workIds.some(id => workIds.includes(id)))) {
    response(false, "Final result recovery was already attempted for this work"); return;
  }
  if (workIds.some(id => !known.completedWorkIds.includes(id) || !known.landedWorkIds.includes(id))) {
    response(false, "Final result recovery requires settled, landed native work"); return;
  }
  if (!bindings.idle() || !session.isIdle || session.isBashRunning) {
    response(false, "Final result recovery requires confirmed native idleness"); return;
  }
  session.sessionManager.appendCustomEntry("thread_final_result_recovery", { commandId: command.id, workIds });
  checkpointPiSession(session.sessionManager);
  const registered = await bindings.register(workIds, command.id);
  if (!registered.ok) { response(false, registered.error); return; }
  response(true, undefined, { accepted: true });
  void session.sendCustomMessage({ customType: "thread_final_result_request", display: true,
    content: "state your final result in one short message", details: { commandId: command.id, workIds } },
    { triggerTurn: true, deliverAs: "steer" }).catch(error => {
      bindings.output({ type: "extension_error", error: `Final result recovery failed: ${String(error)}` });
      bindings.settle();
    });
}
