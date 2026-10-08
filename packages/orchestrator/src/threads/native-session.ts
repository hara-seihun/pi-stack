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
    if (!/^pi-native-[a-f0-9-]+\.service$/.test(unit) || !databasePath.endsWith(".sqlite3") || !cgroup?.endsWith(`/${unit}`)) throw new Error("Native session host is not inside its declared managed unit");
    return { threadId, databasePath, unit, cgroup, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
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
  const settings: ThreadSettings = { model: "pi/native", thinkingLevel: "off", speed: "standard" };
  const service = new ThreadService({ databasePath, sessionsDir, capacity: options.capacity,
    openSession: async (_options, emit) => {
      output = emit;
      return {
        command: async command => {
          const reply = (data: unknown) => emit({ type: "response", command: command.type, id: command.id, success: true, data });
          const session = created?.session;
          switch (command.type) {
            case "get_state": reply({ sessionFile: session?.sessionFile, isStreaming: session?.isStreaming ?? false,
              isCompacting: session?.isCompacting ?? false, isBashRunning: session?.isBashRunning ?? false,
              localTools: active?.pending.size ?? 0, pendingMessageCount: session?.pendingMessageCount ?? 0,
              lastAssistantMessage: session ? [...session.messages].reverse().find(message => message.role === "assistant") ?? null : null }); return;
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
              if (session) { session.clearQueue(); session.abortCompaction(); session.abortBash(); await session.abort(); }
              if (active) while (active.pending.size) await Promise.allSettled(active.pending);
              reply(null); return;
            default: emit({ type: "response", command: command.type, id: command.id, success: false, error: `Unsupported native owner command: ${command.type}` });
          }
        },
        close: async () => { unsubscribe?.(); if (!disposed) { disposed = true; nativeDispose?.(); } },
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
      if (session) { session.clearQueue(); session.abortCompaction(); session.abortBash(); await session.abort(); }
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
      bind(session.agent as any, ["prompt", "continue"]);
      const state = session.agent.state;
      const descriptor = Object.getOwnPropertyDescriptor(state, "tools");
      if (!descriptor?.get || !descriptor.set) throw new Error("Pi native tool state no longer exposes its declared accessor");
      const wrapped = new WeakMap<object, typeof state.tools[number]>();
      const wrap = (tool: typeof state.tools[number]): typeof tool => {
        const existing = wrapped.get(tool); if (existing) return existing;
        const next = { ...tool, execute: (...args: Parameters<typeof tool.execute>) => run(`tool:${tool.name}`, () => tool.execute(...args)) };
        wrapped.set(tool, next); wrapped.set(next, next); return next;
      };
      Object.defineProperty(state, "tools", { ...descriptor, get: () => descriptor.get!.call(state),
        set: tools => descriptor.set!.call(state, tools.map(wrap)) });
      state.tools = state.tools;
      session.dispose = () => close();
    });
    return { ...created!, threadService: service, threadId, close };
  } catch (error) { await close(); throw error; }
}
