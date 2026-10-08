import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ThreadService, type AgentCapacity } from "pi-orchestrator/api";
import type { RootConfig, RootSession, RootSessionFactory, RootSessionSpec } from "./root-runtime.js";

export async function recoverRootOwners(config: RootConfig, capacity?: AgentCapacity | { mode: "unmanaged" }): Promise<void> {
  for (const entry of readdirSync(config.sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const directory = join(config.sessionsDir, entry.name), databasePath = join(directory, "threads.sqlite3");
    if (!existsSync(databasePath) || !existsSync(join(directory, "execution.json"))) continue;
    const owner = new ThreadService({ databasePath, sessionsDir: directory, capacity, workersOnly: true,
      openSession: async () => { throw new Error("Root execution must never replay during recovery"); }, recoverSession: async () => null });
    try {
      for (const thread of owner.snapshot()) {
        const stopped = await owner.control({ threadId: thread.id, action: "cancel" });
        if (!stopped.ok) throw new Error(`Private root custody recovery failed: ${stopped.error.code}`);
      }
    } finally {
      const detached = await owner.detach();
      if (!detached.ok) throw new Error(`Private root owner recovery failed: ${detached.error.code}`);
    }
  }
}

export class RootCapacityUnavailable extends Error {
  constructor(readonly retryAt: number) { super("Waiting for the shared global 100-agent capacity"); }
}

export class RootReplyUnavailable extends Error {
  constructor() { super("Root execution did not choose a reply"); }
}

/** This owner is private: it is never registered with a person or application thread directory. */
export function managedRootSession(spec: Omit<RootSessionSpec, "sessionFile">, factory: RootSessionFactory,
  capacity?: AgentCapacity | { mode: "unmanaged" }): RootSession {
  let native: RootSession | undefined, factoryFailure: unknown, turnFailure: unknown, entered = false, settled = false;
  const enteredPath = join(spec.directory, "execution.json");
  const owner = new ThreadService({ databasePath: join(spec.directory, "threads.sqlite3"), sessionsDir: spec.directory,
    capacity, workersOnly: true, environment: () => spec.env,
    // In-process native custody cannot outlive this daemon. Root requests that entered
    // execution are interrupted, never automatically replayed after its restart.
    recoverSession: async () => null,
    openSession: async (options, output) => {
      if (existsSync(enteredPath)) throw new Error("Interrupted root execution cannot be replayed");
      writeFileSync(enteredPath, JSON.stringify({ threadId: spec.id, enteredAt: Date.now() }) + "\n", { mode: 0o600 });
      entered = true;
      spec.onExecution?.();
      try { native = await factory({ ...spec, sessionFile: options.sessionFile, onExecution: undefined }); }
      catch (error) { factoryFailure = error; throw error; }
      let busy = false, task: Promise<void> | undefined, lastAssistantMessage: Record<string, unknown> | null = null;
      const acceptedWorkIds: string[] = [], completedWorkIds: string[] = [];
      const unsubscribe = native.observe?.(event => { if (event.type !== "agent_settled") output(event); });
      const state = () => ({ isStreaming: busy, isCompacting: false, isBashRunning: false,
        acceptedWorkIds, completedWorkIds, landedWorkIds: acceptedWorkIds, lastAssistantMessage });
      return {
        command: async command => {
          const respond = (data: unknown = {}) => output({ type: "response", id: command.id, command: command.type, success: true, data });
          switch (command.type) {
            case "get_state": respond(state()); return;
            case "set_session_name": respond(); return;
            case "abort": await native!.abort?.(); await task; respond(); return;
            case "prompt": {
              if (busy || command.resume || typeof command.workId !== "string" || typeof command.message !== "string") {
                output({ type: "response", id: command.id, command: command.type, success: false, error: "Root accepts one fresh managed input only" }); return;
              }
              busy = true;
              const workId = command.workId;
              acceptedWorkIds.push(workId);
              respond();
              task = (async () => {
                let outcome: "complete" | "failed" = "complete";
                try {
                  await native!.prompt(command.message as string);
                  const reply = native!.reply();
                  if (typeof reply !== "string" || !reply.trim()) throw new RootReplyUnavailable();
                  lastAssistantMessage = { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" };
                } catch (error) {
                  outcome = "failed";
                  turnFailure = error;
                  lastAssistantMessage = { role: "assistant", content: [], stopReason: "error", errorMessage: `Root execution failed: ${String(error)}` };
                } finally {
                  busy = false;
                  completedWorkIds.push(workId);
                  output({ type: "agent_settled", workIds: [workId], outcome, lastAssistantMessage });
                }
              })();
              return;
            }
          }
          output({ type: "response", id: command.id, command: command.type, success: false, error: `Unsupported private root command ${command.type}` });
        },
        close: async () => { await native!.abort?.(); await task; unsubscribe?.(); await native!.dispose(); native = undefined; },
      };
    },
  });
  let unsubscribe: (() => void) | undefined;
  return {
    prompt: async text => {
      const prior = owner.get(spec.id);
      if (existsSync(enteredPath) || prior && owner.latestSettlement(spec.id)) throw new Error("Interrupted root execution cannot be replayed");
      let resolve!: () => void, reject!: (error: unknown) => void;
      const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      unsubscribe = owner.subscribe(event => {
        if (event.threadId !== spec.id) return;
        if ("event" in event && event.event.type === "thread_settled") {
          settled = true;
          event.event.outcome === "complete" ? resolve() : reject(turnFailure ?? new Error("Root managed execution failed"));
        }
        const thread = owner.get(spec.id);
        const waiting = thread?.metadata?.admissionWait as { retryAt?: number } | undefined;
        if (!entered && waiting) reject(new RootCapacityUnavailable(waiting.retryAt ?? Date.now() + 5_000));
        if (factoryFailure) reject(factoryFailure);
        const failure = thread?.metadata?.startupFailure as { error: string } | undefined;
        if (failure) reject(new Error(failure.error));
      });
      const spawned = await owner.spawn({ requestId: `root:${spec.id}`, id: spec.id, cwd: spec.config.cwd,
        title: "Private root judgment", message: text, settings: { model: `${spec.config.provider}/${spec.config.model}`,
          thinkingLevel: spec.config.thinkingLevel, speed: "standard" } });
      if (!spawned.ok) { unsubscribe(); throw new Error(spawned.error.message); }
      const started = await owner.start();
      if (!started.ok) { unsubscribe(); throw new Error(started.error.message); }
      try { await completion; } finally { unsubscribe(); }
    },
    reply: () => native?.reply(), subjects: () => native?.subjects?.() ?? [],
    dispose: async () => {
      unsubscribe?.();
      if (entered && !settled) {
        const stopped = await owner.control({ threadId: spec.id, action: "cancel" });
        if (!stopped.ok) throw new Error(stopped.error.message);
      }
      // Suspension waits for all in-flight owner operations, retaining any undispatched input.
      const detached = await owner.detach();
      if (!detached.ok) throw new Error(detached.error.message);
    },
  };
}
