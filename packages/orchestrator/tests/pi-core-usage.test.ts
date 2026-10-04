import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { Store } from "../src/store.js";
import { Fleet } from "../src/fleet.js";
import { loadConfig } from "../src/config.js";
import type { Thread } from "../src/threads/contracts.js";
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

it("accounts fleet completions once while shared interactive sessions and provider operations keep logging", async () => {
  const key = Symbol.for("pi-stack.session-environment");
  const globals = globalThis as any, previous = globals[key];
  const scope = new AsyncLocalStorage<NodeJS.ProcessEnv>();
  globals[key] = scope;
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "openai-codex-1", provider: "openai-codex", concurrency: 2 });
  const open = vi.spyOn(Store, "open").mockReturnValue(store);
  const config = loadConfig("/missing"), fleet = new Fleet(store, config);
  const thread: Thread = { id: "fleet-thread", parentId: null, title: "work", cwd: "/tmp", sessionFile: "/tmp/fleet.jsonl",
    settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" }, admission: "force",
    state: "running", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1 };
  const register = () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    usageLogger({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
    return handlers;
  };
  const usage = { input: 3, output: 5, cacheRead: 7, cacheWrite: 11 } as Usage;
  const event = { type: "message_end", message: { role: "assistant", provider: "openai-codex-1", model: "gpt-6-astra", timestamp: 1, usage } };
  const context = (id: string) => ({ sessionManager: { getSessionId: () => id } });
  try {
    const admitted = await fleet.admit(thread, thread.settings, false, "fleet-execution");
    if (!admitted.ok) throw new Error(admitted.error.message);
    try {
      await Promise.all([
        scope.run(admitted.value.env, async () => {
          const handlers = register();
          await Promise.resolve();
          // Dispatch to both consumers, as the shared runner does. The extension must leave this receipt to Fleet.
          await handlers.get("message_end")?.(event, context("native-fleet"));
          fleet.event(thread.id, event); fleet.event(thread.id, event);
          recordModelUsage(store, "openai-codex-1", "compaction", { input: 13, output: 0, cacheRead: 0, cacheWrite: 0 } as Usage, "native-operation");
        }),
        scope.run({}, async () => {
          const handlers = register();
          await Promise.resolve();
          await handlers.get("message_end")!({ message: { ...event.message, model: "interactive" } }, context("native-interactive"));
        }),
      ]);
      const rows = store.db.prepare("SELECT source, run_id AS runId, model, component, tokens FROM usage_hour").all() as
        { source: string; runId: string; model: string; component: string; tokens: number }[];
      const components = ["input", "output", "cacheRead", "cacheWrite"] as const;
      expect(rows.map(row => [row.source, row.runId, row.model, row.component, row.tokens])).toEqual(expect.arrayContaining([
        ...components.map(component => ["fleet", thread.id, "gpt-6-astra", component, usage[component]]),
        ...components.map(component => ["interactive", "native-interactive", "interactive", component, usage[component]]),
        ["fleet", "native-operation", "compaction", "input", 13],
      ]));
      expect(rows).toHaveLength(9);
    } finally { await admitted.value.release(); }

    const broker = new Fleet(store, { ...config, modelBrokerUrl: "http://127.0.0.1:2461" });
    const brokerAdmission = await broker.admit(thread, thread.settings, false, "broker-execution");
    if (!brokerAdmission.ok) throw new Error(brokerAdmission.error.message);
    try {
      scope.run(brokerAdmission.value.env, () => expect(register().has("message_end")).toBe(false));
      broker.event(thread.id, event);
      expect(store.usageSince(0)).toHaveLength(9);
    } finally { await brokerAdmission.value.release(); }
  } finally { open.mockRestore(); store.close(); globals[key] = previous; }
});
