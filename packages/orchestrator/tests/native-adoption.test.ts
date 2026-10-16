import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import type { PiCommand, PiEvent, Result } from "../src/threads/contracts.js";
const unwrap = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };

it("drains a retained predecessor without sending batch/resume, then replaces before pending delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-adoption-"));
  const oldCommands: string[] = [], currentCommands: string[] = [];
  let streaming = true, oldClosed = false;
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async (options, output: (event: PiEvent) => void) => ({
      async command(command) {
        expect(oldClosed).toBe(true); currentCommands.push(command.type);
        output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? {
          nativeProtocolVersion: "batch-operations-v1", isStreaming: false, backgroundOperationCount: 0,
          acceptedWorkIds: ["original"], landedWorkIds: ["original"], completedWorkIds: ["original"], sessionFile: options.sessionFile,
          lastAssistantMessage: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() },
        } : {} });
      }, async close() {},
    }),
  });
  try {
    const thread = unwrap(service.importThread({ id: "worker", cwd: root, title: "Adopt", settings: { model: "faux/faux", thinkingLevel: "off", speed: "standard" }, sessionFile: join(root, "native.jsonl"), metadata: { runnerReference: { control: "socket", socketPath: "/registered/socket" } } }));
    unwrap(service.importMessage({ id: "original", threadId: thread.id, text: "already accepted", state: "dispatched", executionId: "execution", insertedAt: Date.now() }));
    unwrap(service.importMessage({ id: "pending", threadId: thread.id, text: "new input", state: "queued" }));
    const runtime: any = { epoch: "old", executionId: "execution", busy: true, nativeProtocol: "draining", commandNumber: 0, waiters: new Map() };
    runtime.session = {
      async command(command: PiCommand) {
        oldCommands.push(command.type);
        const waiter = runtime.waiters.get(command.id);
        clearTimeout(waiter.timer); runtime.waiters.delete(command.id);
        waiter.resolve({ isStreaming: streaming, localTools: streaming ? 1 : 0,
          acceptedWorkIds: ["original"], landedWorkIds: ["original"], completedWorkIds: streaming ? [] : ["original"], sessionFile: thread.sessionFile });
      }, async close() { expect(streaming).toBe(false); oldClosed = true; },
    };
    (service as any).runtimes.set(thread.id, runtime);
    await (service as any).drain(thread.id);
    expect(oldClosed).toBe(false);
    expect(oldCommands).toEqual(["get_state"]);
    expect(service.pending(thread.id).map(input => input.id)).toContain("pending");
    streaming = false;
    await (service as any).drain(thread.id);
    expect(oldClosed).toBe(true);
    expect(oldCommands.every(type => type === "get_state")).toBe(true);
    expect(currentCommands).toContain("input_batch");
    expect(service.inputStates(thread.id).find(input => input.id === "original")?.state).toBe("done");
  } finally { await service.detach(); rmSync(root, { recursive: true, force: true }); }
});
