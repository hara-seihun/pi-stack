import { afterEach, expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiInputBatch } from "../src/threads/pi-input-batch.js";
import { PiExecution } from "../src/threads/pi-execution.js";
import { inputReceipts } from "../src/threads/pi-input-receipts.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(manager?: SessionManager) {
  const root = mkdtempSync(join(tmpdir(), "pi-inbox-")); roots.push(root);
  if (!manager) { const file = join(root, "session.jsonl"); seedPiSession(file, root); manager = SessionManager.open(file); }
  const agent = new Agent({ streamFn: () => { throw new Error("Fixture has no provider"); } });
  const listeners: ((event: any) => unknown)[] = [];
  agent.subscribe = listener => { listeners.push(listener as any); return () => {}; };
  const publicListeners: ((event: any) => unknown)[] = [];
  const queue: any[] = [], output: any[] = [];
  let streaming = false;
  const session = { agent, sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
    get isStreaming() { return streaming; }, get isIdle() { return !streaming; }, get messages() { return agent.state.messages; },
    subscribe: (listener: any) => { publicListeners.push(listener); return () => {}; },
    sendCustomMessage: async (message: any) => { queue.push({ ...message, role: "custom", timestamp: Date.now() }); streaming = true; },
  } as unknown as AgentSession;
  listeners.push(event => { if (event.type === "message_end") {
    if (event.message.role === "custom") manager!.appendCustomMessageEntry(event.message.customType, event.message.content, true, event.message.details);
    else manager!.appendMessage(event.message);
  } });
  const execution = new PiExecution(); execution.bind(session);
  const inbox = new PiInputBatch(session, execution, event => output.push(event), () => {});
  const emit = async (event: any) => { for (const listener of listeners) await listener(event); };
  const assistant = { role: "assistant", content: [{ type: "text", text: "complete output" }], timestamp: Date.now() };
  return { inbox, execution, session, queue, output, emit, assistant, manager };
}

it("retains every streaming arrival until output finalization, then queues one ordered batch", async () => {
  const f = fixture();
  f.inbox.accept([{ workId: "initial", message: "start" }]); await Promise.resolve();
  await f.emit({ type: "message_end", message: f.queue.shift() });
  await f.emit({ type: "message_start", message: f.assistant });
  f.inbox.accept([{ workId: "human", message: "user input", inputOrigin: "human" }, { workId: "agent", message: "agent input", inputOrigin: "machine" }]);
  await Promise.resolve();
  expect(f.queue).toEqual([]);
  await f.emit({ type: "message_end", message: f.assistant });
  expect(f.queue).toHaveLength(1);
  expect(f.queue[0].details.workIds).toEqual(["human", "agent"]);
  expect(f.manager!.getEntries().filter(entry => entry.type === "custom" && entry.customType === "thread_input_batch_accepted")).toHaveLength(2);
  await f.emit({ type: "message_end", message: f.queue.shift() });
  expect(inputReceipts(f.manager!.getBranch()).landedWorkIds).toEqual(["initial", "human", "agent"]);
});

it("lands input arriving during request preparation in that request, not a later turn", async () => {
  const f = fixture();
  f.inbox.accept([{ workId: "initial", message: "start" }]); await Promise.resolve();
  await f.emit({ type: "message_end", message: f.queue.shift() });
  await f.emit({ type: "turn_start" });
  f.inbox.accept([{ workId: "late", message: "arrived during preparation" }]);
  const update = await f.session.agent.prepareRequest!({ context: { messages: [], tools: [] }, model: {} as any, thinkingLevel: "off" }, undefined);
  expect(update?.context?.messages.at(-1)).toMatchObject({ role: "custom", details: { workIds: ["late"] } });
  expect(f.queue).toEqual([]);
  expect(inputReceipts(f.manager!.getBranch()).landedWorkIds).toContain("late");
});

it("identity conflict rejects the entire new batch without partially accepting other IDs", () => {
  const f = fixture();
  f.inbox.accept([{ workId: "existing", message: "original" }]);
  expect(f.inbox.accept([{ workId: "new", message: "new bytes" }, { workId: "existing", message: "changed" }])).toMatchObject({ ok: false });
  expect(inputReceipts(f.manager!.getBranch()).acceptedWorkIds).toEqual(["existing"]);
  f.inbox.close();
});

it("v2 landing receipts require the following committed user content, including transformed prompts", () => {
  const accepted = { type: "custom", customType: "thread_input", data: { workId: "old", message: "/template", receiptVersion: 2 } };
  const claimed = { type: "custom", customType: "thread_landed", data: { workId: "old" } };
  expect(inputReceipts([accepted, claimed]).landedWorkIds).toEqual([]);
  expect(inputReceipts([accepted, claimed, { type: "message", message: { role: "user", content: "Expanded template content" } }]).landedWorkIds).toEqual(["old"]);
});

it("a batch command ID cannot be reused to admit different inputs", () => {
  const f = fixture();
  expect(f.inbox.accept([{ workId: "first", message: "original" }], { commandId: "command", batchId: "batch" })).toEqual({ ok: true });
  expect(f.inbox.accept([{ workId: "first", message: "original" }, { workId: "new", message: "new" }], { commandId: "command", batchId: "batch" })).toMatchObject({ ok: false });
  expect(inputReceipts(f.manager!.getBranch()).acceptedWorkIds).toEqual(["first"]);
  f.inbox.close();
});

it("reconciles landed IDs from committed custom content, not a separate landing receipt", () => {
  const f = fixture(); f.inbox.accept([{ workId: "landed", message: "original" }]); f.inbox.close();
  f.manager!.appendCustomMessageEntry("thread_input_batch", "original", true, { batchId: "cutoff", workIds: ["landed"] });
  const recovered = fixture(SessionManager.open(f.session.sessionFile!));
  expect(recovered.inbox.awaitingAdmission).toBe(false);
  recovered.inbox.close();
});
