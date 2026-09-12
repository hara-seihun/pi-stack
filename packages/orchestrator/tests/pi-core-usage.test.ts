import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { Store } from "../src/store.js";
import usageLogger, { recordModelUsage } from "../src/extension/usage-logger.js";

it("leaves ordinary messages to the worker but retains provider operations and meter headers", async () => {
  const key = Symbol.for("pi-stack.session-environment");
  const globals = globalThis as any, previous = globals[key];
  const scope = new AsyncLocalStorage<NodeJS.ProcessEnv>();
  globals[key] = scope;
  const rows: any[] = [], meters: any[] = [];
  const store = { account: () => ({ id: "anthropic-2" }), recordUsage: (entry: unknown) => rows.push(entry),
    recordMeter: (...values: unknown[]) => meters.push(values), close() {} } as unknown as Store;
  const open = vi.spyOn(Store, "open").mockReturnValue(store);
  const usage = { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } as Usage;
  const context = { model: { provider: "anthropic-2" }, sessionManager: { getSessionId: () => "native-child" } };
  const register = () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    usageLogger({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
    return handlers;
  };
  try {
    await scope.run({ PI_ORCHESTRATOR_CORE_USAGE: "worker", PI_ORCHESTRATOR_RUN_ID: "root-run" }, async () => {
      const handlers = register();
      expect(handlers.has("message_end")).toBe(false);
      recordModelUsage(store, "anthropic-2", "fixture", usage, "native-child");
      expect(rows).toMatchObject([{ source: "fleet", runId: "root-run", tokens: 7 }]);
      await handlers.get("after_provider_response")!({ headers: { "anthropic-ratelimit-unified-5h-utilization": "0.25" } }, context);
      expect(meters[0].slice(0, 3)).toEqual(["anthropic-2", "anthropic-5h", 25]);
      await handlers.get("session_shutdown")!();
    });
    await scope.run({}, async () => {
      const handlers = register();
      await handlers.get("message_end")!({ message: { role: "assistant", provider: "anthropic-2", model: "fixture", usage } }, context);
      expect(rows[1]).toMatchObject({ source: "interactive", runId: "native-child", tokens: 7 });
      await handlers.get("session_shutdown")!();
    });
  } finally { open.mockRestore(); globals[key] = previous; }
});
