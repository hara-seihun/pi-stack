import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentCapacity } from "../agent-capacity.js";
import { ThreadService } from "./service.js";
import { installMessageDelivery } from "./message-delivery.js";
import type { PiEvent, Result, ThreadSettings } from "./contracts.js";
import { PiExecution } from "./pi-execution.js";
import { PiInputBatch, parseNativeInputs } from "./pi-input-batch.js";
export { recoverNativeSessionOwners, nativeOwnerAbsent } from "./native-owner-recovery.js";

export interface NativeSessionOptions {
  cwd: string;
  databasePath?: string;
  sessionsDir?: string;
  capacity?: AgentCapacity | { mode: "unmanaged" };
}
interface Operation { active: boolean; pending: Set<Promise<unknown>> }
export interface ManagedSession<S extends AgentSession = AgentSession> {
  session: S;
  threadService: ThreadService;
  threadId: string;
  close(): Promise<void>;
}
const requireValue = <T>(result: Result<T>): T => {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
};

/** Native UI and SDK clients share their session with this local ThreadService owner. */
export async function createManagedAgentSession<T extends { session: AgentSession }>(
  factory: () => Promise<T>, options: NativeSessionOptions,
): Promise<T & ManagedSession<T["session"]>> {
  const threadId = randomUUID();
  const stateDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "managed");
  const databasePath = options.databasePath ?? join(stateDir, threadId, "threads.sqlite3");
  const sessionsDir = options.sessionsDir ?? join(dirname(databasePath), "sessions");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const unit = process.env.PI_STACK_NATIVE_OWNER_UNIT;
  const ownerRecord = (() => {
    if (!unit) return undefined;
    const cgroup = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").find(line => line.startsWith("0::"))?.slice(3);
    if (!/^pi-native-[a-f0-9-]+\.scope$/.test(unit) || !databasePath.endsWith(".sqlite3") || !cgroup?.endsWith(`/${unit}`)) throw new Error("Native session host is not inside its declared managed scope");
    return { threadId, databasePath, unit, cgroup, uid: process.getuid!(), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
  })();
  const scope = new AsyncLocalStorage<Operation>();
  const callbacks = new Map<string, () => Promise<unknown>>();
  let created: T | undefined;
  let output: ((event: PiEvent) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let active: Operation | undefined;
  let closing: Promise<void> | undefined;
  let disposed = false;
  let nativeDispose: (() => void) | undefined;
  let inbox: PiInputBatch | undefined;
  const execution = new PiExecution(() => {}, event => output?.(event));
  const settings: ThreadSettings = { model: "pi/native", thinkingLevel: "off", speed: "standard" };
  const service = new ThreadService({ databasePath, sessionsDir, capacity: options.capacity,
    openSession: async (_options, emit) => {
      output = emit;
      return {
        command: async command => {
          const reply = (data: unknown) => emit({ type: "response", command: command.type, id: command.id, success: true, data });
          const session = created?.session;
          switch (command.type) {
            case "get_state": execution.flushCompletions(); reply({ sessionFile: session?.sessionFile, isStreaming: session?.isStreaming ?? false,
              isCompacting: session?.isCompacting ?? false, isBashRunning: session?.isBashRunning ?? false,
              nativeProtocolVersion: "batch-operations-v1", localTools: active?.pending.size ?? 0, backgroundOperationCount: execution.activeTools, pendingMessageCount: session?.pendingMessageCount ?? 0,
              lastAssistantMessage: session ? [...session.messages].reverse().find(message => message.role === "assistant") ?? null : null }); return;
            case "input_batch": {
              if (!command.id || typeof command.batchId !== "string" || !command.batchId) { emit({ type: "response", command: command.type, id: command.id, success: false, error: "Native batch identity is required" }); return; }
              const parsed = parseNativeInputs(command.inputs);
              const result = parsed.ok ? inbox?.accept(parsed.value, { commandId: command.id, batchId: command.batchId }) : parsed;
              emit({ type: "response", command: command.type, id: command.id, success: result?.ok === true,
                ...(result?.ok ? { data: { accepted: true } } : { error: result?.error ?? "Native inbox has not initialized" }) }); return;
            }
            case "tool_operation": {
              const result = command.action === "inspect" ? execution.inspect(String(command.operationId)) : command.action === "cancel" ? execution.cancel(String(command.operationId)) : undefined;
              emit({ type: "response", command: command.type, id: command.id, success: result?.ok === true,
                ...(result?.ok ? { data: result.value } : { error: result?.error.message ?? "Invalid tool operation action" }) }); return;
            }
            case "set_session_name": case "set_thinking_level": reply(null); return;
            case "native_operation": {
              const callback = callbacks.get(command.id!);
              if (!callback) { emit({ type: "response", command: command.type, id: command.id, success: false, error: "Native operation callback is unavailable; it cannot be replayed" }); return; }
              const operation: Operation = { active: true, pending: new Set() };
              active = operation;
              let outcome: { ok: true } | { ok: false; error: unknown } = { ok: true };
              try { await scope.run(operation, callback); } catch (error) { outcome = { ok: false, error }; }
              while (operation.pending.size) await Promise.allSettled(operation.pending);
              operation.active = false;
              active = undefined;
              reply(outcome.ok ? outcome : { ok: false, error: String(outcome.error) });
              return;
            }
            case "abort":
              if (session) {
                session.abortCompaction();
                if (execution.boundSession === session) await execution.halt(session, 20_000); else await session.abort();
              }
              if (active) while (active.pending.size) await Promise.allSettled(active.pending);
              reply(null); return;
          }
          emit({ type: "response", command: command.type, id: command.id, success: false, error: `Unsupported native owner command: ${command.type}` });
        },
        close: async () => { if (execution.activeTools) throw new Error("Native context is still owned by background tool operations"); inbox?.close(); unsubscribe?.(); if (!disposed) { disposed = true; execution.dispose(); nativeDispose?.(); } },
      };
    },
  });
  requireValue(service.importThread({ id: threadId, cwd: options.cwd, title: "Native Pi session",
    sessionFile: join(sessionsDir, `${threadId}.jsonl`), settings,
    metadata: { source: "native-client", foreground: true } }));
  if (ownerRecord) writeFileSync(databasePath.replace(/\.sqlite3$/, ".owner.json"), JSON.stringify(ownerRecord), { mode: 0o600 });

  function nested<R>(operation: Operation, callback: () => Promise<R>): Promise<R> {
    const promise = Promise.resolve().then(callback);
    operation.pending.add(promise);
    void promise.then(() => operation.pending.delete(promise), () => operation.pending.delete(promise));
    return promise;
  }
  async function run<R>(name: string, callback: () => Promise<R>, input?: unknown): Promise<R> {
    if (disposed || closing) throw new Error("Native session owner is closed");
    const current = scope.getStore();
    if (current?.active) return nested(current, callback);
    const selected = created?.session.model;
    if (selected) {
      const currentSettings = service.get(threadId)!.settings;
      const model = `${selected.provider}/${selected.id}`, thinkingLevel = created!.session.thinkingLevel;
      if (currentSettings.model !== model || currentSettings.thinkingLevel !== thinkingLevel) {
        requireValue(await service.control({ threadId, action: "settings", settings: { model, thinkingLevel } }));
      }
    }
    const id = randomUUID();
    let outcome: { ok: true; value: R } | { ok: false; error: unknown } | undefined;
    callbacks.set(id, async () => {
      try { outcome = { ok: true, value: await callback() }; }
      catch (error) { outcome = { ok: false, error }; throw error; }
    });
    try {
      const result = requireValue(await service.command(threadId, { type: "native_operation", id, operation: name, input }));
      if (outcome && !outcome.ok) throw outcome.error;
      if (!result.ok) throw new Error(result.error);
      if (!outcome) throw new Error("Native operation has no local result; it cannot be replayed");
      return outcome.value;
    } finally { callbacks.delete(id); }
  }
  function bind(owner: Record<string, any>, names: string[]) {
    for (const name of names) {
      if (typeof owner[name] !== "function") continue;
      const original = owner[name].bind(owner);
      owner[name] = (...args: unknown[]) => {
        if (inbox && (name === "prompt" || name === "steer" || name === "followUp") && typeof args[0] === "string") {
          const input = { workId: randomUUID(), message: args[0], inputOrigin: "human" as const,
            ...((args[1] as { images?: any[] } | undefined)?.images ? { images: (args[1] as { images: any[] }).images } : {}) };
          const result = inbox.accept([input]);
          return result.ok ? Promise.resolve() : Promise.reject(new Error(result.error));
        }
        // External steering enters the live native queue under its current owner's custody.
        if (active?.active && (name === "steer" || name === "followUp" || name === "prompt" && created?.session.isStreaming)) {
          return scope.run(active, () => nested(active!, () => original(...args)));
        }
        return run(name, () => original(...args), typeof args[0] === "string" ? args[0] : undefined);
      };
    }
  }
  async function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      const session = created?.session;
      if (session) {
        session.abortCompaction();
        if (execution.boundSession === session) await execution.halt(session, 20_000); else await session.abort();
      }
      if (active) while (active.pending.size) await Promise.allSettled(active.pending);
      // command() owns the release acknowledgement; do not close its database before it returns.
      await commandTail;
      requireValue(await service.control({ threadId, action: "cancel" }));
      requireValue(await service.close());
    })();
    return closing;
  }
  let commandTail: Promise<unknown> = Promise.resolve();
  const command = service.command.bind(service);
  service.command = (...args) => {
    const promise = command(...args);
    commandTail = Promise.allSettled([commandTail, promise]);
    return promise;
  };
  try {
    await run("create_session", async () => {
      created = await factory();
      const session = created.session;
      installMessageDelivery(session, process.env);
      nativeDispose = session.dispose.bind(session);
      unsubscribe = session.subscribe(event => output?.(event as PiEvent));
      bind(session as any, ["prompt", "steer", "followUp", "sendCustomMessage", "sendUserMessage", "compact", "navigateTree", "executeBash", "bindExtensions"]);
      session.agent.steeringMode = "all";
      bind(session.agent as any, ["prompt", "continue"]);
      execution.bind(session);
      session.agent.state.tools = [...session.agent.state.tools.filter(tool => tool.name !== "tool_operation"), execution.inspectionTool()];
      inbox = new PiInputBatch(session, execution, event => output?.(event), () => {});
      session.dispose = () => close();
    });
    execution.flushCompletions();
    return { ...created!, threadService: service, threadId, close };
  } catch (error) { await close(); throw error; }
}
