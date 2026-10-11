import { createHash } from "node:crypto";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { PiCommand, PiEvent, PiSession } from "./contracts.js";
import { FINAL_RESULT_RECOVERY_PROTOCOL, finalResultRecovery, recoverFinalResult, type RecoverySession } from "./pi-final-result-recovery.js";

export const FINAL_RESULT_ADOPTION_PROTOCOL = "resident-final-result-adoption-v1";
export interface ResidentFinalResultTarget {
  threadId: string;
  adapter: PiSession;
  sink: { publish(event: PiEvent): void };
  runtime: { session: RecoverySession };
  inbox: { resume(): void };
  execution: { readonly blocked: boolean; readonly active: boolean; readonly activeTools: number };
  environmentScope: AsyncLocalStorage<NodeJS.ProcessEnv>;
  env: NodeJS.ProcessEnv;
  output(event: PiEvent): void;
  settle(): void;
  expected: { command: PiSession["command"]; publish: (event: PiEvent) => void; resume: () => void;
    session: RecoverySession; sessionId: string; sessionFile: string };
}
export type FinalResultAdoptionError = { code: "resident-contract-invalid" | "resident-source-conflict" | "resident-installation-failed"; message: string };
export type FinalResultAdoptionResult = { ok: true; value: { protocol: typeof FINAL_RESULT_ADOPTION_PROTOCOL; capability: typeof FINAL_RESULT_RECOVERY_PROTOCOL;
  residents: Array<{ threadId: string; sessionId: string; sessionFile: string; commandSha256: string; publishSha256: string }> } }
  | { ok: false; error: FinalResultAdoptionError };
export const nativeMethodHash = (method: Function) => createHash("sha256").update(String(method)).digest("hex");
const installations = new WeakMap<PiSession, { command: PiSession["command"]; publish: (event: PiEvent) => void; target: ResidentFinalResultTarget }>();
const failure = (code: FinalResultAdoptionError["code"], message: string): FinalResultAdoptionResult => ({ ok: false, error: { code, message } });

export function adoptResidentFinalResultRecovery(targets: readonly ResidentFinalResultTarget[], approved: { command: readonly string[]; publish: readonly string[]; resume: readonly string[] }): FinalResultAdoptionResult {
  if (!targets.length || new Set(targets.map(target => target.threadId)).size !== targets.length || new Set(targets.map(target => target.adapter)).size !== targets.length
    || new Set(targets.map(target => target.sink)).size !== targets.length) return failure("resident-contract-invalid", "Adoption requires distinct nonempty resident identities and event sinks");
  for (const target of targets) {
    const installed = installations.get(target.adapter), expected = target.expected;
    if (!target.threadId || typeof target.output !== "function" || typeof target.settle !== "function" || typeof target.environmentScope?.run !== "function"
      || typeof target.runtime?.session?.sendCustomMessage !== "function" || typeof target.inbox?.resume !== "function"
      || typeof target.execution?.active !== "boolean" || typeof target.execution?.blocked !== "boolean" || !Number.isSafeInteger(target.execution?.activeTools))
      return failure("resident-contract-invalid", `Resident ${target.threadId} lacks the retained native contract`);
    const manager = target.runtime.session.sessionManager;
    if (target.runtime.session !== expected.session || manager.getHeader()?.id !== expected.sessionId || manager.getSessionFile() !== expected.sessionFile)
      return failure("resident-source-conflict", `Resident ${target.threadId} session/history identity changed`);
    if (installed) {
      if (installed.target.expected.command !== expected.command || installed.target.expected.session !== expected.session || installed.target.inbox !== target.inbox
        || installed.target.sink !== target.sink || target.adapter.command !== installed.command || target.sink.publish !== installed.publish)
        return failure("resident-source-conflict", `Resident ${target.threadId} adopted bindings changed`);
      continue;
    }
    if (target.adapter.command !== expected.command || target.sink.publish !== expected.publish || target.inbox.resume !== expected.resume)
      return failure("resident-source-conflict", `Resident ${target.threadId} predecessor methods changed`);
    for (const name of ["command", "publish", "resume"] as const) if (!approved[name].includes(nativeMethodHash(expected[name])))
      return failure("resident-source-conflict", `Resident ${target.threadId} ${name} source is not approved`);
    for (const [owner, key] of [[target.adapter, "command"], [target.sink, "publish"], [target.inbox, "resume"]] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor && (!descriptor.configurable || !("value" in descriptor))) return failure("resident-contract-invalid", `Resident ${target.threadId} ${key} descriptor cannot be adopted`);
      if (!descriptor && !Object.isExtensible(owner)) return failure("resident-contract-invalid", `Resident ${target.threadId} ${key} owner is not extensible`);
    }
  }
  const prepared = targets.filter(target => !installations.has(target.adapter)).map(target => {
    const captures = new Map<string, { response?: PiEvent }>();
    const bound = () => target.runtime.session === target.expected.session
      && target.runtime.session.sessionManager.getHeader()?.id === target.expected.sessionId
      && target.runtime.session.sessionManager.getSessionFile() === target.expected.sessionFile;
    const publish = function(this: ResidentFinalResultTarget["sink"], event: PiEvent): void {
      if (event.type === "response" && event.command === "get_state" && event.success) {
        const data = { ...event.data as Record<string, unknown> };
        if (bound()) {
          data.finalResultRecovery = finalResultRecovery(target.runtime.session); data.finalResultRecoveryProtocol = FINAL_RESULT_RECOVERY_PROTOCOL;
          data.finalResultRecoveryAdoption = { state: "covered", protocol: FINAL_RESULT_ADOPTION_PROTOCOL };
        } else {
          delete data.finalResultRecoveryProtocol; delete data.finalResultRecovery;
          data.finalResultRecoveryAdoption = { state: "unsupported", protocol: FINAL_RESULT_ADOPTION_PROTOCOL, error: "Resident session changed; current closure bindings require adoption" };
        }
        event = { ...event, data };
      }
      const capture = event.type === "response" ? captures.get(String(event.id)) : undefined;
      if (capture) { capture.response = event; return; }
      target.expected.publish.call(this, event);
    };
    const captureCommand = async (command: PiCommand, suppressResume = false) => {
      const identity = String(command.id), captured: { response?: PiEvent } = {};
      if (captures.has(identity)) return { ok: false as const, error: "Retained native command observation is already active" };
      captures.set(identity, captured);
      const descriptor = Object.getOwnPropertyDescriptor(target.inbox, "resume");
      try {
        if (suppressResume) Object.defineProperty(target.inbox, "resume", { configurable: true, writable: true, value: () => {} });
        let pending: Promise<void>;
        try { pending = target.expected.command.call(target.adapter, command); }
        finally {
          if (suppressResume) { if (descriptor) Object.defineProperty(target.inbox, "resume", descriptor); else delete (target.inbox as { resume?: () => void }).resume; }
        }
        await pending;
        if (!captured.response) return { ok: false as const, error: "Retained native command did not positively acknowledge" };
        return captured.response.success ? { ok: true as const, value: captured.response.data as Record<string, any> }
          : { ok: false as const, error: String(captured.response.error) };
      } catch (cause) { return { ok: false as const, error: String(cause) }; }
      finally { captures.delete(identity); }
    };
    const command: PiSession["command"] = input => target.environmentScope.run(target.env, async () => {
      if (input.type !== "recover_final_result") return target.expected.command.call(target.adapter, input);
      if (!bound()) { target.output({ type: "response", id: input.id, command: input.type, success: false, error: "Resident session changed; final result recovery is not adopted" }); return; }
      const observed = await captureCommand({ type: "get_state", id: `final-result-observe:${input.id}` });
      if (!observed.ok) { target.output({ type: "response", id: input.id, command: input.type, success: false, error: observed.error }); return; }
      const state = observed.value;
      await recoverFinalResult({ session: () => target.runtime.session,
        idle: () => bound() && state.isStreaming === false && state.isCompacting === false && state.localTools === 0 && state.pendingCommandCount === 0
          && state.pendingMessageCount === 0 && state.backgroundOperationCount === 0 && state.cancellationFailed === false
          && !target.execution.blocked && !target.execution.active && target.execution.activeTools === 0,
        register: async (workIds, commandId) => {
          const accepted = await captureCommand({ type: "resume_pending", id: `final-result-register:${commandId}`, workIds }, true);
          return accepted.ok ? { ok: true } : { ok: false, error: accepted.error };
        }, output: target.output, settle: target.settle }, input);
    });
    return { target, command, publish, commandDescriptor: Object.getOwnPropertyDescriptor(target.adapter, "command"), publishDescriptor: Object.getOwnPropertyDescriptor(target.sink, "publish") };
  });
  try {
    for (const plan of prepared) {
      Object.defineProperty(plan.target.sink, "publish", { configurable: true, writable: true, value: plan.publish });
      Object.defineProperty(plan.target.adapter, "command", { configurable: true, writable: true, value: plan.command });
    }
  } catch (cause) {
    for (const plan of prepared) {
      if (plan.commandDescriptor) Object.defineProperty(plan.target.adapter, "command", plan.commandDescriptor); else delete (plan.target.adapter as { command?: PiSession["command"] }).command;
      if (plan.publishDescriptor) Object.defineProperty(plan.target.sink, "publish", plan.publishDescriptor); else delete (plan.target.sink as { publish?: (event: PiEvent) => void }).publish;
    }
    return failure("resident-installation-failed", String(cause));
  }
  for (const plan of prepared) installations.set(plan.target.adapter, { ...plan, target: plan.target });
  return { ok: true, value: { protocol: FINAL_RESULT_ADOPTION_PROTOCOL, capability: FINAL_RESULT_RECOVERY_PROTOCOL,
    residents: targets.map(target => ({ threadId: target.threadId, sessionId: target.expected.sessionId, sessionFile: target.expected.sessionFile,
      commandSha256: nativeMethodHash(target.adapter.command), publishSha256: nativeMethodHash(target.sink.publish) })) } };
}
