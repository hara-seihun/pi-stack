import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import { openPiSession } from "../src/threads/pi-session.js";
import type { ThreadService } from "../src/threads/service.js";
import type { OpenPiSession, Result } from "../src/threads/contracts.js";

const native = vi.hoisted(() => ({ prepare: undefined as ((session: AgentSession) => void) | undefined }));
vi.mock("@earendil-works/pi-coding-agent", async original => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...sdk, createAgentSessionFromServices: async (...args: Parameters<typeof sdk.createAgentSessionFromServices>) => {
    const result = await sdk.createAgentSessionFromServices(...args); native.prepare?.(result.session); return result;
  } };
});
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
async function until(check: () => boolean) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Native lane did not reach boundary");
}

it("real Pi settlement and disposal admit a second bounded lane cycle and preserve cold continuation history/receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-native-"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  store.reconcileLanes([{ id: "lane", prompt: "work", cwd: root, profile: "sol", admission: "force", weight: 1, maxActive: 1 }]);
  const daemon: any = new Daemon(store, { ...loadConfig(join(root, "missing")), modelBrokerUrl: "http://127.0.0.1:2461" }, undefined, undefined, { capacity: { mode: "unmanaged" } });
  const service: ThreadService = daemon.threads;
  const serviceOptions = (service as any).options;
  let calls = 0, opens = 0, disposals = 0;
  const contexts: number[] = [];
  native.prepare = session => {
    session.agent.state.model = session.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    session.agent.streamFunction = (_model, context) => {
      calls++; contexts.push(context.messages.filter(m => m.role === "assistant").length);
      const model = session.agent.state.model;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [{ type: "text", text: `Native cycle ${calls}` }], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
    };
  };
  serviceOptions.admit = async () => ({ ok: true, value: { release() {} } });
  serviceOptions.environment = () => ({ PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" });
  const open: OpenPiSession = async (options, output, exit) => {
    opens++;
    // Transport identity is synthetic; native state, history, settlement and disposal are real Pi.
    const session = await openPiSession({ ...options, threads: undefined, args: [] }, output, exit);
    output({ type: "runner_attached", control: "fixture.control", socketPath: `${options.threadId}.sock` });
    return { command: session.command, close: async () => { await session.close(); disposals++; } };
  };
  serviceOptions.openSession = open;
  try {
    unwrap(await service.start());
    await daemon.fillCapacity(); await until(() => calls === 1 && disposals === 1 && service.laneCustody().size === 0);
    const first = service.snapshot()[0]!;
    expect(first).toMatchObject({ state: "idle", held: false, pendingMessages: 0 }); expect(first.metadata?.runnerReference).toBeUndefined();
    const firstReceipt = unwrap(service.settlements()).items[0]!;
    expect(firstReceipt.outcome).toBe("complete"); expect(readFileSync(first.sessionFile, "utf8")).toContain("Native cycle 1");
    await daemon.fillCapacity(); await until(() => calls === 2 && disposals === 2 && service.laneCustody().size === 0);
    expect(service.snapshot()).toHaveLength(2); expect(unwrap(service.settlements()).items).toHaveLength(2);
    unwrap(await service.send({ requestId: "cold-continuation", threadId: first.id, text: "Continue the original history" }));
    await until(() => calls === 3 && disposals === 3 && service.laneCustody().size === 0);
    expect(service.get(first.id)!.sessionFile).toBe(first.sessionFile);
    expect(readFileSync(first.sessionFile, "utf8")).toContain("Native cycle 1"); expect(readFileSync(first.sessionFile, "utf8")).toContain("Native cycle 3");
    expect(contexts).toEqual([0, 0, 1]); expect(opens).toBe(3);
    unwrap(await service.send({ requestId: "cold-continuation", threadId: first.id, text: "Continue the original history" }));
    service.reconcile(); await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(3); expect(unwrap(service.settlements()).items[0]).toEqual(firstReceipt);
  } finally {
    native.prepare = undefined; await service.close(); await daemon.schedules.close(); store.close(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
  }
}, 15000);
