import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { PiInputBatch } from "../src/threads/pi-input-batch.js";
import { PiExecution } from "../src/threads/pi-execution.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
import { inputReceipts } from "../src/threads/pi-input-receipts.js";
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("actual native terminal idle recovers lost steering with the same accepted bytes and no repeated tool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "idle-input-"));
  const file = join(directory, "native.jsonl"); seedPiSession(file, directory);
  const services = await createAgentSessionServices({ cwd: directory, agentDir: join(directory, "agent"), resourceLoaderOptions: {
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  } });
  const tool = { name: "existing-effect", label: "Existing effect", description: "Must not run", parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "effect" }], details: {} })) };
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.open(file), tools: [], customTools: [tool] });
  let inbox: PiInputBatch | undefined;
  try {
    const model = session.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
    session.agent.state.model = model;
    vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const first = createAssistantMessageEventStream(), started = gate(), recovered = gate();
    const requests: string[] = [];
    const message = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
      role: "assistant", content: [], stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    session.agent.streamFunction = (_model, context) => {
      requests.push(JSON.stringify(context.messages));
      if (requests.length === 1) { started.resolve(); return first; }
      const next = createAssistantMessageEventStream(), result = message("stop");
      next.push({ type: "done", reason: "stop", message: result }); next.end(result); return next;
    };
    const execution = new PiExecution(() => inbox?.reconcileIdleAdmission()); execution.bind(session);
    inbox = new PiInputBatch(session, execution, () => {}, () => {});
    const input = { workId: "operation:existing:terminal", message: "Existing operation finished. Inspect its receipt; never rerun it.", inputOrigin: "machine" as const };
    session.subscribe(event => {
      if (event.type === "agent_settled" && inputReceipts(session.sessionManager.getBranch()).landedWorkIds.includes(input.workId)) recovered.resolve();
    });
    inbox.accept([{ workId: "root", message: "initial" }], { commandId: "initial-command", batchId: "initial-batch" });
    await started.promise;
    const steer = vi.spyOn(session.agent, "steer").mockImplementationOnce(() => {});
    inbox.accept([input], { commandId: "original-terminal-command", batchId: "original-terminal-batch" });
    const native = session as unknown as { _handlePostAgentRun(): Promise<boolean>; _runBeforeSettleBoundary(): Promise<boolean> };
    vi.spyOn(native, "_handlePostAgentRun").mockResolvedValueOnce(false);
    vi.spyOn(native, "_runBeforeSettleBoundary").mockResolvedValueOnce(false);
    const failed = message("error"); failed.errorMessage = "terminal boundary loses queued steering";
    first.push({ type: "error", reason: "error", error: failed }); first.end(failed);
    await recovered.promise;
    await session.agent.waitForIdle(); await Promise.resolve(); await Promise.resolve();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain(input.message);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(session.isIdle).toBe(true);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(execution.active).toBe(false);
    expect(inbox.awaitingAdmission).toBe(false);
    const receipts = inputReceipts(session.sessionManager.getBranch());
    expect(receipts.acceptedWorkIds).toEqual(["root", input.workId]);
    expect(receipts.landedWorkIds).toEqual(["root", input.workId]);
    const accepted = session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "thread_input_batch_accepted");
    expect(accepted).toHaveLength(2);
    expect(accepted[1]).toMatchObject({ data: { inputs: [input], command: { id: "original-terminal-command" } } });
  } finally { inbox?.close(); await session.dispose(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); }
}, 3000);
