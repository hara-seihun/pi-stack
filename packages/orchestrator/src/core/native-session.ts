import { AsyncLocalStorage } from "node:async_hooks";
import { createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import type { OpenPiSession, PiEvent, PiSession, PiSessionOptions } from "../threads/contracts.js";
import { parseNativeInputs } from "../threads/pi-input-batch.js";

type Services = Awaited<ReturnType<typeof createAgentSessionServices>>;
type Native = Awaited<ReturnType<typeof createAgentSessionFromServices>>;
export type NativeResult<T> = { ok: true; value: T } | { ok: false; error: { code: "resources-unavailable" | "session-unavailable"; message: string } };
const scopeKey = Symbol.for("pi-stack.session-environment");
const globals = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<NodeJS.ProcessEnv> };
export const coreSessionEnvironment = globals[scopeKey] ??= new AsyncLocalStorage<NodeJS.ProcessEnv>();

export async function createCoreNativeServices(options: Parameters<typeof createAgentSessionServices>[0]): Promise<NativeResult<Services>> {
  try {
    const services = await createAgentSessionServices(options);
    const errors = [...services.diagnostics.filter(item => item.type === "error").map(item => item.message),
      ...services.resourceLoader.getExtensions().errors.map(item => JSON.stringify(item))];
    if (errors.length) return { ok: false, error: { code: "resources-unavailable", message: errors.join("; ") } };
    return { ok: true, value: services };
  } catch (cause) { return { ok: false, error: { code: "resources-unavailable", message: String(cause) } }; }
}

export async function createCoreNativeSession(options: Parameters<typeof createAgentSessionFromServices>[0]): Promise<NativeResult<Native>> {
  try { return { ok: true, value: await createAgentSessionFromServices(options) }; }
  catch (cause) { return { ok: false, error: { code: "session-unavailable", message: String(cause) } }; }
}

export interface InProcessConversation {
  prompt(text: string): Promise<void>;
  finalMessage(): Record<string, unknown> | null;
  observe?(listener: (event: PiEvent) => void): () => void;
  abort(): Promise<void>;
  respondUI?(requestId: string, cancelled: true): Promise<void>;
  dispose(): void | Promise<void>;
}
export type ConversationFactory = (options: PiSessionOptions) => Promise<InProcessConversation>;

/** In-process resources share their caller's ThreadService; this adapter owns no ledger or timer. */
export function createCoreInProcessRuntime() {
  const registered = new Map<string, ConversationFactory>();
  const waiting = new Map<string, { accept(factory: ConversationFactory): void; reject(error: Error): void }>();
  const sessions = new Map<string, { session: PiSession; settled(): Promise<void> }>();
  let detached = false;
  const openSession: OpenPiSession = async (options, output) => {
    if (detached) throw new Error("In-process runtime is detached");
    let factory = registered.get(options.threadId);
    if (!factory) {
      if (waiting.has(options.threadId)) throw new Error("Native conversation already waits for its original constructor");
      factory = await new Promise<ConversationFactory>((accept, reject) => { waiting.set(options.threadId, { accept, reject }); });
      waiting.delete(options.threadId);
    }
    if (detached) throw new Error("In-process constructor observation detached; its input remains with the core");
    if (sessions.has(options.threadId)) throw new Error("Native conversation already has execution custody");
    // Consume the one-time constructor before entering it. Lost acknowledgement cannot replay it.
    registered.delete(options.threadId);
    const native = await factory(options);
    let task: Promise<void> | undefined, busy = false, finalMessage: Record<string, unknown> | null = null;
    const acceptedWorkIds: string[] = [], completedWorkIds: string[] = [];
    let dialogFailure: Error | undefined;
    const unsubscribe = native.observe?.(event => {
      if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) {
        if (typeof event.id !== "string" || !native.respondUI) {
          dialogFailure = Object.assign(new Error("Injected native conversation emitted an unsupported blocking dialog"), { code: "unsupported-dialog" });
          output({ type: "thread_error", error: dialogFailure.message, code: "unsupported-dialog" });
          void native.abort().catch(error => output({ type: "thread_error", error: String(error), code: "dialog-abort-failed" }));
        } else {
          void native.respondUI(event.id, true).then(() => output({ ...event, cancelled: true }), error => {
            dialogFailure = Object.assign(new Error(String(error)), { code: "dialog-cancellation-failed" });
            output({ type: "thread_error", error: dialogFailure.message, code: "dialog-cancellation-failed" });
          });
        }
        return;
      }
      if (event.type !== "agent_settled") output(event);
    });
    const session: PiSession = {
      command: async command => {
        const respond = (data: unknown = {}) => output({ type: "response", id: command.id, command: command.type, success: true, data });
        switch (command.type) {
          case "get_state": respond({ nativeProtocolVersion: "batch-operations-v1", sessionFile: options.sessionFile, isStreaming: busy, isCompacting: false, isBashRunning: false, acceptedWorkIds,
            completedWorkIds, landedWorkIds: acceptedWorkIds, lastAssistantMessage: finalMessage }); return;
          case "set_session_name": respond(); return;
          case "abort": await native.abort(); await task; respond(); return;
          case "input_batch": {
            const parsed = parseNativeInputs(command.inputs);
            if (!parsed.ok || parsed.value.length !== 1 || busy || acceptedWorkIds.length || command.resume || parsed.value[0]!.images?.length) {
              output({ type: "response", id: command.id, command: command.type, success: false, error: "Private in-process admission requires one fresh text input batch; no input was accepted" }); return;
            }
            busy = true;
            const { workId, message } = parsed.value[0]!;
            acceptedWorkIds.push(workId); respond();
            task = (async () => {
              let outcome: "complete" | "failed" = "complete";
              try {
                await native.prompt(message);
                if (dialogFailure) throw dialogFailure;
                finalMessage = native.finalMessage();
                if (!finalMessage) throw new Error("Native conversation has no final result");
              } catch (error) {
                outcome = "failed";
                finalMessage = { role: "assistant", content: [], stopReason: "error", errorMessage: String(error) };
              } finally {
                busy = false; completedWorkIds.push(workId);
                output({ type: "agent_settled", workIds: [workId], outcome, lastAssistantMessage: finalMessage });
              }
            })();
            return;
          }
        }
        output({ type: "response", id: command.id, command: command.type, success: false, error: `Unsupported in-process command ${command.type}` });
      },
      close: async () => { await task; unsubscribe?.(); await native.dispose(); sessions.delete(options.threadId); },
    };
    sessions.set(options.threadId, { session, settled: async () => { await task; } });
    return session;
  };
  return { openSession,
    attachSession: async () => null,
    recoverSession: async () => null,
    register(threadId: string, factory: ConversationFactory): () => void {
      if (detached || registered.has(threadId) || sessions.has(threadId)) throw new Error("Native conversation registration conflicts with existing custody");
      registered.set(threadId, factory);
      waiting.get(threadId)?.accept(factory);
      return () => { if (registered.get(threadId) === factory) registered.delete(threadId); };
    },
    async drain(): Promise<void> { await Promise.all([...sessions.values()].map(item => item.settled())); },
    detach(): void {
      detached = true; registered.clear();
      for (const waiter of waiting.values()) waiter.reject(new Error("Private constructor wait detached; original input is retained"));
      waiting.clear();
      // Accepted judgments finish in this process. Its owner must await drain before exit.
    },
    path(logicalPath: string): string { return logicalPath; },
  };
}
export type CoreInProcessRuntime = ReturnType<typeof createCoreInProcessRuntime>;
