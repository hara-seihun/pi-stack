import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadService } from "pi-orchestrator/api";
import type { CoreInProcessRuntime } from "pi-orchestrator/core-native";
import type { RootSession, RootSessionFactory, RootSessionSpec } from "./root-runtime.js";

export interface ConsultationOwner { threads: ThreadService; runtime: CoreInProcessRuntime }
export type ConsultationOwnerResolution = { ok: true; value: ConsultationOwner } | { ok: false; message: string };
export type ConsultationOwnerResolver = (rootSessionId: string, origin: "new" | "existing") => ConsultationOwnerResolution;
export class RootCapacityUnavailable extends Error {
  constructor(readonly retryAt: number) { super("Waiting for shared execution capacity"); }
}
export class RootReplyUnavailable extends Error {
  constructor() { super("Root execution did not choose a reply"); }
}

/** Only disclosure/admission rules are specialized. The host core owns execution and capacity. */
export function managedRootSession(spec: Omit<RootSessionSpec, "sessionFile">, factory: RootSessionFactory,
  custody: ConsultationOwner): RootSession {
  const owner = custody.threads;
  let native: RootSession | undefined, factoryFailure: unknown, turnFailure: unknown, entered = false;
  const enteredPath = join(spec.directory, "execution.json");
  const unregister = custody.runtime.register(spec.id, async options => {
    if (existsSync(enteredPath)) throw new Error("Interrupted root execution cannot be replayed");
    writeFileSync(enteredPath, JSON.stringify({ threadId: spec.id, enteredAt: Date.now() }) + "\n", { mode: 0o600 });
    entered = true; spec.onExecution?.();
    try { native = await factory({ ...spec, env: { ...options.env, ...spec.env, PI_KENAN_MEMORY_FOLDER: options.env.PI_KENAN_MEMORY_FOLDER, PI_STACK_HOST_CONFIG: options.env.PI_STACK_HOST_CONFIG }, sessionFile: options.sessionFile, onExecution: undefined }); }
    catch (error) { factoryFailure = error; throw error; }
    return {
      prompt: async text => {
        try { await native!.prompt(text); }
        catch (error) { turnFailure = error; throw error; }
      },
      finalMessage: () => {
        const reply = native!.reply();
        if (typeof reply !== "string" || !reply.trim()) { turnFailure = new RootReplyUnavailable(); return null; }
        return { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" };
      },
      observe: native.observe?.bind(native), abort: async () => { await native!.abort?.(); },
      dispose: async () => { await native!.dispose(); native = undefined; },
    };
  });
  let unsubscribe: (() => void) | undefined;
  return {
    prompt: async text => {
      if (existsSync(enteredPath) || owner.latestSettlement(spec.id)) throw new Error("Root execution identity cannot be replayed");
      let resolve!: () => void, reject!: (error: unknown) => void;
      const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      unsubscribe = owner.subscribe(event => {
        if (event.threadId !== spec.id) return;
        if ("event" in event && event.event.type === "thread_settled")
          event.event.outcome === "complete" ? resolve() : reject(turnFailure ?? new Error("Root managed execution failed"));
        const thread = owner.get(spec.id);
        if (factoryFailure) reject(factoryFailure);
        const failure = thread?.metadata?.startupFailure as { error: string } | undefined;
        if (failure) reject(new Error(failure.error));
      });
      const prior = owner.get(spec.id);
      if (prior) {
        const pending = owner.pending(spec.id);
        if (prior.held || prior.metadata?.archived || pending.length !== 1 || pending[0]!.id !== `root:${spec.id}` || pending[0]!.text !== text) {
          unsubscribe(); throw new Error("Original private input is held, absent or differs from this admitted request; it will not be replaced");
        }
      } else {
        const spawned = await owner.spawn({ requestId: `root:${spec.id}`, id: spec.id, cwd: spec.config.cwd,
          title: "Private consultation", message: text, metadata: { privateConsultation: true },
          settings: { model: `${spec.config.provider}/${spec.config.model}`, thinkingLevel: spec.config.thinkingLevel, speed: "standard" } });
        if (!spawned.ok) { unsubscribe(); throw new Error(spawned.error.message); }
      }
      // Startup/reconciliation belongs to the one core, not to each consultation.
      try { await completion; } finally { unsubscribe(); }
    },
    reply: () => native?.reply(), subjects: () => native?.subjects?.() ?? [],
    dispose: async () => {
      unsubscribe?.(); unregister();
      if (!entered) return;
      // Drain, never detach the shared owner or abort another judgment.
      const settlement = owner.latestSettlement(spec.id);
      if (!settlement && !factoryFailure) throw new Error("Accepted private judgment must drain before releasing its resources");
      const stopped = await owner.control({ threadId: spec.id, action: "cancel" });
      if (!stopped.ok) throw new Error(stopped.error.message);
    },
  };
}
