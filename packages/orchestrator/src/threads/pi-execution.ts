import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export class PiExecution {
  private generation = 0;
  private readonly runs = new AsyncLocalStorage<number>();
  private readonly tools = new Set<Promise<unknown>>();
  private readonly prompts = new Set<Promise<unknown>>();
  private controller = new AbortController();
  private stopping = false;
  private closed = false;
  private cancellation?: Promise<void>;
  get blocked() { return this.stopping || this.closed; }
  get activeTools() { return this.tools.size; }
  get activePrompts() { return this.prompts.size; }
  async whenIdle(): Promise<void> {
    while (this.tools.size || this.prompts.size) await Promise.allSettled([...this.tools, ...this.prompts]);
  }

  bind(session: AgentSession): void {
    const state = session.agent.state;
    const descriptor = Object.getOwnPropertyDescriptor(state, "tools")!;
    const wrapped = new WeakMap<object, typeof state.tools[number]>();
    const wrap = (tool: typeof state.tools[number]): typeof tool => {
      const existing = wrapped.get(tool);
      if (existing) return existing;
      const next = { ...tool, execute: (...args: Parameters<typeof tool.execute>) => {
        this.assertCurrent();
        const signal = args[2];
        args[2] = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
        const pending = Promise.resolve().then(() => { this.assertCurrent(); args[2]?.throwIfAborted(); return tool.execute(...args); });
        this.tools.add(pending);
        void pending.finally(() => this.tools.delete(pending)).catch(() => {});
        return pending;
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
    for (const name of ["prompt", "continue"] as const) {
      const original = session.agent[name].bind(session.agent);
      Object.defineProperty(session.agent, name, { configurable: true, writable: true, value: new Proxy(original, { apply: (target, receiver, args) => {
        this.assertCurrent();
        return Reflect.apply(target, receiver, args);
      } }) });
    }
    for (const name of ["executeBash", "compact", "navigateTree"] as const) {
      const original = session[name].bind(session);
      Object.defineProperty(session, name, { configurable: true, writable: true, value: new Proxy(original, {
        apply: (target, receiver, args) => {
          this.assertCurrent();
          const pending = Promise.resolve(Reflect.apply(target, receiver, args));
          this.tools.add(pending);
          void pending.finally(() => this.tools.delete(pending)).catch(() => {});
          return pending;
        },
      }) });
    }
    const prompt = session.prompt.bind(session);
    session.prompt = (...args) => {
      const pending = this.run(() => prompt(...args));
      this.prompts.add(pending);
      void pending.finally(() => this.prompts.delete(pending)).catch(() => {});
      return pending;
    };
  }

  run<T>(operation: () => T): T {
    this.assertCurrent();
    return this.runs.run(this.generation, operation);
  }
  private assertCurrent(): void {
    const generation = this.runs.getStore();
    if (this.blocked || generation !== undefined && generation !== this.generation) throw new Error("Pi execution has been cancelled");
  }

  async cancel(session: AgentSession, timeoutMs: number): Promise<void> {
    if (this.cancellation) return this.cancellation;
    this.stopping = true;
    this.generation++;
    this.controller.abort();
    session.abortBash();
    const settling = (async () => {
      await session.abort();
      await this.whenIdle();
      if (this.tools.size || session.isStreaming || session.isCompacting || session.isBashRunning) throw new Error("Local Pi execution is still active");
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.cancellation = Promise.race([settling, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Cancellation failed: local Pi execution did not stop within ${timeoutMs}ms`)), timeoutMs);
    })]).then(() => {
      session.clearQueue();
      this.controller = new AbortController();
      this.stopping = false;
    }).finally(() => { clearTimeout(timer); this.cancellation = undefined; });
    return this.cancellation;
  }

  dispose(): void { this.closed = true; this.generation++; this.controller.abort(); }
}
