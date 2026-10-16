import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { managerShellBudget, ManagerShellError, MANAGER_SHELL_MAX_SECONDS, MANAGER_SHELL_RULE, runManagerShell } from "./manager-shell-budget.js";

type Work = "tool" | "prompt";

export class PiExecution {
  private readonly runs = new AsyncLocalStorage<AbortSignal>();
  private readonly pending = new Map<Promise<unknown>, Work>();
  private controller = new AbortController();
  private halting?: Promise<void>;

  constructor(private readonly onIdle: () => void = () => {}, private readonly manager = false) {}

  get blocked() { return this.controller.signal.aborted; }
  get activeTools() { return [...this.pending.values()].filter(kind => kind === "tool").length; }
  get active() { return this.pending.size > 0; }

  private track<T>(kind: Work, operation: () => Promise<T>): Promise<T> {
    const pending = this.run(() => Promise.resolve().then(() => {
      this.assertCurrent();
      return operation();
    }));
    this.pending.set(pending, kind);
    const release = () => {
      this.pending.delete(pending);
      // Settlement is outside the promise it observes, including rejection receipts.
      if (!this.active) queueMicrotask(this.onIdle);
    };
    void pending.then(release, release);
    return pending;
  }

  bind(session: AgentSession): void {
    if (this.manager) {
      const beforeToolCall = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => {
        const budget = managerShellBudget(context.toolCall.name, context.toolCall.arguments);
        if (!budget.ok) return { block: true, reason: budget.error.message };
        return beforeToolCall?.(context, signal);
      };
    }
    const state = session.agent.state;
    const descriptor = Object.getOwnPropertyDescriptor(state, "tools")!;
    const wrapped = new WeakMap<object, typeof state.tools[number]>();
    const wrap = (tool: typeof state.tools[number]): typeof tool => {
      const existing = wrapped.get(tool);
      if (existing) return existing;
      const next = { ...tool,
        ...(this.manager && tool.name === "bash" ? {
          description: `${tool.description} ${MANAGER_SHELL_RULE}`,
          parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
            timeout: Type.Number({ exclusiveMinimum: 0, maximum: MANAGER_SHELL_MAX_SECONDS, description: "Explicit manager shell deadline in seconds" }) },
          required: [...new Set([...(tool.parameters.required ?? []), "timeout"])] } as typeof tool.parameters,
        } : {}),
        execute: (...args: Parameters<typeof tool.execute>) => {
          const signal = args[2];
          args[2] = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
          return this.track("tool", () => {
            args[2]!.throwIfAborted();
            if (!this.manager) return tool.execute(...args);
            const budget = managerShellBudget(tool.name, args[1]);
            if (!budget.ok) throw new ManagerShellError(budget.error.code, budget.error.message);
            if (budget.timeout === null) return tool.execute(...args);
            return runManagerShell(budget.timeout, args[2], stopped => {
              args[2] = stopped;
              return this.track("tool", () => tool.execute(...args));
            });
          });
        } };
      wrapped.set(tool, next);
      wrapped.set(next, next);
      return next;
    };
    Object.defineProperty(state, "tools", { ...descriptor,
      get: () => descriptor.get!.call(state),
      set: tools => descriptor.set!.call(state, tools.map(wrap)),
    });
    state.tools = state.tools;
    const methods = <T extends object>(owner: T, names: (keyof T)[], kind: Work) => {
      for (const name of names) {
        const original = (owner[name] as (...args: unknown[]) => Promise<unknown>).bind(owner);
        Object.defineProperty(owner, name, { configurable: true, writable: true,
          value: (...args: unknown[]) => this.track(kind, () => original(...args)) });
      }
    };
    methods(session.agent, ["prompt", "continue"], "prompt");
    methods(session, ["prompt", "steer", "followUp", "sendCustomMessage", "sendUserMessage"], "prompt");
    methods(session, ["executeBash", "compact", "navigateTree"], "tool");
  }

  run<T>(operation: () => T): T {
    this.assertCurrent();
    return this.runs.run(this.controller.signal, operation);
  }

  private assertCurrent(): void {
    if (this.blocked || this.runs.getStore()?.aborted) throw new Error("Pi execution has been cancelled");
  }

  halt(session: AgentSession, timeoutMs: number, settled: () => void = () => {}): Promise<void> {
    if (this.runs.getStore() && this.active) return Promise.reject(new Error("Cannot halt Pi execution from its own callback"));
    if (this.halting) return this.halting;
    this.controller.abort();
    const stopped = Promise.resolve().then(async () => {
      session.clearQueue();
      session.abortBash();
      await session.abort();
      while (this.active) await Promise.allSettled(this.pending.keys());
      await session.agent.waitForIdle();
      if (!session.isIdle || session.isBashRunning) throw new Error("Local Pi execution is still active");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.halting = Promise.race([stopped, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Cancellation failed: local Pi execution did not stop within ${timeoutMs}ms`)), timeoutMs);
    })]).then(() => {
      session.clearQueue();
      settled();
      this.controller = new AbortController();
    }).finally(() => { clearTimeout(timer); this.halting = undefined; });
    return this.halting;
  }

  dispose(): void { this.controller.abort(); }
}
