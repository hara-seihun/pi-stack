import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ImageContent } from "@earendil-works/pi-ai";
import { PiExecution, type OperationCompletion } from "../src/threads/pi-execution.js";
import { PiInputBatch, parseNativeInputs } from "../src/threads/pi-input-batch.js";
import { installMessageDelivery } from "../src/threads/message-delivery.js";
import { inputReceipts } from "../src/threads/pi-input-receipts.js";
import { seedPiSession, checkpointPiSession } from "../src/threads/pi-session-file.js";
import { ThreadService } from "../src/threads/service.js";
import { operationCompletionInput } from "../src/threads/operation-completion.js";
import type { PiEvent } from "../src/threads/contracts.js";

function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const image: ImageContent = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZsAAAAASUVORK5CYII=" };

it.each([true, false])("delayed completion survives Core and native restart into actual SDK model input (image=%s)", async withImage => {
  const root = mkdtempSync(join(tmpdir(), "deferred-image-")), file = join(root, "native.jsonl");
  seedPiSession(file, root);
  const services = await createAgentSessionServices({ cwd: root, agentDir: join(root, "agent"), resourceLoaderOptions: {
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  } });
  const started = gate(), finish = gate(), terminal = gate<OperationCompletion>();
  const result = { content: [{ type: "text" as const, text: withImage ? "Read image file [image/png]" : "plain result" }, ...(withImage ? [image, { ...image }] : [])], details: { fixture: true } };
  const raw = vi.fn(async () => { started.resolve(); await finish.promise; return result; });
  const tool = { name: "synthetic-read", label: "Read", description: "Synthetic delayed result", parameters: { type: "object", properties: {} }, execute: raw };
  let session: AgentSession | undefined, inbox: PiInputBatch | undefined, core: ThreadService | undefined;
  let emit!: (event: PiEvent) => void;
  const coreOptions = { capacity: { mode: "unmanaged" as const }, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async (_options: unknown, output: (event: PiEvent) => void) => {
      emit = output;
      return { command: async (command: any) => output({ type: "response", command: command.type, id: command.id, success: true,
        data: command.type === "get_state" ? { isStreaming: false, pendingMessageCount: 0, backgroundOperationCount: 0, nativeProtocolVersion: "batch-operations-v1", sessionFile: file } : {} }), close: async () => {} };
    } };
  try {
    core = new ThreadService(coreOptions);
    expect(core.importThread({ id: "fixture-thread", cwd: root, title: "Fixture", sessionFile: file,
      settings: { model: "fixture/model", thinkingLevel: "off", speed: "standard" } }).ok).toBe(true);
    expect(await core.command("fixture-thread", { type: "get_context" })).toMatchObject({ ok: true });
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.open(file), tools: [], customTools: [tool] }));
    session.agent.state.tools = [tool];
    const execution = new PiExecution(() => {}, event => { emit(JSON.parse(JSON.stringify(event))); terminal.resolve(event); });
    execution.bind(session);
    const wrapped = session.agent.state.tools.find(value => value.name === tool.name)!;
    const observed = wrapped.execute("original-call", {}, undefined);
    await started.promise; execution.releaseObservations();
    expect((await observed).details).toMatchObject({ state: "running" });
    finish.resolve(); const event = await terminal.promise;
    expect(event.workId).toBe(`operation:${event.operationId}:terminal`);
    const originalReceipt = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)).findLast(entry => entry.customType === "tool_operation");
    expect(originalReceipt.data.outcome.result).toEqual(result);
    emit(JSON.parse(JSON.stringify(event))); emit(JSON.parse(JSON.stringify(event)));
    const pending = core.pending("fixture-thread");
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe(event.message);
    expect(pending[0].images).toEqual(withImage ? result.content.filter(part => part.type === "image") : []);
    await core.close(); core = new ThreadService(coreOptions);
    expect(core.pending("fixture-thread")).toEqual(pending);
    await session.dispose(); session = undefined;
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.open(file), tools: [], customTools: [tool] }));
    session.agent.state.tools = [tool];
    const recoveredEvents: OperationCompletion[] = [];
    const recovered = new PiExecution(() => {}, value => recoveredEvents.push(value)); recovered.bind(session); recovered.flushCompletions();
    expect(recoveredEvents).toEqual([event]);
    await session.agent.state.tools.find(value => value.name === tool.name)!.execute("original-call", {}, undefined);
    expect(raw).toHaveBeenCalledTimes(1);
    const input = parseNativeInputs(pending.map(work => ({ workId: work.id, message: work.text, images: work.images, inputOrigin: "machine" })));
    expect(input.ok).toBe(true); if (!input.ok) throw new Error(input.error);
    inbox = new PiInputBatch(session, recovered, () => {}, () => {});
    expect(inbox.accept(input.value, { commandId: "original-completion-batch", batchId: "original-batch" })).toEqual({ ok: true });
    inbox.close(); inbox = undefined;
    checkpointPiSession(session.sessionManager);
    expect(inputReceipts(session.sessionManager.getBranch()).landedWorkIds).toEqual([]);
    await session.dispose(); session = undefined;
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.open(file), tools: [] }));
    const finalExecution = new PiExecution(); finalExecution.bind(session);
    const model = session.modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
    session.agent.state.model = model; vi.spyOn(session.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    session.agent.getApiKey = () => "synthetic-no-provider";
    installMessageDelivery(session, { PI_MODEL_DELIVERY_TIMEZONE: "null" });
    const requests: any[][] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(context.messages);
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "synthetic done" }], stopReason: "stop", api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
    };
    const settled = gate();
    session.subscribe(value => { if (value.type === "agent_settled") settled.resolve(); });
    inbox = new PiInputBatch(session, finalExecution, () => {}, () => {});
    expect(inbox.accept(input.value, { commandId: "original-completion-batch", batchId: "original-batch" })).toEqual({ ok: true });
    inbox.reconcileIdleAdmission();
    await settled.promise; await session.agent.waitForIdle();
    expect(session.messages.findLast(message => message.role === "assistant")).toMatchObject({ stopReason: "stop" });
    expect(requests).toHaveLength(1);
    const delivered = requests[0].filter(message => message.role === "user").at(-1);
    expect(delivered.content.filter((part: any) => part.type === "image")).toEqual(withImage ? result.content.filter(part => part.type === "image") : []);
    const text = delivered.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    expect(JSON.parse(delivered.content.find((part: any) => part.type === "text" && part.text.startsWith("{\"workId\"")).text)).toEqual({ workId: event.workId, inputOrigin: "machine", message: event.message });
    expect(text).toContain("[Model delivery:"); expect(text).not.toContain(image.data);
    checkpointPiSession(session.sessionManager);
    expect(inputReceipts(session.sessionManager.getBranch()).landedWorkIds).toEqual([event.workId]);
    expect(session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "thread_input_batch_accepted")).toHaveLength(1);
    const receiptAfter = session.sessionManager.getEntries().find(entry => entry.id === originalReceipt.id);
    expect(receiptAfter).toEqual(originalReceipt);
  } finally { finish.resolve(); inbox?.close(); await core?.close(); await session?.dispose(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
}, 3000);

it("invalid image receipts produce a typed error instead of a text-only success", () => {
  for (const content of [[{ type: "image", mimeType: "image/png", data: 7 }], [{ type: "unknown" }], null]) {
    expect(operationCompletionInput({ type: "tool_operation_result", workId: "operation:x:terminal", message: "done", outcome: { kind: "complete", result: { content } } })).toMatchObject({ ok: false });
  }
  expect(operationCompletionInput({ type: "tool_operation_result", workId: "operation:x:terminal", message: "cancelled", outcome: { kind: "cancelled", error: "stop" } })).toEqual({ ok: true, value: { workId: "operation:x:terminal", message: "cancelled", inputOrigin: "machine" } });
});
